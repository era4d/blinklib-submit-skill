import { mkdir, mkdtemp, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { auditLog, auditResult, auditTask, RESULT_STATUSES } from './blink-audit.mjs';

const CLIENT_VERSION = '1.9.2';
// Older clients may have cached raw profile images instead of API-resolved assets.
const PRODUCT_CACHE_VERSION = 3;

const EVIDENCE_REQUIRED_STATUSES = new Set([
  'submitted',
  'awaiting_approval',
  'awaiting_email_verification',
  'published',
]);

const SENSITIVE_QUERY_KEY = /^(?:access_?token|auth|authorization|code|credential|key|magic|password|secret|sig|signature|token)$/i;
const SENSITIVE_DETAIL_KEY = /^(?:accessToken|access_token|apiKey|api_key|authorization|cookie|cookies|otp|password|recoveryCode|recovery_code|secret|sessionId|session_id)$/i;

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name) {
  const value = argument(name);
  if (!value?.trim() || value.startsWith('--')) throw new Error(`Missing --${name}`);
  return value;
}

function uploadFieldPurpose(label) {
  const text = label.normalize('NFKC').toLowerCase();
  const matches = [
    ['logo', /\b(?:logos?|icons?|favicons?)\b|图标|標誌|标志|商标/],
    ['preview', /\b(?:banners?|covers?|previews?|hero\s+images?)\b|封面|横幅|橫幅|预览图|預覽圖/],
    ['screenshots', /\b(?:screen[\s-]?shots?|gallery)\b|截图|截圖|画廊|圖庫|图库/],
  ].filter(([, pattern]) => pattern.test(text)).map(([purpose]) => purpose);
  if (matches.length > 1) throw new Error('Ambiguous upload field label. Inspect the individual field before preparing images.');
  return matches[0] || null;
}

async function jsonFile(name) {
  const path = argument(name);
  return path ? JSON.parse(await readFile(path, 'utf8')) : undefined;
}

function productCachePath() {
  if (process.env.BLINK_PRODUCT_CACHE_PATH) {
    return process.env.BLINK_PRODUCT_CACHE_PATH;
  }
  const stateRoot = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME;
  return join(
    stateRoot || join(homedir(), '.local', 'state'),
    'blinklib',
    'backlink-submit',
    'products.json',
  );
}

async function readProductCache() {
  try {
    const parsed = JSON.parse(await readFile(productCachePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    if (parsed.version !== PRODUCT_CACHE_VERSION || parsed.connection !== connectionCacheKey()) return {};
    return parsed.projects && typeof parsed.projects === 'object'
      ? parsed.projects
      : {};
  } catch {
    return {};
  }
}

async function writeProductCache(projects) {
  const path = productCachePath();
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    JSON.stringify(
      {
        version: PRODUCT_CACHE_VERSION,
        connection: connectionCacheKey(),
        updatedAt: new Date().toISOString(),
        projects,
      },
      null,
      2,
    ),
    { encoding: 'utf8', mode: 0o600 },
  );
  await rename(temporaryPath, path);
}

async function persistProductCache(projects) {
  try {
    await writeProductCache(projects);
    return 'written';
  } catch {
    // Do not expose a private path or discard fresh in-memory facts.
    return 'write_failed';
  }
}

function cacheProjects(projects, response) {
  if (!response || !Array.isArray(response.projects)) return;
  for (const project of response.projects) {
    if (!project || typeof project !== 'object' || !project.id) continue;
    projects[String(project.id)] = {
      projectId: String(project.id),
      updatedAt: project.updatedAt || null,
      product: project.product || null,
      profile: project.profile || null,
    };
  }
}

function connectionCacheKey() {
  return createHash('sha256').update(`${baseUrl}\n${apiKey}`).digest('hex');
}

function compactStoredClaim(task, taskFile, serialized) {
  return {
    schemaVersion: task.schemaVersion,
    taskStored: true,
    taskFile,
    taskSha256: createHash('sha256').update(serialized).digest('hex'),
    taskBytes: Buffer.byteLength(serialized),
    runId: task.runId,
    queueId: task.queueId,
    projectId: task.projectId,
    submissionUrl: task.submissionUrl,
    platformDomain: task.platformDomain,
    executionMode: task.executionMode,
    resource: task.resource && {
      id: task.resource.id,
      name: task.resource.name,
      submissionUrl: task.resource.submissionUrl,
      automaticSubmission: task.resource.automaticSubmission === true,
    },
    browser: task.browser,
    lease: task.lease,
    clientAudit: task.clientAudit && {
      valid: task.clientAudit.valid === true,
      executable: task.clientAudit.executable === true,
      readyForInspection: task.clientAudit.readyForInspection === true,
      readyForSubmission: task.clientAudit.readyForSubmission === true,
    },
  };
}

async function storeClaimTask(task, claimDir) {
  if (!task || task.executable === false || !task.runId || !task.lease?.leaseId)
    return task;
  const serialized = JSON.stringify(task);
  const taskFile = join(
    claimDir,
    `${createHash('sha256').update(task.runId).digest('hex').slice(0, 16)}-${randomUUID()}.json`,
  );
  const temporaryPath = `${taskFile}.${process.pid}.tmp`;
  await writeFile(temporaryPath, serialized, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await rename(temporaryPath, taskFile);
  return compactStoredClaim(task, taskFile, serialized);
}

async function storeClaimOutput(result, command, directory) {
  if (!directory) return result;
  if (!['next', 'next-batch', 'resume'].includes(command))
    throw new Error('--claim-dir is supported only for next, next-batch, and resume.');
  if (!isAbsolute(directory)) throw new Error('--claim-dir must be absolute.');
  const claimDir = resolve(directory);
  await mkdir(claimDir, { recursive: true, mode: 0o700 });
  if (command === 'next-batch') {
    return {
      ...result,
      claims: await Promise.all(
        (Array.isArray(result?.claims) ? result.claims : []).map((task) =>
          storeClaimTask(task, claimDir),
        ),
      ),
    };
  }
  return storeClaimTask(result, claimDir);
}

async function cacheServerRequirements(response) {
  if (typeof response?.minimumClientVersion !== 'string') return;
  const path = `${productCachePath()}.server.json`;
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ connection: connectionCacheKey(), minimumClientVersion: response.minimumClientVersion }), { mode: 0o600 });
  await rename(temporaryPath, path);
}

