import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const DEFAULT_CLIENT_TIMEOUT_MS = 15 * 60_000;

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const terminal = new Set([
  'campaign_finished',
  'runner_failed',
  'runner_stopped',
]);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  // Windows can briefly deny replacement while the other process reads state.
  // Keep the old complete JSON visible and retry only this atomic file rename.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 7) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      await delay(Math.min(200, 20 * 2 ** attempt));
    }
  }
}

async function checkStopped(stateDir) {
  if (await readJson(join(stateDir, 'stop.json'))) {
    const error = new Error(
      'The user stopped this controller. Preserve its receipt and retain every unfinished tab with an applied field, accepted upload, advanced form step, or ambiguous final action.'
    );
    error.code = 'RUNNER_STOPPED';
    throw error;
  }
}

export async function readRunnerStatus(stateDir, attempt = 0) {
  const state = await readJson(join(stateDir, 'state.json'));
  if (!state)
    return { type: 'runner_not_started', stateDir, continueRequired: false };
  if (terminal.has(state.event?.type))
    return {
      ...state,
      ...(state.event.type === 'campaign_finished'
        ? { lastReceipt: undefined, lastReceipts: undefined }
        : {}),
      stateDir,
    };
  const owner = await readJson(join(stateDir, 'owner.json'));
  if (!owner || Date.now() - Date.parse(owner.updatedAt) > 30_000) {
    return {
      type: 'runner_recovery_required',
      stateDir,
      continueRequired: false,
      message:
        'The controller is no longer responding. Preserve its receipt and reconcile the lease; retain every unfinished tab with an applied field, accepted upload, advanced form step, or ambiguous final action.',
      pendingRequest: state.pendingRequest,
      pendingRequests: state.pendingRequests,
      activeLeases: state.activeLeases,
      deliveries: state.deliveries,
      claimDelivery: state.claimDelivery,
      lastReceipts: state.lastReceipts,
      lastEvent: state.event,
      lastReceipt: state.lastReceipt,
      delivery: state.delivery,
      releaseDelivery: state.releaseDelivery,
      activeLease: state.activeLease,
      pendingLogCount: state.pendingLogCount,
    };
  }
  const requests =
    state.pendingRequests ||
    (state.pendingRequest ? [state.pendingRequest] : []);
  const delivered = await Promise.all(
    requests.map(async (request) =>
      /^[a-f0-9-]{36}$/i.test(request.requestId || '') &&
      (await readJson(join(stateDir, `receipt-${request.requestId}.json`)))
        ? request.requestId
        : null
    )
  );
  // A delivered receipt is being processed, not a request to repeat Submit.
  // Re-read if the owner advanced while these receipt files were inspected.
  const latest = await readJson(join(stateDir, 'state.json'));
  if (attempt < 2 && latest?.revision !== state.revision)
    return readRunnerStatus(stateDir, attempt + 1);
  const pendingRequests = requests.filter(
    (request) => !delivered.includes(request.requestId)
  );
  return {
    ...state,
    pendingRequests,
    pendingRequest: pendingRequests[0] || null,
    processingRequestIds: delivered.filter(Boolean),
    lastReceipt: undefined,
    lastReceipts: undefined,
    stateDir,
  };
}

