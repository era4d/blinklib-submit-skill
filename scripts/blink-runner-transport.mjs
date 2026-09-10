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

export async function readRunnerStatus(stateDir) {
  const state = await readJson(join(stateDir, 'state.json'));
  if (!state)
    return { type: 'runner_not_started', stateDir, continueRequired: false };
  if (terminal.has(state.event?.type)) return { ...state, stateDir };
  const owner = await readJson(join(stateDir, 'owner.json'));
  if (!owner || Date.now() - Date.parse(owner.updatedAt) > 30_000) {
    return {
      type: 'runner_recovery_required',
      stateDir,
      continueRequired: false,
      message:
        'The controller is no longer responding. Preserve its receipt and reconcile the lease; retain every unfinished tab with an applied field, accepted upload, advanced form step, or ambiguous final action.',
      pendingRequest: state.pendingRequest,
      lastEvent: state.event,
      lastReceipt: state.lastReceipt,
      delivery: state.delivery,
      releaseDelivery: state.releaseDelivery,
      activeLease: state.activeLease,
      pendingLogCount: state.pendingLogCount,
    };
  }
  return { ...state, lastReceipt: undefined, stateDir };
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
  const checkClient = async () => {
    await io.checkControl?.();
    await checkStopped(stateDir);
    const client = await readJson(join(stateDir, 'client.json'));
    const lastContact = client ? Date.parse(client.updatedAt) : startedAt;
    if (
      !Number.isFinite(lastContact) ||
      Date.now() - lastContact > clientTimeoutMs
    ) {
      const error = new Error(
        'The agent stopped contacting this controller. Release its lease and preserve its browser receipt; do not close a tab with applied fields, accepted uploads, or an advanced form step.'
      );
      error.code = 'AGENT_DISCONNECTED';
      throw error;
    }
  };
  const outboxPath = join(stateDir, 'log-outbox.json');
  let outbox = (await readJson(outboxPath)) || [];
  let lastFlush = 0;
  let state = {
    type: 'runner_active',
    continueRequired: true,
    pendingRequest: null,
    event: { type: 'runner_starting' },
    pendingLogCount: outbox.length,
  };
  let writes = Promise.resolve();
  const save = () => {
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
  const saveOutbox = async () => {
    await atomicJson(outboxPath, outbox);
    state.pendingLogCount = outbox.length;
    await save();
  };
  const hasPendingDelivery = (result) =>
    result?.deliveryPending === true ||
    result?.logPending === true ||
    result?.submissionSyncPending === true;
  const flushDeliveries = async (force = false) => {
    if (!outbox.length || (!force && Date.now() - lastFlush < 60_000))
      return outbox.length;
    await checkClient();
    lastFlush = Date.now();
    const retained = [];
    for (const entry of outbox) {
      try {
        // Replays the saved Blink event only. Browser actions are never involved.
        const result = await io.cli(entry.args);
        if (result?.accepted !== true || hasPendingDelivery(result))
          retained.push(entry);
      } catch {
        retained.push(entry);
      }
    }
    outbox = retained;
    await saveOutbox();
    return outbox.length;
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
      /* status becomes stale if storage fails */
    } finally {
      touching = false;
    }
  }, 5_000);
  timer.unref();
  const emit = async (event) => {
    // Heartbeats must not overwrite the browser request or its correction.
    if (event.type === 'heartbeat_failed') {
      state = { ...state, heartbeatError: event };
    } else {
      state = { ...state, event, continueRequired: !terminal.has(event.type) };
    }
    if (terminal.has(event.type)) {
      state.type = event.type;
      // Keep the unfinished request for recovery on failure.
      if (event.type === 'campaign_finished') state.pendingRequest = null;
      clearInterval(timer);
    }
    if (event.type === 'task_settled') {
      state.pendingRequest = null;
      state.activeLease = null;
    }
    if (event.type === 'worker_lease_released')
      state.leaseReleased =
        event.release?.released === true || event.release?.accepted === true;
    await save();
    if (terminal.has(event.type))
      await rmdir(join(stateDir, 'lock')).catch(() => {});
    return event;
  };
  return {
    ...io,
    emit,
    flushDeliveries,
    cli: async (args, behavior) => {
      const cleanup = behavior?.cleanup === true && args[0] === 'release';
      if (!cleanup) await checkClient();
      const delivery = ['result', 'defer', 'release'].includes(args[0]);
      const deliveryKey =
        args[0] === 'release' ? 'releaseDelivery' : 'delivery';
      if (delivery) {
        state[deliveryKey] = { args };
        await save().catch((error) => {
          if (!cleanup) throw error;
        });
      }
      const result = await io.cli(args, behavior);
      if (
        ['next', 'resume'].includes(args[0]) &&
        result?.runId &&
        result?.lease?.leaseId
      ) {
        state.activeLease = {
          runId: result.runId,
          leaseId: result.lease.leaseId,
        };
        try {
          await save();
        } catch (error) {
          // A claimed task must not be leaked because local state storage failed.
          await io
            .cli(
              [
                'release',
                '--run-id',
                result.runId,
                '--lease-id',
                result.lease.leaseId,
                '--event-id',
                randomUUID(),
                '--occurred-at',
                new Date().toISOString(),
              ],
              { cleanup: true }
            )
            .catch(() => {});
          throw error;
        }
      }
      if (delivery) {
        if (
          ['result', 'release'].includes(args[0]) &&
          result?.accepted === true &&
          hasPendingDelivery(result)
        ) {
          const eventId = args[args.indexOf('--event-id') + 1];
          if (!args.includes('--event-id') || !eventId)
            throw new Error('Pending log delivery requires a stable event ID.');
          outbox = [
            ...outbox.filter((entry) => entry.eventId !== eventId),
            { eventId, args },
          ];
          await saveOutbox();
        }
        state[deliveryKey] = null;
        await save();
      }
      return result;
    },
    request: async (request) => {
      state.pendingRequest = request;
      await emit(request);
      const receiptPath = join(stateDir, `receipt-${request.requestId}.json`);
      while (true) {
        await checkClient();
        const receipt = await readJson(receiptPath);
        if (receipt) {
          state.lastReceipt = { request, receipt };
          state.pendingRequest = null;
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
  const pending = state.pendingRequest;
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
    output = await submitRunnerReceipt(
      stateDir,
      JSON.parse(await readFile(resolve(options.receiptFile), 'utf8'))
    );
  } else if (options.command === 'status') {
    output = await readRunnerStatus(stateDir);
  } else {
    const prior = await readJson(join(stateDir, 'state.json'));
    const priorScope = await readJson(join(stateDir, 'scope.json'));
    const scope = [...options.queueIds].sort();
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
        for (const id of scope) args.push('--queue-id', id);
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