function missingProductFields(product) {
  if (!product || typeof product !== 'object') {
    return ['name', 'canonicalUrl', 'description'];
  }
  return ['name', 'canonicalUrl', 'description'].filter(
    (field) => typeof product[field] !== 'string' || !product[field].trim(),
  );
}

async function hydrateTaskProduct(task) {
  const projects = await readProductCache();
  const projectId = String(
    task?.projectId || task?.productRef?.canonicalId || task?.product?.canonicalId || '',
  );
  const expectedVersion =
    task?.productVersion || task?.productRef?.updatedAt || null;
  if (task?.product && projectId) {
    projects[projectId] = {
      projectId,
      updatedAt: expectedVersion,
      product: task.product,
      profile: task.product,
    };
    const writeStatus = await persistProductCache(projects);
    return { task: { ...task, productCache: { source: 'claim', version: expectedVersion, writeStatus } }, missingFields: missingProductFields(task.product) };
  }

  let entry = projectId ? projects[projectId] : undefined;
  let source = 'cache';
  let writeStatus = 'not_needed';
  if (
    entry &&
    (!entry.product || missingProductFields(entry.product).length || !expectedVersion || entry.updatedAt !== expectedVersion)
  ) {
    entry = undefined;
  }
  if (!entry && projectId) {
    source = 'api';
    const response = await request(
      `/api/backlink-automation/projects?projectId=${encodeURIComponent(projectId)}`,
    );
    const fresh = response?.projects?.find((project) => project?.id === projectId);
    if (!fresh || !fresh.product || typeof fresh.product !== 'object' || Array.isArray(fresh.product)) {
      throw new Error('Blink did not return the requested product.');
    }
    if (expectedVersion && fresh.updatedAt !== expectedVersion) {
      throw new Error('The product version changed after the task was claimed.');
    }
    cacheProjects(projects, { projects: [fresh] });
    writeStatus = await persistProductCache(projects);
    entry = projects[projectId];
  }
  const product = entry?.product;
  const hydratedTask = product
    ? { ...task, product: { ...entry.profile, canonicalId: projectId, ...product } }
    : task;
  return {
    task: { ...hydratedTask, productCache: { source, version: expectedVersion, writeStatus } },
    missingFields: missingProductFields(hydratedTask.product),
  };
}

async function textArgument(name) {
  const inline = argument(name);
  const file = argument(`${name}-file`);
  if (inline && file) {
    throw new Error(`Use either --${name} or --${name}-file, not both.`);
  }
  return file ? (await readFile(file, 'utf8')).trim() : inline;
}

async function requiredText(name) {
  const value = await textArgument(name);
  if (!value) throw new Error(`Missing --${name} or --${name}-file`);
  return value;
}