// A detached process owns claims/heartbeats. The agent reconnects through small,
// atomic files instead of keeping a PTY stdin stream alive across tool calls.
export async function createFileTransport(
  io,
  stateDir,
  { clientTimeoutMs = DEFAULT_CLIENT_TIMEOUT_MS } = {}
) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  let cancelled = null;
  const checkClient = async (runId) => {
    if (cancelled) throw cancelled;
    await io.checkControl?.(runId);
    await checkStopped(stateDir);
    const client = await readJson(join(stateDir, 'client.json'));
    const lastContact = client ? Date.parse(client.updatedAt) : startedAt;
    if (
      !Number.isFinite(lastContact) ||
      Date.now() - lastContact > clientTimeoutMs
    ) {
      throw Object.assign(
        new Error(
          'The agent stopped contacting this controller. Release every owned lease and preserve progressed or confirmation-pending tabs.'
        ),
        { code: 'AGENT_DISCONNECTED' }
      );
    }
  };
  const outboxPath = join(stateDir, 'log-outbox.json');
  let outbox = (await readJson(outboxPath)) || [];
  let lastFlush = 0,
    flushPromise = null;
  let state = {
    type: 'runner_active',
    revision: 0,
    continueRequired: true,
    pendingRequest: null,
    pendingRequests: [],
    activeLeases: [],
    deliveries: {},
    event: { type: 'runner_starting' },
    pendingLogCount: outbox.length,
  };
  let writes = Promise.resolve();
  const save = () => {
    state.revision += 1;
    state.pendingRequest = state.pendingRequests[0] || null;
    state.activeLease = state.activeLeases[0] || null;
    const pending = Object.values(state.deliveries);
    state.delivery =
      pending.find((entry) => entry.args[0] !== 'release') || null;
    state.releaseDelivery =
      pending.find((entry) => entry.args[0] === 'release') || null;
    const snapshot = structuredClone(state);
    writes = writes.then(() =>
      atomicJson(join(stateDir, 'state.json'), snapshot)
    );
    return writes;
  };
  const touch = () =>
    atomicJson(join(stateDir, 'owner.json'), {
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    });
  let outboxWrites = Promise.resolve();
  const saveOutbox = () => {
    const snapshot = structuredClone(outbox);
    state.pendingLogCount = outbox.length;
    outboxWrites = outboxWrites.then(() => atomicJson(outboxPath, snapshot));
    return outboxWrites.then(save);
  };
  const hasPendingDelivery = (result) =>
    result?.deliveryPending === true ||
    result?.logPending === true ||
    result?.submissionSyncPending === true;
  const queueDelivery = async (args) => {
    const eventId = args.includes('--event-id')
      ? args[args.indexOf('--event-id') + 1]
      : null;
    if (!eventId)
      throw new Error('Pending delivery requires a stable event ID.');
    outbox = [
      ...outbox.filter((entry) => entry.eventId !== eventId),
      { eventId, args },
    ];
    await saveOutbox();
  };
  const flushDeliveries = async (force = false) => {
    if (flushPromise) {
      await flushPromise;
      if (!force) return outbox.length;
    }
    if (!outbox.length || (!force && Date.now() - lastFlush < 60_000))
      return outbox.length;
    const flush = async () => {
      await checkClient();
      lastFlush = Date.now();
      // Remove only acknowledged IDs. New concurrent entries must survive a flush.
      for (const entry of [...outbox]) {
        try {
          const result = await io.cli(entry.args);
          if (
            (result?.accepted === true ||
              result?.deferred === true ||
              result?.released === true) &&
            !hasPendingDelivery(result)
          )
            outbox = outbox.filter((item) => item.eventId !== entry.eventId);
        } catch {
          /* Replay only this event on the next flush. */
        }
      }
      await saveOutbox();
      return outbox.length;
    };
    flushPromise = flush();
    try {
      return await flushPromise;
    } finally {
      flushPromise = null;
    }
  };
  await touch();
  await save();
  let touching = false;
  const timer = setInterval(async () => {
    if (touching) return;
    touching = true;
    try {
      await touch();
    } catch {
      /* status will expose a stale controller */
    } finally {
      touching = false;
    }
  }, 5_000);
  timer.unref();
  const emit = async (event) => {
    if (event.type === 'heartbeat_failed') state.heartbeatError = event;
    else {
      state.event = event;
      state.continueRequired = !terminal.has(event.type);
    }
    if (event.type === 'task_settled') {
      state.pendingRequests = state.pendingRequests.filter(
        (request) => (request.runId || request.task?.runId) !== event.runId
      );
      state.activeLeases = state.activeLeases.filter(
        (lease) => lease.runId !== event.runId
      );
    }
    if (
      event.type === 'worker_lease_released' &&
      (event.release?.released === true || event.release?.accepted === true)
    ) {
      state.activeLeases = state.activeLeases.filter(
        (lease) => lease.runId !== event.runId
      );
      state.leaseReleased = state.activeLeases.length === 0;
    }
    if (terminal.has(event.type)) {
      state.type = event.type;
      if (event.type === 'campaign_finished') state.pendingRequests = [];
      clearInterval(timer);
    }
    await save();
    if (terminal.has(event.type))
      await rmdir(join(stateDir, 'lock')).catch(() => {});
    return event;
  };
  return {
    ...io,
    concurrentRequests: true,
    emit,
    queueDelivery,
    flushDeliveries,
    cancelPending: (error) => {
      cancelled = error;
    },
    cli: async (args, behavior) => {
      const cleanup = behavior?.cleanup === true && args[0] === 'release';
      const runId = args.includes('--run-id')
        ? args[args.indexOf('--run-id') + 1]
        : null;
      if (!cleanup)
        await checkClient(
          ['log', 'answers'].includes(args[0]) ? runId : undefined
        );
      const claiming = ['next', 'next-batch', 'resume'].includes(args[0]);
      if (claiming) {
        state.claimDelivery = { args };
        await save();
      }
      const delivery = ['result', 'defer', 'release', 'performance'].includes(
        args[0]
      );
      const deliveryKey = `${args[0]}:${runId}`;
      if (delivery) {
        state.deliveries[deliveryKey] = { args };
        await save().catch((error) => {
          if (!cleanup) throw error;
        });
      }
      const result = await io.cli(args, behavior);
      if (
        claiming &&
        (result === null ||
          result?.runId ||
          result?.claim === null ||
          Array.isArray(result?.claims))
      )
        state.claimDelivery = null;
      const claims =
        args[0] === 'next-batch'
          ? result?.claims || []
          : ['next', 'resume'].includes(args[0])
            ? [result]
            : [];
      const issued = claims.filter(
        (task) =>
          task?.runId &&
          (task?.lease?.leaseId || task?.leaseId) &&
          task.leaseReleased !== true
      );
      if (issued.length) {
        state.activeLeases.push(
          ...issued.map((task) => ({
            runId: task.runId,
            leaseId: task.lease?.leaseId || task.leaseId,
          }))
        );
        state.leaseReleased = false;
        try {
          await save();
        } catch (error) {
          await Promise.allSettled(
            issued.map((task) =>
              io.cli(
                [
                  'release',
                  '--run-id',
                  task.runId,
                  '--lease-id',
                  task.lease?.leaseId || task.leaseId,
                  '--event-id',
                  randomUUID(),
                  '--occurred-at',
                  new Date().toISOString(),
                ],
                { cleanup: true }
              )
            )
          );
          throw error;
        }
      }
      if (delivery) {
        if (
          (result?.accepted === true || result?.deferred === true) &&
          hasPendingDelivery(result)
        )
          await queueDelivery(args);
        delete state.deliveries[deliveryKey];
        await save();
      }
      return result;
    },
    request: async (request) => {
      const runId = request.runId || request.task?.runId;
      state.pendingRequests = [
        ...state.pendingRequests.filter(
          (item) => item.requestId !== request.requestId
        ),
        request,
      ];
      await emit(request);
      const receiptPath = join(stateDir, `receipt-${request.requestId}.json`);
      while (true) {
        await checkClient(runId);
        const receipt = await readJson(receiptPath);
        if (receipt) {
          state.lastReceipt = { request, receipt };
          state.lastReceipts = [
            ...(state.lastReceipts || []).filter(
              (entry) => entry.request.requestId !== request.requestId
            ),
            state.lastReceipt,
          ].slice(-20);
          state.pendingRequests = state.pendingRequests.filter(
            (item) => item.requestId !== request.requestId
          );
          await save();
          await unlink(receiptPath);
          return receipt;
        }
        await delay(200);
      }
    },
  };
}

