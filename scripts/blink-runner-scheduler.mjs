import { randomUUID } from 'node:crypto';

import { summarizeTaskMetrics } from './blink-optimization.mjs';

const terminalActions = new Set([
  'batch_handoff',
  'campaign_complete',
  'queue_stopped',
  'cooldown_wait',
]);
const successes = new Set(['submitted', 'awaiting_approval', 'published']);

// One owner, bounded leases, and one receipt channel per task. A worker error
// cancels browser waits and drains cleanup before the controller can terminate.
export async function runConcurrentCampaign(io, processTask, options = {}) {
  const maximum = Math.max(1, Math.min(3, Number(options.concurrency) || 3));
  let limit = maximum,
    streak = 0,
    claimedCount = 0,
    cursor = 0;
  let summary = null,
    summaryAt = 0,
    fatal = null;
  let deliveryFlush = null;
  const active = new Map(),
    blocked = [],
    measurements = [];
  const requested = options.queueIds || [];
  const approvedResumes = [...new Set(options.resumeRunIds || [])];
  const localAtRead = new Map();
  const now = options.now || Date.now;
  const refresh = async (force = false) => {
    if (force || !summary || now() - summaryAt >= 10_000) {
      summary = await io.cli(['queue']);
      io.performanceReporting =
        summary.capabilities?.performanceMetrics === true;
      summaryAt = now();
      localAtRead.clear();
      for (const entry of active.values())
        localAtRead.set(
          entry.queueId,
          (localAtRead.get(entry.queueId) || 0) + 1
        );
    }
    return (summary.queues || []).filter(
      (queue) =>
        queue.mode !== 'assisted' &&
        (!requested.length || requested.includes(queue.id))
    );
  };
  const finish = async (queues, settlements) => {
    await deliveryFlush;
    const pendingLogCount = (await io.flushDeliveries?.(true)) || 0;
    const legacyQueues = (summary.queues || []).filter(
      (queue) =>
        queue.mode === 'assisted' &&
        ['queued', 'running'].includes(queue.status) &&
        (!requested.length || requested.includes(queue.id))
    );
    const skillUpdate =
      summary.skillUpdate ||
      queues.find((queue) => queue.skillUpdate)?.skillUpdate;
    return io.emit({
      type: 'campaign_finished',
      claimedCount,
      blocked,
      queues,
      legacyQueues,
      settlements,
      performance: summarizeTaskMetrics(measurements),
      concurrency: { maximum, current: limit },
      campaignComplete:
        legacyQueues.length === 0 &&
        (!settlements.length ||
          settlements.every((item) => item.campaignComplete === true)),
      terminalReason: legacyQueues.length
        ? 'legacy_configuration_required'
        : settlements.some((item) => item.nextAction === 'batch_handoff')
          ? 'batch_handoff'
          : settlements.some((item) => item.nextAction === 'cooldown_wait')
            ? 'cooldown_wait'
            : 'campaign_complete',
      nextAvailableAt:
        settlements
          .map((item) => item.nextAvailableAt)
          .filter(Boolean)
          .sort()[0] || null,
      pendingLogCount,
      logDeliveryComplete: pendingLogCount === 0,
      ...(skillUpdate
        ? { skillUpdate, userReminder: skillUpdate.message }
        : {}),
    });
  };
  const releaseUnstarted = async (tasks) => {
    await Promise.allSettled(
      tasks.map(async (task) => {
        const released = await io.cli(
          [
            'release',
            '--run-id',
            task.runId,
            '--lease-id',
            task.lease.leaseId,
            '--event-id',
            randomUUID(),
            '--occurred-at',
            new Date().toISOString(),
          ],
          { cleanup: true }
        );
        await io.emit({
          type: 'worker_lease_released',
          runId: task.runId,
          release: released,
        });
      })
    );
  };
  const launch = (task) => {
    claimedCount += 1;
    const entry = { queueId: task.queueId };
    entry.promise = processTask(task, blocked)
      .then((outcome) => {
        if (outcome?.performance)
          measurements.push({
            status: outcome.status,
            metrics: outcome.performance,
          });
        if (outcome?.blockerCode === 'browser_failure') {
          limit = Math.max(1, Math.floor(limit / 2));
          streak = 0;
        } else if (successes.has(outcome?.status) && ++streak >= 3) {
          limit = Math.min(maximum, limit + 1);
          streak = 0;
        }
      })
      .catch((error) => {
        fatal ||= error;
        io.cancelPending?.(fatal);
      })
      .finally(() => active.delete(task.runId));
    active.set(task.runId, entry);
  };
  try {
    while (true) {
      if (fatal) throw fatal;
      await io.checkControl?.();
      if (io.flushDeliveries && !deliveryFlush) {
        deliveryFlush = Promise.resolve()
          .then(() => io.flushDeliveries())
          .catch(() => {})
          .finally(() => {
            deliveryFlush = null;
          });
      }
      const queues = await refresh();
      while (approvedResumes.length && active.size < limit) {
        const runId = approvedResumes.shift();
        const task = await io.cli(['resume', '--run-id', runId]);
        if (!task?.runId || !task?.lease?.leaseId || task.executable === false)
          throw new Error(
            'The approved resume was not confirmed. Reconcile its lease before retrying.'
          );
        if (requested.length && !requested.includes(task.queueId)) {
          await releaseUnstarted([task]);
          throw new Error(
            'The approved resume is outside the selected queue scope.'
          );
        }
        launch(task);
      }
      const candidates = queues.filter((queue) =>
        ['queued', 'running'].includes(queue.status)
      );
      const queueIds = [];
      const free = limit - active.size;
      for (let i = 0; i < candidates.length && queueIds.length < free; i++) {
        const queue = candidates[(cursor + i) % candidates.length];
        const localCount = [...active.values()].filter(
          (entry) => entry.queueId === queue.id
        ).length;
        const available = Math.max(
          0,
          (queue.availableConcurrency ?? queue.concurrency ?? 1) -
            localCount +
            (localAtRead.get(queue.id) || 0)
        );
        for (let n = 0; n < available && queueIds.length < free; n++)
          queueIds.push(queue.id);
      }
      cursor = (cursor + 1) % Math.max(1, candidates.length);
      let settlements = [],
        claims = [];
      if (queueIds.length) {
        if (summary.capabilities?.batchClaims) {
          const response = await io.cli(
            ['next-batch', '--queue-ids-json', JSON.stringify(queueIds)],
            { allowFailureResult: true }
          );
          if (!Array.isArray(response?.claims))
            throw new Error(
              'The batch claim response is unconfirmed. Reconcile its saved delivery before claiming again.'
            );
          claims = response.claims.filter(Boolean);
          settlements = response.settlements || [];
        } else {
          // Older servers remain usable, with a single lease per request.
          for (const queueId of queueIds) {
            const response = await io.cli(['next', '--queue-id', queueId], {
              allowFailureResult: true,
            });
            if (response?.runId) claims.push(response);
            else if (response?.claim === null && response.settlement)
              settlements.push({ queueId, ...response.settlement });
          }
        }
        const uncertain = claims.find(
          (task) => task.executable === false && task.leaseReleased !== true
        );
        if (uncertain) {
          await releaseUnstarted(
            claims.filter(
              (task) => task.executable !== false && task.lease?.leaseId
            )
          );
          throw new Error(
            'A rejected batch claim has an unconfirmed lease release. Reconcile it before continuing.'
          );
        }
        const ready = claims.filter(
          (task) =>
            task.executable !== false && task.runId && task.lease?.leaseId
        );
        const duplicate = ready.find(
          (task, index) =>
            active.has(task.runId) ||
            ready.findIndex((other) => other.runId === task.runId) !== index
        );
        if (duplicate) {
          await releaseUnstarted(
            ready.filter((task) => !active.has(task.runId))
          );
          throw new Error(
            'A batch repeated an owned task. Stop without replaying a browser action.'
          );
        }
        for (const task of ready) {
          launch(task);
        }
        await io.emit({
          type: 'worker_pool',
          activeWorkers: active.size,
          concurrency: limit,
          maximumConcurrency: maximum,
          claimedCount,
          continueRequired: true,
        });
        if (ready.length) continue;
      }
      if (active.size) {
        await Promise.race([...active.values()].map((entry) => entry.promise));
        continue;
      }
      if (
        settlements.length === queues.length &&
        settlements.every((item) => terminalActions.has(item.nextAction))
      )
        return finish(queues, settlements);
      if (!candidates.length) return finish(queues, settlements);
      // Cached slot hints may be stale. Before ending, read authoritative
      // settlements for every selected queue, including blocked reservations.
      settlements = [];
      await refresh(true);
      for (const queue of queues) {
        const result = await io.cli(['next', '--queue-id', queue.id], {
          allowFailureResult: true,
        });
        if (
          result?.runId &&
          result?.lease?.leaseId &&
          result.executable !== false
        ) {
          // Use the same worker path for a task found during reconciliation.
          claimedCount += 1;
          const outcome = await processTask(result, blocked);
          if (outcome?.performance)
            measurements.push({
              status: outcome.status,
              metrics: outcome.performance,
            });
          summaryAt = 0;
          break;
        }
        if (result?.executable === false && result.leaseReleased !== true)
          throw new Error('Claim release is unconfirmed.');
        if (result?.claim === null && result.settlement)
          settlements.push({ queueId: queue.id, ...result.settlement });
      }
      if (
        settlements.length === queues.length &&
        settlements.every((item) => terminalActions.has(item.nextAction))
      )
        return finish(queues, settlements);
      await io.emit({
        type: 'runner_waiting',
        signal: 'CONTINUE_REQUIRED',
        continueRequired: true,
        claimedCount,
        blocked,
        settlements,
        performance: summarizeTaskMetrics(measurements),
      });
      await io.wait(5_000);
      summaryAt = 0;
    }
  } catch (error) {
    io.cancelPending?.(error);
    await Promise.allSettled(
      [...active.values()].map((entry) => entry.promise)
    );
    await deliveryFlush;
    throw error;
  }
}