function safeHttpUrl(value, fieldName) {
  if (!value) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${fieldName} must use HTTP or HTTPS.`);
  }
  if (url.username || url.password) {
    throw new Error(`${fieldName} must not contain embedded credentials.`);
  }
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      throw new Error(
        `${fieldName} appears to contain authentication material. Store it as controlled evidence and return an opaque evidence reference instead.`,
      );
    }
  }
  url.hash = '';
  return url.toString();
}

function assertNoSensitiveDetailKeys(value, path = 'details') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveDetailKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_DETAIL_KEY.test(key)) {
      throw new Error(`${path}.${key} is not allowed in Blink result details.`);
    }
    assertNoSensitiveDetailKeys(entry, `${path}.${key}`);
  }
}

function normalizeDetails(details) {
  if (details === undefined) return undefined;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw new Error('--details-file must contain a JSON object.');
  }
  assertNoSensitiveDetailKeys(details);
  const normalized = { ...details };
  for (const field of ['evidenceUrl', 'pageUrl', 'publicListingUrl']) {
    if (normalized[field]) normalized[field] = safeHttpUrl(normalized[field], `details.${field}`);
  }
  return normalized;
}

async function loadConnection() {
  const customPath = argument('connection');
  const defaultUrl = new URL('../connection.json', import.meta.url);
  try {
    return JSON.parse(await readFile(customPath || defaultUrl, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && process.argv[2] === 'version') return {};
    if (error?.code === 'ENOENT' && process.env.BLINK_APP_URL && process.env.BLINK_API_KEY) {
      return {};
    }
    throw error;
  }
}

const config = await loadConnection();
const command = process.argv[2];
const baseUrl = String(process.env.BLINK_APP_URL || config.appUrl || '').replace(/\/$/, '');
const apiKey = String(process.env.BLINK_API_KEY || config.apiKey || '');
const configuredClientVersion = String(config.clientVersion || CLIENT_VERSION);

if (command !== 'version' && (!baseUrl || !apiKey)) {
  throw new Error('Blink connection is missing. Configure BLINK_APP_URL and BLINK_API_KEY or connection.json.');
}
if (baseUrl) safeHttpUrl(baseUrl, 'Blink app URL');

async function request(path, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  let reader;
  const timeout = setTimeout(() => {
    controller.abort();
    // Explicitly cancel the reader as well: some fetch runtimes stop propagating
    // an abort to a response body once the request/headers have been collected.
    void reader?.cancel().catch(() => undefined);
  }, timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        'x-blink-client-version': CLIENT_VERSION,
        ...options.headers,
      },
    });
    // Keep the deadline active until the body has finished, not just the headers.
    reader = response.body?.getReader();
    const chunks = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    }
    if (controller.signal.aborted) throw new Error('Request deadline exceeded.');
    const responseText = Buffer.concat(chunks).toString('utf8');
    let envelope;
    try {
      envelope = JSON.parse(responseText);
    } catch {
      throw Object.assign(new Error(`Blink returned a non-JSON response (${response.status}).`), { kind: 'invalid_response', httpStatus: response.status });
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || typeof envelope.code !== 'number') {
      throw Object.assign(new Error('Blink returned an invalid response envelope.'), { kind: 'invalid_response', httpStatus: response.status });
    }
    if (!response.ok || envelope.code !== 0) {
      throw Object.assign(new Error(typeof envelope.message === 'string' ? envelope.message : `Request failed (${response.status})`), { kind: 'api_error', httpStatus: response.status, recovery: safeClaimRecovery(envelope.data), action: safeActionErrorData(envelope.data) });
    }
    if (!Object.hasOwn(envelope, 'data')) {
      throw Object.assign(new Error('Blink response is missing data.'), { kind: 'invalid_response', httpStatus: response.status });
    }
    return envelope.data;
  } catch (error) {
    if (error.kind) throw error;
    throw Object.assign(new Error('Blink request failed: network error, redirect, or timeout.'), { kind: 'transport_error' });
  } finally {
    clearTimeout(timeout);
    reader?.releaseLock();
  }
}

function compactPayload(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function imageFormat(bytes) {
  const hex = bytes.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return ['png', 'image/png'];
  if (hex.startsWith('ffd8ff')) return ['jpg', 'image/jpeg'];
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return ['gif', 'image/gif'];
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return ['webp', 'image/webp'];
  if (hex.startsWith('00000100')) return ['ico', 'image/x-icon'];
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 32))) return ['avif', 'image/avif'];
  const text = bytes.toString('utf8').trim().replace(/^\uFEFF/, '').replace(/^<\?xml[^?]*\?>\s*/i, '').replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
  if (/^<svg[\s>]/i.test(text) && /<\/svg>\s*$/i.test(text)) return ['svg', 'image/svg+xml'];
  throw new Error('The asset response is not a supported image (PNG, JPEG, GIF, WebP, ICO, AVIF, SVG).');
}

async function downloadImage(sourceUrl, directory, name, maxBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    let url = new URL(sourceUrl);
    let response;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Asset URLs must use HTTP(S) without embedded credentials.');
      }
      // Never reuse the authenticated Blink request helper for image hosts.
      response = await fetch(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { accept: 'image/*' },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error('Asset download exceeded its redirect limit or has no redirect location.');
      url = new URL(location, url);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Asset download failed (HTTP ${response.status}).`);
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new Error('Asset exceeds the upload size limit.');
    }
    if (!response.body) throw new Error('Asset download returned an empty body.');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('Asset exceeds the upload size limit.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const [extension, mimeType] = imageFormat(bytes);
    const path = join(directory, `${name}-${randomUUID()}.${extension}`);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return { path, fileName: basename(path), mimeType, sizeBytes: size, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    // Fetch errors may carry signed URLs; expose only our own diagnostic messages.
    if (error instanceof TypeError || controller.signal.aborted) {
      throw new Error('Asset download failed: invalid URL, network error, or timeout.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function postLog(payload) {
  const audit = auditLog(payload);
  if (!audit.valid) throw new Error(`Log audit failed: ${audit.errors.join(' ')}`);
  return postEvent('/api/backlink-automation/logs', payload);
}

function diagnostic(error) {
  // Server and fetch error text may echo credentials or a private task payload.
  return { kind: error.kind || 'client_error', ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
    ...(error.action?.code ? { code: error.action.code } : {}),
    ...(error.action?.nextAction ? { nextAction: error.action.nextAction } : {}),
    ...(error.action?.errorId ? { errorId: error.action.errorId } : {}) };
}

function safeClaimRecovery(data) {
  const recovery = {};
  for (const field of ['runId', 'leaseId']) {
    if (typeof data?.[field] === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(data[field])) recovery[field] = data[field];
  }
  if (typeof data?.recoveryPending === 'boolean') recovery.recoveryPending = data.recoveryPending;
  return recovery;
}

function safeActionErrorData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const result = {};
  const code = data.code || data.errorCode;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,100}$/.test(code)) {
    result.code = code;
  }
  if (typeof data.errorId === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(data.errorId)) result.errorId = data.errorId;
  if (
    typeof data.nextAction === 'string' &&
    /^[a-z0-9_]{1,100}$/.test(data.nextAction)
  ) {
    result.nextAction = data.nextAction;
  }
  if (typeof data.deferred === 'boolean') result.deferred = data.deferred;
  return result;
}

function deliveryRecovery(path, payload) {
  return {
    deliveryOnly: true,
    eventCommand: ['event', '--event-id', payload.eventId],
    logsCommand: ['logs', '--run-id', payload.runId],
    method: 'POST', path, payload: compactPayload(payload),
    message: 'Replay only this exact API payload to repair delivery, preserving eventId and occurredAt. Do not repeat the browser submission or claim a replacement task.',
  };
}