export async function submitRunnerReceipt(stateDir, receipt) {
  const state = await readRunnerStatus(stateDir);
  const pending = (state.pendingRequests || [state.pendingRequest]).find(
    (request) => request?.requestId === receipt?.requestId
  );
  if (
    state.continueRequired !== true ||
    !pending ||
    receipt?.requestId !== pending.requestId ||
    !/^[a-f0-9-]{36}$/i.test(pending.requestId)
  ) {
    throw new Error(
      'Receipt must match the current live request. Read status; do not repeat the browser action.'
    );
  }
  const destination = join(stateDir, `receipt-${pending.requestId}.json`);
  // Write once, atomically. Duplicate responses cannot enter the next request.
  const guard = `${destination}.lock`;
  await mkdir(guard).catch((error) => {
    if (error.code === 'EEXIST')
      throw new Error('A receipt is already being delivered. Read status.');
    throw error;
  });
  try {
    if (await readJson(destination))
      throw new Error('A receipt is already pending. Read status.');
    await atomicJson(destination, receipt);
  } finally {
    await rmdir(guard);
  }
  return {
    type: 'receipt_delivered',
    requestId: receipt.requestId,
    continueRequired: true,
  };
}

export async function submitRunnerReceipts(stateDir, receipts) {
  if (
    !Array.isArray(receipts) ||
    receipts.length < 1 ||
    receipts.length > 50 ||
    new Set(receipts.map((receipt) => receipt?.requestId)).size !==
      receipts.length
  )
    throw new Error('Provide 1 to 50 receipts with distinct request IDs.');
  const state = await readRunnerStatus(stateDir);
  const pending = state.pendingRequests || [state.pendingRequest];
  if (
    state.continueRequired !== true ||
    receipts.some(
      (receipt) =>
        !pending.some((request) => request?.requestId === receipt?.requestId)
    )
  )
    throw new Error(
      'Every receipt must match a current live request. Read status without replaying browser actions.'
    );
  const deliveredRequestIds = [];
  try {
    for (const receipt of receipts) {
      await submitRunnerReceipt(stateDir, receipt);
      deliveredRequestIds.push(receipt.requestId);
    }
  } catch (error) {
    error.message += ` Already delivered: ${deliveredRequestIds.join(', ') || 'none'}. Read status and deliver only missing receipts.`;
    throw error;
  }
  return {
    type: 'receipts_delivered',
    deliveredRequestIds,
    continueRequired: true,
  };
}

