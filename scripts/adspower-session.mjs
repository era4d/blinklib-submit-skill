#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const CLIENT_VERSION = '1.9.3';
const DEFAULT_API_BASE = 'http://127.0.0.1:50325';
const REQUEST_TIMEOUT_MS = 30_000;
const LIFECYCLE_INTERVAL_MS = 1_100;

function argument(name, args = process.argv.slice(2)) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function flag(name, args = process.argv.slice(2)) {
  return args.includes(`--${name}`);
}

function safeApiBase(value) {
  const url = new URL(String(value || DEFAULT_API_BASE));
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (
    url.protocol !== 'http:' ||
    !loopback.has(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'AdsPower API base must be a credential-free loopback HTTP origin.'
    );
  }
  return url.origin;
}

function requiredProfileId(args = process.argv.slice(2)) {
  const value = String(
    argument('profile-id', args) || process.env.ADSPOWER_PROFILE_ID || ''
  ).trim();
  if (!value || value.length > 128 || /[\r\n]/.test(value)) {
    throw new Error('Set ADSPOWER_PROFILE_ID or pass a valid --profile-id.');
  }
  return value;
}

function profileAlias(profileId) {
  return `adspower_${createHash('sha256').update(profileId).digest('hex').slice(0, 12)}`;
}

function defaultStatePath() {
  const override = process.env.ADSPOWER_STATE_PATH;
  if (override) return resolve(override);
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local')
      : process.platform === 'darwin'
        ? resolve(homedir(), 'Library', 'Application Support')
        : process.env.XDG_STATE_HOME || resolve(homedir(), '.local', 'state');
  return resolve(
    base || tmpdir(),
    'blink-backlink-submit',
    'adspower-session.json'
  );
}

async function readState(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value?.schemaVersion === 1 ? value : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(
      'The AdsPower session state is invalid; preserve it for inspection.'
    );
  }
}

async function writeState(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function redact(value, secrets) {
  return secrets.reduce(
    (message, secret) =>
      secret ? message.replaceAll(secret, '[redacted]') : message,
    String(value || '')
  );
}

async function apiCall({ apiBase, apiKey, profileId, method, path, body }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const envelope = await response.json().catch(() => null);
    if (!response.ok || envelope?.code !== 0) {
      const message = redact(envelope?.msg || `HTTP ${response.status}`, [
        apiKey,
        profileId,
      ]).slice(0, 300);
      throw new Error(`AdsPower Local API request failed: ${message}`);
    }
    return envelope;
  } finally {
    clearTimeout(timeout);
  }
}

function browserUrl(data) {
  const debugPort = String(data?.debug_port || '').trim();
  const selenium = String(data?.ws?.selenium || '').trim();
  let host = '127.0.0.1';
  let port = debugPort;
  if (selenium) {
    const parsed = new URL(`http://${selenium}`);
    host = parsed.hostname;
    port = parsed.port;
  }
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const numericPort = Number(port);
  if (
    !loopback.has(host) ||
    !/^\d{2,5}$/.test(port) ||
    numericPort < 1 ||
    numericPort > 65_535
  ) {
    throw new Error(
      'AdsPower returned a non-loopback or invalid browser debugging endpoint.'
    );
  }
  return `http://${host === '[::1]' ? '[::1]' : host}:${port}`;
}

async function active(config) {
  const query = new URLSearchParams({ profile_id: config.profileId });
  const response = await apiCall({
    ...config,
    method: 'GET',
    path: `/api/v2/browser-profile/active?${query}`,
  });
  const isActive = response.data?.status === 'Active';
  return {
    active: isActive,
    browserUrl: isActive ? browserUrl(response.data) : null,
  };
}

function publicResult(config, result) {
  return {
    version: CLIENT_VERSION,
    profileAlias: profileAlias(config.profileId),
    ...result,
  };
}

async function status(config) {
  const current = await active(config);
  const state = await readState(config.statePath);
  const owned =
    current.active &&
    state?.profileId === config.profileId &&
    state?.apiBase === config.apiBase;
  return publicResult(config, {
    status: current.active ? 'active' : 'inactive',
    owned,
    browserUrl: current.browserUrl,
  });
}

async function start(config) {
  const current = await active(config);
  if (current.active) {
    const state = await readState(config.statePath);
    const owned =
      state?.profileId === config.profileId &&
      state?.apiBase === config.apiBase;
    return publicResult(config, {
      status: 'active',
      owned,
      reused: true,
      browserUrl: current.browserUrl,
      message: owned
        ? 'Reconnected to the AdsPower profile started by this Skill session.'
        : 'Reused the already-active AdsPower profile without changing or claiming ownership of it.',
    });
  }

  await sleep(LIFECYCLE_INTERVAL_MS);
  const response = await apiCall({
    ...config,
    method: 'POST',
    path: '/api/v2/browser-profile/start',
    body: {
      profile_id: config.profileId,
      headless: '0',
      last_opened_tabs: '0',
      proxy_detection: '0',
      password_filling: '0',
      password_saving: '0',
      cdp_mask: '0',
    },
  });
  const endpoint = browserUrl(response.data);
  const state = {
    schemaVersion: 1,
    sessionId: randomUUID(),
    profileId: config.profileId,
    apiBase: config.apiBase,
    browserUrl: endpoint,
    startedAt: new Date().toISOString(),
  };
  await writeState(config.statePath, state);
  return publicResult(config, {
    status: 'started',
    owned: true,
    reused: false,
    browserUrl: endpoint,
    sessionId: state.sessionId,
  });
}

async function stop(config) {
  const state = await readState(config.statePath);
  if (
    state?.profileId !== config.profileId ||
    state?.apiBase !== config.apiBase
  ) {
    return publicResult(config, {
      status: 'not_owned',
      owned: false,
      stopped: false,
      message:
        'The profile was not started by this Skill session and was left open.',
    });
  }

  const current = await active(config);
  if (!current.active) {
    await rm(config.statePath, { force: true });
    return publicResult(config, {
      status: 'inactive',
      owned: true,
      stopped: false,
    });
  }

  await sleep(LIFECYCLE_INTERVAL_MS);
  await apiCall({
    ...config,
    method: 'POST',
    path: '/api/v2/browser-profile/stop',
    body: { profile_id: config.profileId },
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const next = await active(config);
    if (!next.active) {
      await rm(config.statePath, { force: true });
      return publicResult(config, {
        status: 'stopped',
        owned: true,
        stopped: true,
      });
    }
  }
  throw new Error(
    'AdsPower accepted the stop request but the profile remained active. Preserve the session and inspect it manually.'
  );
}

function usage() {
  return 'Usage: adspower-session.mjs start|status|stop [--profile-id ID] [--api-base http://127.0.0.1:50325]';
}

async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (!['start', 'status', 'stop'].includes(command) || flag('help', args)) {
    throw new Error(usage());
  }
  const config = {
    profileId: requiredProfileId(args),
    apiBase: safeApiBase(
      argument('api-base', args) || process.env.ADSPOWER_API_BASE
    ),
    apiKey: String(process.env.ADSPOWER_API_KEY || ''),
    statePath: defaultStatePath(),
  };
  return command === 'start'
    ? start(config)
    : command === 'stop'
      ? stop(config)
      : status(config);
}

main()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === 'not_owned' ? 2 : 0;
  })
  .catch((error) => {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