async function postEvent(path, payload) {
  const isResult = path.endsWith('/logs') && payload.event === 'submission_result';
  const attempts = isResult ? 3 : 1;
  const body = JSON.stringify(compactPayload(payload));
  let accepted;
  let lastError;
  let lookupError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await request(path, { method: 'POST', body });
      const committed = isResult && RESULT_STATUSES.has(payload.status)
        && response?.run?.id === payload.runId && response.run.status === payload.status && response.run.leaseId === null;
      const conflictingRun = response?.run && (response.run.id !== payload.runId || (payload.status && response.run.status !== payload.status));
      const confirmed = !conflictingRun && (path.endsWith('/claim/reject') ? response?.rejected === true
        : path.endsWith('/lease/release') ? response?.released === true
        : path.endsWith('/defer') ? response?.deferred === true
          : committed || Boolean(response?.logId) || response?.accepted === true || response?.duplicate === true);
      if (!confirmed) throw Object.assign(new Error('Write was not confirmed.'), { kind: 'invalid_response' });
      const pending = response.logPending === true || response.submissionSyncPending === true;
      if (!isResult || !pending) return accepted || committed ? { ...response, accepted: true, ...(accepted ? { reconciled: true } : {}) } : response;
      accepted = { ...response, accepted: true };
      // State is committed. Replaying the same event repairs delivery only.
    } catch (error) {
      if (
        path.endsWith('/defer') &&
        error?.httpStatus === 409 &&
        (/^(?:INVALID_AUTOMATIC_BLOCKER|INCOMPLETE_FORM_OBSERVATION):/.test(
          error.message || ''
        ) || error?.action?.deferred === false)
      ) {
        return {
          accepted: false,
          settled: false,
          code: error?.action?.code || 'INVALID_AUTOMATIC_BLOCKER',
          continueRequired: true,
          nextAction:
            error?.action?.nextAction || 'continue_automatic_submission',
          message:
            'The requested deferral is an ordinary authorized automatic-submission step. Continue the current browser workflow.',
        };
      }
      lastError = diagnostic(error);
      let lookup;
      try {
        lookup = await request(`/api/backlink-automation/events/${encodeURIComponent(payload.eventId)}`);
      } catch (failure) {
        lookupError = diagnostic(failure);
      }
      const event = lookup?.event;
      const matches = lookup?.found === true && event?.eventId === payload.eventId && event?.runId === payload.runId && event?.leaseId === payload.leaseId
        && (path.endsWith('/claim/reject') ? event.event === 'claim_rejected'
          : [payload.event, ...(path.endsWith('/lease/release') ? ['worker_released'] : []), ...(isResult ? ['submission_reconciled'] : [])].includes(event.event)
            && (!payload.status || event.status === payload.status));
      if (matches) {
        const confirmed = {
          ...(path.endsWith('/claim/reject') ? { rejected: true } : { accepted: true, logId: event.id }),
          reconciled: true, runId: payload.runId, leaseId: payload.leaseId, eventId: payload.eventId,
        };
        if (!isResult) return confirmed;
        // An event confirms recording, but marker synchronization may still need repair.
        accepted = { ...accepted, ...confirmed, logPending: false, submissionSyncPending: true };
      }
      // An event ID collision or a definitive request rejection needs inspection.
      if ((lookup?.found === true && !matches) || [400, 401, 403, 404, 409, 422, 429].includes(error.httpStatus)) break;
    }
  }
  const identifiers = { runId: payload.runId, leaseId: payload.leaseId, eventId: payload.eventId, occurredAt: payload.occurredAt, idempotencyKey: payload.idempotencyKey };
  if (accepted) return {
    ...accepted, ...identifiers, accepted: true, deliveryPending: true, retryAllowed: false,
    nextAction: 'repair_delivery_only_with_same_payload', recovery: deliveryRecovery(path, payload),
  };
  process.exitCode = 1;
  return {
    status: 'write_outcome_unknown', ...identifiers, retryAllowed: false, error: lastError, lookupError,
    nextAction: 'inspect_event_and_run_before_replaying_same_event', recovery: deliveryRecovery(path, payload),
  };
}

async function rejectClaim(task, errorCode, context = {}) {
  const runId = typeof task?.runId === 'string' ? task.runId : null;
  const leaseId = typeof task?.lease?.leaseId === 'string' ? task.lease.leaseId
    : typeof task?.leaseId === 'string' ? task.leaseId : null;
  const identifiers = { runId, leaseId, queueId: task?.queueId, projectId: task?.projectId, idempotencyKey: task?.idempotencyKey };
  let rejection;
  if (runId?.trim() && leaseId?.trim()) {
    rejection = await postEvent('/api/backlink-automation/claim/reject', {
      runId, leaseId, errorCode,
      message: `Client could not prepare the claimed task (${errorCode}). Resolve the client audit or product data before retrying this run.`,
      eventId: randomUUID(), occurredAt: new Date().toISOString(),
    });
  }
  const released = rejection?.rejected === true;
  process.exitCode = 1;
  return {
    ...identifiers, status: released ? 'claim_rejected' : 'claim_release_unknown',
    executable: false, retryAllowed: false, leaseReleased: released, errorCode,
    ...context, rejection,
    nextAction: released ? 'resolve_problem_then_explicitly_retry_run' : 'reconcile_claim_before_any_further_work',
    recovery: {
      logsCommand: runId ? ['logs', '--run-id', runId] : ['logs'],
      queueCommand: ['queue'],
      message: released ? 'The claim was released. Fix the reported problem before explicitly retrying this run.'
        : 'The lease release is unconfirmed. Inspect the event, logs and queue; do not repeat next/resume or the browser submission.',
    },
  };
}