export async function runTransportCommand(options) {
  const identity = createHash('sha256')
    .update(
      resolve(
        options.connection ||
          join(dirname(options.runnerPath), '..', 'connection.json')
      )
    )
    .digest('hex')
    .slice(0, 20);
  const stateDir = resolve(
    options.stateDir || join(tmpdir(), `blink-controller-${identity}`)
  );
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (['start', 'status', 'respond'].includes(options.command)) {
    await atomicJson(join(stateDir, 'client.json'), {
      updatedAt: new Date().toISOString(),
    });
  }
  let output;
  if (options.command === 'stop') {
    await atomicJson(join(stateDir, 'stop.json'), {
      requestedAt: new Date().toISOString(),
    });
    output = { type: 'stop_requested', stateDir, continueRequired: true };
  } else if (options.command === 'respond') {
    if (!options.receiptFile)
      throw new Error('respond requires --receipt-file PATH.');
    const receipts = JSON.parse(
      await readFile(resolve(options.receiptFile), 'utf8')
    );
    output = Array.isArray(receipts)
      ? await submitRunnerReceipts(stateDir, receipts)
      : await submitRunnerReceipt(stateDir, receipts);
  } else if (options.command === 'status') {
    const revision = options.afterRevision;
    const deadline =
      Date.now() + Math.min(25_000, Math.max(0, Number(options.waitMs) || 0));
    do {
      output = await readRunnerStatus(stateDir);
      if (
        revision === undefined ||
        output.revision !== Number(revision) ||
        output.continueRequired !== true
      )
        break;
      if (Date.now() >= deadline) break;
      await delay(200);
    } while (true);
  } else {
    const prior = await readJson(join(stateDir, 'state.json'));
    const priorScope = await readJson(join(stateDir, 'scope.json'));
    const queues = [...options.queueIds].sort();
    const resumes = [...new Set(options.resumeRunIds || [])].sort();
    if (
      resumes.length > 50 ||
      resumes.some((id) => typeof id !== 'string' || !id || id.length > 200)
    )
      throw new Error('Provide at most 50 approved resume run IDs.');
    const concurrency =
      options.concurrency === undefined ? 3 : Number(options.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3)
      throw new Error('--concurrency must be an integer from 1 to 3.');
    const scope = resumes.length
      ? { queueIds: queues, resumeRunIds: resumes }
      : queues;
    if (
      prior &&
      prior.event?.type !== 'campaign_finished' &&
      !(terminal.has(prior.event?.type) && prior.leaseReleased)
    ) {
      if (priorScope && JSON.stringify(priorScope) !== JSON.stringify(scope)) {
        throw new Error(
          'This controller already owns a different queue selection. Reconnect with its original queue scope.'
        );
      }
      output = await readRunnerStatus(stateDir);
    } else {
      let acquired = false;
      try {
        await mkdir(join(stateDir, 'lock'));
        acquired = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      if (acquired) {
        await options.beforeStart?.();
        if (prior)
          await atomicJson(
            join(stateDir, `previous-${randomUUID()}.json`),
            prior
          );
        await unlink(join(stateDir, 'stop.json')).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await atomicJson(join(stateDir, 'scope.json'), scope);
        await atomicJson(join(stateDir, 'state.json'), {
          type: 'runner_starting',
          continueRequired: true,
          event: { type: 'runner_starting' },
          pendingRequest: null,
        });
        const args = [
          options.runnerPath,
          '--file-transport',
          '--state-dir',
          stateDir,
        ];
        if (options.connection)
          args.push('--connection', resolve(options.connection));
        for (const id of queues) args.push('--queue-id', id);
        for (const id of resumes) args.push('--resume-run-id', id);
        args.push('--concurrency', String(concurrency));
        const child = spawn(process.execPath, args, {
          detached: true,
          windowsHide: true,
          stdio: 'ignore',
          cwd: dirname(options.runnerPath),
        });
        await new Promise((done, reject) => {
          child.once('spawn', done);
          child.once('error', reject);
        });
        child.unref();
      }
      for (let attempt = 0; attempt < 25; attempt += 1) {
        await delay(200);
        output = await readRunnerStatus(stateDir);
        if (output.pendingRequest || terminal.has(output.event?.type)) break;
      }
    }
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return output;
}