async function prepareClaim(task) {
  if (task === null) return null;
  const leaseId = task?.lease?.leaseId || task?.leaseId;
  if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.runId !== 'string' || !task.runId.trim() || typeof leaseId !== 'string' || !leaseId.trim()) {
    return rejectClaim(task, 'CLIENT_INVALID_CLAIM');
  }
  let hydrated;
  try {
    hydrated = await hydrateTaskProduct(task);
  } catch (error) {
    return rejectClaim(task, 'CLIENT_PRODUCT_HYDRATION_FAILED', { error: diagnostic(error) });
  }
  let clientAudit;
  try {
    clientAudit = auditTask(hydrated.task);
  } catch (error) {
    return rejectClaim(task, 'CLIENT_TASK_AUDIT_FAILED', { error: diagnostic(error) });
  }
  if (hydrated.missingFields.length) {
    return rejectClaim(task, 'CLIENT_PRODUCT_MISSING_DATA', {
      clientAudit,
      productInfoRequest: {
        status: 'needs_user_input', missingFields: hydrated.missingFields,
        message: 'Record the missing product facts, release this claim, and continue the queue. The product can be updated before an explicit later retry.',
      },
    });
  }
  if (!clientAudit.valid) return rejectClaim(task, 'CLIENT_TASK_AUDIT_FAILED', { clientAudit });
  return { ...hydrated.task, clientAudit };
}

let result;
try {
switch (command) {
  case 'version':
    result = {
      name: 'backlink-submit',
      clientVersion: CLIENT_VERSION,
      configuredClientVersion,
    };
    break;
  case 'queue':
    result = await request('/api/backlink-automation/queue');
    await cacheServerRequirements(result).catch(() => undefined);
    break;
  case 'projects':
  case 'project': {
    const projectId = argument('project-id');
    const suffix = projectId
      ? `?projectId=${encodeURIComponent(projectId)}`
      : '';
    result = await request(`/api/backlink-automation/projects${suffix}`);
    const projects = await readProductCache();
    cacheProjects(projects, result);
    await writeProductCache(projects).catch(() => undefined);
    break;
  }
  case 'answers': {
    const resourceId = required('resource-id');
    const projectId = required('project-id');
    const runId = required('run-id');
    const leaseId = required('lease-id');
    const fieldKeys = process.argv.flatMap((value, index) =>
      value === '--field-key' ? [process.argv[index + 1]] : []
    );
    if (
      fieldKeys.some(
        (fieldKey) =>
          !fieldKey || fieldKey.startsWith('--') || fieldKey.length > 80
      ) ||
      fieldKeys.length > 50
    ) {
      throw new Error('Provide at most 50 valid --field-key values.');
    }
    result = await request(
      `/api/directory/resources/${encodeURIComponent(resourceId)}/generate`,
      {
        method: 'POST',
        body: JSON.stringify(
          compactPayload({
            projectId,
            runId,
            leaseId,
            fieldKeys: fieldKeys.length ? fieldKeys : undefined,
          })
        ),
      },
      90_000,
    );
    if (
      !result?.values ||
      typeof result.values !== 'object' ||
      Array.isArray(result.values) ||
      !result.context ||
      !Number.isInteger(result.context.questionCount)
    ) {
      throw new Error('Blink returned an invalid generated-answer response.');
    }
    break;
  }
  case 'prepare-upload':
  case 'assets': {
    const projectId = required('project-id');
    const prepareUpload = command === 'prepare-upload';
    const download = prepareUpload ? required('purpose') : argument('download');
    if ((prepareUpload || process.argv.includes('--download')) && !['logo', 'preview', 'screenshots'].includes(download)) {
      throw new Error('--download must be logo, preview, or screenshots.');
    }
    const pageId = prepareUpload ? Number(required('page-id')) : undefined;
    const uid = prepareUpload ? required('uid').trim() : undefined;
    const browserFilesystem = argument('browser-filesystem') || 'unknown';
    // This is a runtime-declared permitted root, not a way to grant permissions.
    const uploadRootArgument = process.argv.includes('--upload-root') ? required('upload-root') : undefined;
    if (uploadRootArgument && (!isAbsolute(uploadRootArgument) || browserFilesystem !== 'shared')) {
      throw new Error('--upload-root requires an absolute, runtime-approved directory and --browser-filesystem shared.');
    }
    // Chrome DevTools permits its OS temp directory without extra roots configuration.
    // The agent establishes shared host/temp semantics; the CLI cannot discover MCP topology.
    const uploadRoot = uploadRootArgument ? await realpath(uploadRootArgument)
      : prepareUpload && browserFilesystem === 'shared' ? await realpath(tmpdir()) : undefined;
    if (uploadRoot && !(await stat(uploadRoot)).isDirectory()) throw new Error('--upload-root must be an existing directory.');
    const requiredCount = Number(argument('required-count') || 0);
    const maxCount = Number(argument('max-count') || (download === 'screenshots' ? 5 : 1));
    if (!Number.isInteger(requiredCount) || requiredCount < 0 || !Number.isInteger(maxCount) || maxCount < 1 || maxCount > 5 || requiredCount > maxCount) {
      throw new Error('Image counts must be integers: 0 <= required-count <= max-count <= 5.');
    }
    if (prepareUpload && (!Number.isSafeInteger(pageId) || pageId < 0 || !uid || uid.startsWith('--'))) {
      throw new Error('prepare-upload requires a valid observed --page-id and --uid.');
    }
    const fieldLabel = prepareUpload ? required('field-label').trim() : undefined;
    if (prepareUpload && (!fieldLabel || fieldLabel.startsWith('--') || fieldLabel.length > 500)) {
      throw new Error('--field-label must be the observed upload field label (1–500 characters).');
    }
    const fieldPurpose = prepareUpload ? uploadFieldPurpose(fieldLabel) : undefined;
    if (fieldPurpose && fieldPurpose !== download) {
      throw new Error(`Upload purpose mismatch: the observed field requires ${fieldPurpose}, but --purpose is ${download}.`);
    }
    if (prepareUpload && !['shared', 'remote', 'unknown'].includes(browserFilesystem)) {
      throw new Error('--browser-filesystem must be shared, remote, or unknown.');
    }
    const maxSizeMB = Number(argument('max-size-mb') || 20);
    if (!Number.isFinite(maxSizeMB) || maxSizeMB <= 0 || maxSizeMB > 20) {
      throw new Error('--max-size-mb must be greater than zero and at most 20.');
    }
    // Uploads always resolve against the API, even if the disk cache has images.
    const response = await request(
      `/api/backlink-automation/projects?projectId=${encodeURIComponent(projectId)}`,
    );
    const project = response?.projects?.find((entry) => entry.id === projectId);
    if (!project) throw new Error('The requested project was not returned by Blink.');
    const sources = [project.product, project.profile, project];
    const urlFor = (field) => sources.map((entry) => entry?.[field])
      .find((value) => typeof value === 'string' && value.trim())?.trim() || '';
    const screenshotUrls = sources.map((entry) => entry?.screenshotUrls)
      .filter(Array.isArray)
      .map((values) => values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))
      .find((values) => values.length) || [];
    const assets = { logoUrl: urlFor('logoUrl'), previewImageUrl: urlFor('previewImageUrl'), screenshotUrls };
    result = {
      projectId,
      source: 'blink_api',
      ...assets,
      missingAssets: Object.entries(assets).filter(([, value]) => !value.length).map(([key]) => key),
    };
    const projects = await readProductCache();
    cacheProjects(projects, response);
    await writeProductCache(projects).catch(() => undefined);
    if (download) {
      const urls = download === 'logo' ? [assets.logoUrl] : download === 'preview' ? [assets.previewImageUrl] : assets.screenshotUrls;
      const selected = [...new Set(urls.filter(Boolean))].slice(0, maxCount);
      result.files = [];
      result.uploadPurpose = download;
      if (selected.length) {
        const outputRoot = resolve(argument('output-dir') || uploadRoot || tmpdir());
        const withinRoot = (path) => {
          const rel = relative(uploadRoot, path);
          return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
        };
        if (uploadRoot) {
          if (!withinRoot(outputRoot)) throw new Error('Upload output directory is outside --upload-root.');
          // Check existing ancestors before mkdir, including Windows junctions.
          let ancestor = outputRoot;
          while (true) {
            try {
              if (!withinRoot(await realpath(ancestor))) throw new Error('Upload output directory resolves outside --upload-root.');
              break;
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              ancestor = dirname(ancestor);
            }
          }
        }
        await mkdir(outputRoot, { recursive: true });
        const canonicalOutput = await realpath(outputRoot);
        if (uploadRoot && !withinRoot(canonicalOutput)) throw new Error('Upload output directory resolves outside --upload-root.');
        const directory = await mkdtemp(join(canonicalOutput, 'blink-upload-'));
        const downloadErrors = [];
        for (const [index, url] of selected.entries()) {
          try {
            result.files.push({
              ...await downloadImage(url, directory, `${download}-${index + 1}`, maxSizeMB * 1024 * 1024),
              assetPurpose: download,
              sourceField: download === 'logo' ? 'logoUrl' : download === 'preview' ? 'previewImageUrl' : 'screenshotUrls',
            });
          } catch (error) {
            downloadErrors.push({ index, message: error.message });
          }
        }
        if (downloadErrors.length && !result.files.length) throw new Error(downloadErrors[0].message);
        if (downloadErrors.length) result.downloadErrors = downloadErrors;
      }
    }
    if (prepareUpload) {
      const hasFiles = result.files.length > 0;
      result.fileHost = 'cli';
      result.uploaded = false;
      result.requiredCount = requiredCount;
      result.availableCount = result.files.length;
      result.missingCount = Math.max(0, requiredCount - result.files.length);
      result.afterUploadAction = result.missingCount ? 'ask_user_to_supply_images_or_authorize_screenshots' : 'verify_attachment_and_continue';
      result.uploadRoot = uploadRoot || null;
      result.uploadRootSource = uploadRootArgument ? 'runtime_override' : uploadRoot ? 'os_temp' : null;
      result.pathAccess = uploadRootArgument ? 'runtime_root_supplied_not_tool_verified'
        : uploadRoot ? 'default_temp_root_not_tool_verified' : 'unknown';
      result.status = !hasFiles ? 'missing_asset' : browserFilesystem !== 'shared' ? 'requires_browser_host_file' : 'ready_to_attach';
      result.target = { pageId, uid, fieldLabel, fieldPurpose };
      result.browserUpload = result.status === 'ready_to_attach' ? {
        tool: 'mcp__chrome_devtools__upload_file',
        arguments: { pageId, uid, filePaths: result.files.map((file) => file.path), includeSnapshot: true },
      } : null;
      result.nextAction = !hasFiles ? 'resolve_missing_asset' : browserFilesystem !== 'shared' ? 'transfer_exact_files_to_browser_host_then_upload' : 'call_browser_upload_then_verify';
    }
    break;
  }
  case 'upload-assets': {
    const projectId = required('project-id');
    const purpose = required('purpose');
    if (!['logo', 'preview', 'screenshots'].includes(purpose)) throw new Error('Invalid image purpose.');
    const paths = process.argv.flatMap((value, index) => value === '--file' ? [process.argv[index + 1]] : []);
    if (!paths.length || paths.some((path) => !path || path.startsWith('--')) || paths.length > (purpose === 'screenshots' ? 5 : 1)) {
      throw new Error('Provide --file PATH for one logo/preview or up to five screenshots.');
    }
    const form = new FormData();
    form.append('purpose', purpose);
    for (const path of paths) {
      const filePath = resolve(path);
      const info = await stat(filePath);
      if (!info.isFile() || info.size === 0 || info.size > 5 * 1024 * 1024) throw new Error('Each image must be nonempty and at most 5 MB.');
      const bytes = await readFile(filePath);
      if (bytes.length > 5 * 1024 * 1024) throw new Error('Each image must be at most 5 MB.');
      const [extension, mimeType] = imageFormat(bytes);
      if (['svg', 'ico'].includes(extension)) throw new Error('Convert SVG/ICO to PNG before saving project images.');
      form.append('files', new Blob([bytes], { type: mimeType }), `image-${form.getAll('files').length + 1}.${extension}`);
    }
    result = await request(`/api/backlink-automation/projects/${encodeURIComponent(projectId)}/assets`, { method: 'POST', body: form, redirect: 'error' });
    if (!result?.saved || result.project?.id !== projectId) throw new Error('Blink did not confirm that these project images were saved.');
    const projects = await readProductCache();
    cacheProjects(projects, { projects: [result.project] });
    await writeProductCache(projects).catch(() => undefined);
    break;
  }
  case 'next': {
    const queueSuffix = argument('queue-id') ? `&queueId=${encodeURIComponent(required('queue-id'))}` : '';
    result = await request(`/api/backlink-automation/next?includeProduct=false${queueSuffix}`, {
      method: 'POST',
    });
    if (!(result?.claim === null && result?.settlement)) {
      result = await prepareClaim(result);
    }
    break;
  }
  case 'next-batch': {
    let queueIds;
    try {
      queueIds = JSON.parse(required('queue-ids-json'));
    } catch {
      throw new Error('--queue-ids-json must be a JSON array.');
    }
    if (!Array.isArray(queueIds) || queueIds.length < 1 || queueIds.length > 50 ||
        queueIds.some((queueId) => typeof queueId !== 'string' || !queueId.trim() || queueId.length > 200)) {
      throw new Error('--queue-ids-json must contain 1 to 50 valid queue IDs.');
    }
    const response = await request('/api/backlink-automation/claim/batch', {
      method: 'POST', body: JSON.stringify({ queueIds }),
    });
    if (!Array.isArray(response?.claims) || response.claims.length !== queueIds.length) {
      throw new Error('Blink returned an invalid batch claim response.');
    }
    const claims = [];
    for (const claim of response.claims) {
      claims.push(claim === null || claim?.executable === false
        ? claim
        : await prepareClaim(claim));
    }
    result = {
      claims,
      ...(response?.skillUpdate ? { skillUpdate: response.skillUpdate } : {}),
    };
    break;
  }
  case 'set-concurrency': {
    const concurrency = Number(required('concurrency'));
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) throw new Error('--concurrency must be an integer from 1 to 50.');
    result = await request('/api/backlink-automation/concurrency', {
      method: 'POST', body: JSON.stringify({ queueId: required('queue-id'), concurrency }),
    });
    break;
  }
  case 'retry': {
    const queueId = required('queue-id');
    const runId = argument('run-id');
    result = await request('/api/backlink-automation/retry', {
      method: 'POST',
      body: JSON.stringify(
        runId ? { queueId, runId } : { queueId, retryFailed: true },
      ),
    });
    break;
  }
  case 'update-product': {
    const projectId = required('project-id');
    const profile = await jsonFile('profile-file');
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new Error('--profile-file must contain a JSON object.');
    }
    result = await request(
      `/api/backlink-automation/projects/${encodeURIComponent(projectId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ profile }),
      },
    );
    const projects = await readProductCache();
    if (result?.project) {
      cacheProjects(projects, { projects: [result.project] });
      await writeProductCache(projects).catch(() => undefined);
    }
    break;
  }
  case 'logs': {
    const query = new URLSearchParams();
    if (argument('project-id')) query.set('projectId', argument('project-id'));
    if (argument('run-id')) query.set('runId', argument('run-id'));
    if (argument('page')) query.set('page', argument('page'));
    if (argument('page-size')) query.set('pageSize', argument('page-size'));
    const suffix = query.size ? `?${query}` : '';
    result = await request(`/api/backlink-automation/logs${suffix}`);
    break;
  }
  case 'heartbeat': {
    result = await request('/api/backlink-automation/lease/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        runId: required('run-id'),
        leaseId: required('lease-id'),
        eventId: argument('event-id') || randomUUID(),
        occurredAt: argument('occurred-at') || new Date().toISOString(),
      }),
    });
    break;
  }
  case 'defer': {
    const reason = required('reason');
    if (!['awaiting_user_login', 'blocked_user_action'].includes(reason)) {
      throw new Error('defer --reason must be awaiting_user_login or blocked_user_action.');
    }
    const payload = compactPayload({
        runId: required('run-id'),
        leaseId: required('lease-id'),
        reason,
        blockerCode: required('blocker-code'),
        formExecution: await jsonFile('form-execution-file'),
        runtimeEvidence: await jsonFile('runtime-evidence-file'),
        resumePhase: required('resume-phase'),
        idempotencyKey: required('idempotency-key'),
        browserSessionAlias: required('browser-session-alias'),
        currentUrl: safeHttpUrl(required('current-url'), 'current URL'),
        eventId: argument('event-id') || randomUUID(),
        occurredAt: argument('occurred-at') || new Date().toISOString(),
    });
    result = await postEvent('/api/backlink-automation/defer', payload);
    break;
  }
  case 'resume': {
    result = await request('/api/backlink-automation/resume?includeProduct=false', {
      method: 'POST',
      body: JSON.stringify({ runId: required('run-id') }),
    });
    result = await prepareClaim(result);
    break;
  }
  case 'release': {
    result = await postEvent('/api/backlink-automation/lease/release', {
      runId: required('run-id'), leaseId: required('lease-id'),
      eventId: argument('event-id') || randomUUID(), occurredAt: argument('occurred-at') || new Date().toISOString(),
    });
    break;
  }
  case 'reject': {
    result = await postEvent('/api/backlink-automation/claim/reject', {
        runId: required('run-id'),
        leaseId: required('lease-id'),
        errorCode: required('error-code'),
        message: await requiredText('message'),
        eventId: argument('event-id') || randomUUID(),
        occurredAt: argument('occurred-at') || new Date().toISOString(),
    });
    break;
  }
  case 'event': {
    result = await request(
      `/api/backlink-automation/events/${encodeURIComponent(required('event-id'))}`
    );
    break;
  }
  case 'log': {
    const payload = {
      runId: required('run-id'),
      leaseId: required('lease-id'),
      event: required('event'),
      message: await requiredText('message'),
      level: argument('level') || 'info',
      status: argument('status'),
      resultUrl: safeHttpUrl(argument('result-url'), 'result URL'),
      screenshotPath: argument('screenshot-path'),
      errorMessage: await textArgument('error-message'),
      answers: await jsonFile('answers-file'),
      details: normalizeDetails(await jsonFile('details-file')),
      eventId: argument('event-id') || randomUUID(),
      occurredAt: argument('occurred-at') || new Date().toISOString(),
      idempotencyKey: argument('idempotency-key'),
    };
    result = await postLog(payload);
    break;
  }
  case 'result': {
    const status = required('status');
    if (!RESULT_STATUSES.has(status)) {
      throw new Error(`Unsupported result status: ${status}`);
    }
    const details = normalizeDetails(await jsonFile('details-file'));
    const resultUrl = safeHttpUrl(argument('result-url'), 'result URL');

    if (EVIDENCE_REQUIRED_STATUSES.has(status)) {
      if (!details?.exactResult) {
        throw new Error(`${status} requires details.exactResult.`);
      }
      if (!resultUrl && !details?.evidenceUrl && !details?.evidenceRef) {
        throw new Error(`${status} requires a safe evidence URL or opaque evidenceRef.`);
      }
    }
    if (status === 'published' && !details?.publicListingUrl && !resultUrl) {
      throw new Error('published requires details.publicListingUrl or --result-url.');
    }

    const payload = {
      runId: required('run-id'),
      leaseId: required('lease-id'),
      event: 'submission_result',
      message: await requiredText('message'),
      level: status === 'submission_failed' ? 'error' : 'info',
      status,
      resultUrl,
      screenshotPath: argument('screenshot-path'),
      errorMessage: await textArgument('error-message'),
      details,
      eventId: argument('event-id') || randomUUID(),
      occurredAt: argument('occurred-at') || new Date().toISOString(),
      idempotencyKey: argument('idempotency-key') || details?.idempotencyKey || details?.resume?.idempotencyKey,
    };
    const audit = auditResult(payload);
    if (!audit.valid) throw new Error(`Result audit failed: ${audit.errors.join(' ')}`);
    result = await postLog(payload);
    break;
  }
  default:
    throw new Error(
      'Usage: version | queue | projects [--project-id ID] | answers --resource-id ID --project-id ID --run-id ID --lease-id ID [--field-key KEY ...] | assets --project-id ID [--download logo|preview|screenshots] [--output-dir PATH] [--max-size-mb MB] | prepare-upload --project-id ID --purpose logo|preview|screenshots --field-label LABEL --page-id ID --uid UID [--browser-filesystem shared|remote|unknown] [--upload-root RUNTIME_APPROVED_ABSOLUTE_DIR] [--required-count N] [--max-count N] [--output-dir PATH] [--max-size-mb MB] | upload-assets --project-id ID --purpose logo|preview|screenshots --file PATH [--file PATH ...] | next [--queue-id ID] [--claim-dir ABSOLUTE_PATH] | next-batch --queue-ids-json JSON [--claim-dir ABSOLUTE_PATH] | set-concurrency --queue-id ID --concurrency N | retry --queue-id ID [--run-id ID] | update-product --project-id ID --profile-file PATH | logs [filters] | heartbeat | defer --blocker-code CODE [--form-execution-file PATH] [--runtime-evidence-file PATH] | resume [--claim-dir ABSOLUTE_PATH] | reject | event | log [fields] | result --run-id ID --lease-id ID --status STATUS --message/--message-file TEXT [evidence fields]',
    );
}
} catch (error) {
  if (!['next', 'next-batch', 'resume', 'retry'].includes(command)) throw error;
  // These POSTs can change state even when their response is lost. Never retry them automatically.
  process.exitCode = 1;
  result = {
    status: error.kind === 'client_update_required' ? 'client_update_required' : 'command_outcome_unknown', command, runId: argument('run-id') || null,
    queueId: argument('queue-id') || null, retryAllowed: false, executable: false,
    error: diagnostic(error), minimumClientVersion: error.minimumClientVersion,
    nextAction: error.kind === 'client_update_required' ? 'update_skill_then_refresh_queue' : 'inspect_queue_and_logs_before_retry',
    recovery: { queueCommand: ['queue'], logsCommand: argument('run-id') ? ['logs', '--run-id', argument('run-id')] : ['logs'] },
  };
  if (['next', 'resume'].includes(command) && error.recovery?.runId) {
    const recovery = error.recovery;
    if (recovery.recoveryPending === true && recovery.leaseId) {
      result = await rejectClaim(recovery, 'SERVER_CLAIM_PREPARATION_FAILED', { serverRecoveryPending: true, error: diagnostic(error) });
      result.recoveryPending = !result.leaseReleased;
    } else {
      result = {
        ...result, ...recovery, status: 'claim_preparation_failed',
        leaseReleased: recovery.recoveryPending === false,
        recovery: { queueCommand: ['queue'], logsCommand: ['logs', '--run-id', recovery.runId] },
      };
    }
  }
}

result = await storeClaimOutput(result, command, argument('claim-dir'));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
