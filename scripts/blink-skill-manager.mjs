#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const CLIENT_VERSION = '1.9.7';
const SKILL_ID = 'backlink-submit';
const MAX_RELEASE_BYTES = 10 * 1024 * 1024;
const DEFAULT_HISTORY_LIMIT = 3;
const DEFAULT_GIT_REPOSITORY =
  'https://github.com/era4d/blinklib-submit-skill.git';
const DEFAULT_GIT_REF = 'main';
const execFileAsync = promisify(execFile);

const scriptPath = fileURLToPath(import.meta.url);
const skillRoot = resolve(dirname(scriptPath), '..');

function argument(name, args = process.argv.slice(2)) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function canonicalContent(files) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(files).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
    )
  );
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeBaseUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Blink app URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('Blink app URL must not contain credentials.');
  }
  return url.toString().replace(/\/$/, '');
}

function safeGitRepository(value) {
  const repository = String(value || '').trim();
  if (!repository) throw new Error('Git repository is missing.');
  if (/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(repository)) {
    return repository;
  }
  let url;
  try {
    url = new URL(repository);
  } catch {
    throw new Error('Git repository must be an HTTPS or GitHub SSH URL.');
  }
  if (
    url.protocol === 'file:' &&
    process.env.BLINK_ALLOW_LOCAL_GIT_SOURCE === '1'
  ) {
    return url.toString();
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Git repository must be an HTTPS URL without credentials.');
  }
  return url.toString();
}

function safeGitRef(value) {
  const ref = String(value || DEFAULT_GIT_REF).trim();
  if (
    !ref ||
    ref.startsWith('-') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.includes('\\') ||
    !/^[A-Za-z0-9._/-]+$/.test(ref)
  ) {
    throw new Error('Git ref is invalid.');
  }
  return ref;
}

async function git(args, options = {}) {
  try {
    return await execFileAsync('git', args, {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 2 ** 20,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`Git update failed${detail ? `: ${detail}` : '.'}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function connectionFor(options = {}) {
  const connectionPath = resolve(
    options.connection ||
      process.env.BLINK_CONFIG ||
      join(skillRoot, 'connection.json')
  );
  const connection = await readJson(connectionPath).catch((error) => {
    if (
      error?.code === 'ENOENT' &&
      process.env.BLINK_APP_URL &&
      process.env.BLINK_API_KEY
    ) {
      return {};
    }
    throw error;
  });
  const appUrl = safeBaseUrl(
    process.env.BLINK_APP_URL || connection.appUrl || ''
  );
  const apiKey = String(process.env.BLINK_API_KEY || connection.apiKey || '');
  if (!apiKey) throw new Error('Blink API key is missing.');
  return { connection, connectionPath, appUrl, apiKey };
}

async function apiRequest(path, options = {}) {
  const { appUrl, apiKey } = await connectionFor(options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${appUrl}${path}`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        'x-blink-client-version': CLIENT_VERSION,
      },
      redirect: 'error',
      signal: controller.signal,
    });
    const envelope = await response.json().catch(() => null);
    if (!response.ok || envelope?.code !== 0) {
      throw new Error(
        envelope?.message || `Blink Skill service returned HTTP ${response.status}`
      );
    }
    return envelope.data;
  } finally {
    clearTimeout(timeout);
  }
}

function validateRelease(release) {
  if (
    !release ||
    release.skillId !== SKILL_ID ||
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    !/^[a-f0-9]{64}$/.test(release.sha256) ||
    !release.files ||
    typeof release.files !== 'object' ||
    Array.isArray(release.files)
  ) {
    throw new Error('Blink returned an invalid Skill release.');
  }

  const entries = Object.entries(release.files);
  if (!entries.length) throw new Error('Blink returned an empty Skill release.');
  for (const [path, content] of entries) {
    const normalized = path.replaceAll('\\', '/');
    if (
      path !== normalized ||
      !path ||
      isAbsolute(path) ||
      normalized.startsWith('/') ||
      normalized.split('/').includes('..') ||
      typeof content !== 'string'
    ) {
      throw new Error(`Blink returned an unsafe Skill path: ${path}`);
    }
  }
  for (const required of [
    'SKILL.md',
    'scripts/blink-automation.mjs',
    'scripts/blink-sequential-runner.mjs',
    'scripts/blink-skill-manager.mjs',
  ]) {
    if (typeof release.files[required] !== 'string') {
      throw new Error(`Blink Skill release is missing ${required}.`);
    }
  }

  const content = canonicalContent(release.files);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_RELEASE_BYTES || bytes !== release.size) {
    throw new Error('Blink Skill release size verification failed.');
  }
  if (sha256(content) !== release.sha256) {
    throw new Error('Blink Skill release hash verification failed.');
  }
  return { ...release, content };
}

async function assertNoSymlinks(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const path = join(current, entry.name);
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      throw new Error(`Git Skill contains a symbolic link: ${path.slice(root.length + 1)}`);
    }
    if (details.isDirectory()) await assertNoSymlinks(root, path);
  }
}

async function validateGitRelease(root) {
  await assertNoSymlinks(root);
  const release = await readJson(join(root, 'skill-release.json')).catch(() => {
    throw new Error('Git Skill is missing skill-release.json.');
  });
  if (
    release?.skillId !== SKILL_ID ||
    !/^\d+\.\d+\.\d+$/.test(String(release.version || ''))
  ) {
    throw new Error('Git Skill release metadata is invalid.');
  }
  for (const required of [
    'SKILL.md',
    'scripts/blink-automation.mjs',
    'scripts/blink-sequential-runner.mjs',
    'scripts/blink-skill-manager.mjs',
  ]) {
    const details = await stat(join(root, ...required.split('/'))).catch(() => null);
    if (!details?.isFile()) throw new Error(`Git Skill is missing ${required}.`);
  }
  return release;
}

async function writeInstallationMetadata(stageRoot, metadata) {
  await writeFile(
    join(stageRoot, '.blink-release.json'),
    `${JSON.stringify(
      {
        skillId: SKILL_ID,
        ...metadata,
        installedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
}

async function writeRelease(stageRoot, release, connection, options = {}) {
  for (const [path, content] of Object.entries(release.files)) {
    const target = resolve(stageRoot, ...path.split('/'));
    if (!target.startsWith(stageRoot + sep)) {
      throw new Error(`Refusing to write outside the staged Skill: ${path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
  }
  const nextConnection = {
    ...connection,
    clientVersion: release.version,
    updateSource: 'api',
  };
  delete nextConnection.gitRepository;
  delete nextConnection.gitRef;
  if (options.pinVersion) nextConnection.pinnedVersion = options.pinVersion;
  else delete nextConnection.pinnedVersion;
  await writeFile(
    join(stageRoot, 'connection.json'),
    `${JSON.stringify(nextConnection, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  await writeInstallationMetadata(stageRoot, {
    version: release.version,
    source: 'api',
    sha256: release.sha256,
  });
}

async function historyEntries(historyRoot) {
  const entries = await readdir(historyRoot, { withFileTypes: true }).catch(
    () => []
  );
  const histories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(historyRoot, entry.name);
    const metadata = await readJson(join(path, '.blink-release.json')).catch(
      async () => {
        const connection = await readJson(join(path, 'connection.json')).catch(
          () => ({})
        );
        return { version: connection.clientVersion || 'unknown' };
      }
    );
    const details = await stat(path);
    histories.push({
      path,
      name: entry.name,
      version: String(metadata.version || 'unknown'),
      mtimeMs: details.mtimeMs,
    });
  }
  return histories.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function pruneHistory(historyRoot, keep = DEFAULT_HISTORY_LIMIT) {
  const histories = await historyEntries(historyRoot);
  const limit =
    Number.isInteger(keep) && keep >= 1
      ? Math.min(keep, 20)
      : DEFAULT_HISTORY_LIMIT;
  for (const stale of histories.slice(limit)) {
    await rm(stale.path, { recursive: true, force: true });
  }
}

function safeVersion(value) {
  return /^\d+\.\d+\.\d+$/.test(value) ? value : 'unknown';
}

async function activateRelease(release, options = {}) {
  const validated = validateRelease(release);
  const { connection } = await connectionFor(options);
  const parent = dirname(skillRoot);
  const historyRoot = join(parent, `.${SKILL_ID}-history`);
  const stageRoot = join(parent, `.${SKILL_ID}-stage-${randomUUID()}`);
  const backup = join(
    historyRoot,
    `${safeVersion(CLIENT_VERSION)}-${Date.now()}-${randomUUID()}`
  );
  await mkdir(historyRoot, { recursive: true, mode: 0o700 });
  await mkdir(stageRoot, { recursive: true });

  try {
    await writeRelease(stageRoot, validated, connection, {
      pinVersion: options.version ? validated.version : undefined,
    });
    await rename(skillRoot, backup);
    try {
      await rename(stageRoot, skillRoot);
    } catch (error) {
      await rename(backup, skillRoot).catch(() => undefined);
      throw error;
    }
    await pruneHistory(historyRoot, options.keep).catch(() => undefined);
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    action: 'updated',
    fromVersion: CLIENT_VERSION,
    version: validated.version,
    sha256: validated.sha256,
    skillRoot,
  };
}

function gitSourceFor(connection, options = {}) {
  return {
    repository: safeGitRepository(
      options.repository || connection.gitRepository || DEFAULT_GIT_REPOSITORY
    ),
    ref: safeGitRef(
      options.ref ||
        (options.version ? `v${options.version}` : undefined) ||
        connection.gitRef ||
        DEFAULT_GIT_REF
    ),
  };
}

async function remoteGitCommit(repository, ref) {
  const candidates = [
    ref,
    `refs/heads/${ref}`,
    `refs/tags/${ref}^{}`,
    `refs/tags/${ref}`,
  ];
  const { stdout } = await git([
    'ls-remote',
    '--exit-code',
    repository,
    ...candidates,
  ]);
  const rows = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(/\s+/, 2));
  const peeled = rows.find(([, name]) => name?.endsWith('^{}'));
  const commit = peeled?.[0] || rows[0]?.[0];
  if (!/^[a-f0-9]{40,64}$/.test(String(commit || ''))) {
    throw new Error(`Git ref was not found: ${ref}`);
  }
  return commit;
}

async function cloneGitRelease(repository, ref, stageRoot) {
  await git([
    'clone',
    '--depth',
    '1',
    '--single-branch',
    '--branch',
    ref,
    '--',
    repository,
    stageRoot,
  ]);
  const release = await validateGitRelease(stageRoot);
  const { stdout } = await git(['-C', stageRoot, 'rev-parse', 'HEAD']);
  const commit = stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) {
    throw new Error('Git Skill commit verification failed.');
  }
  return { release, commit };
}

async function inspectGitRelease(options = {}) {
  const { connection } = await connectionFor(options);
  const { repository, ref } = gitSourceFor(connection, options);
  const stageRoot = join(
    dirname(skillRoot),
    `.${SKILL_ID}-git-check-${randomUUID()}`
  );
  try {
    const { release, commit } = await cloneGitRelease(
      repository,
      ref,
      stageRoot
    );
    const installed = await readJson(join(skillRoot, '.blink-release.json')).catch(
      () => ({})
    );
    return {
      skillId: SKILL_ID,
      source: 'git',
      repository,
      ref,
      version: release.version,
      commit,
      currentVersion: CLIENT_VERSION,
      currentCommit: installed.gitCommit || null,
      updateAvailable:
        release.version !== CLIENT_VERSION || installed.gitCommit !== commit,
    };
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function activateGitRelease(stageRoot, details, connection, options = {}) {
  const parent = dirname(skillRoot);
  const historyRoot = join(parent, `.${SKILL_ID}-history`);
  const backup = join(
    historyRoot,
    `${safeVersion(CLIENT_VERSION)}-${Date.now()}-${randomUUID()}`
  );
  const nextConnection = {
    ...connection,
    clientVersion: details.release.version,
    updateSource: 'git',
    gitRepository: details.repository,
    gitRef: details.ref,
  };
  if (options.version || options.pin) {
    nextConnection.pinnedVersion = details.release.version;
  } else {
    delete nextConnection.pinnedVersion;
  }
  await writeFile(
    join(stageRoot, 'connection.json'),
    `${JSON.stringify(nextConnection, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  await writeInstallationMetadata(stageRoot, {
    version: details.release.version,
    source: 'git',
    repository: details.repository,
    gitRef: details.ref,
    gitCommit: details.commit,
  });
  await mkdir(historyRoot, { recursive: true, mode: 0o700 });
  try {
    await rename(skillRoot, backup);
    try {
      await rename(stageRoot, skillRoot);
    } catch (error) {
      await rename(backup, skillRoot).catch(() => undefined);
      throw error;
    }
    await pruneHistory(historyRoot, options.keep).catch(() => undefined);
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    action: 'updated',
    source: 'git',
    fromVersion: CLIENT_VERSION,
    version: details.release.version,
    repository: details.repository,
    ref: details.ref,
    commit: details.commit,
    skillRoot,
  };
}

async function synchronizeGitInstalledSkill(options = {}) {
  const { connection, connectionPath } = await connectionFor(options);
  const { repository, ref } = gitSourceFor(connection, options);
  const installed = await readJson(join(skillRoot, '.blink-release.json')).catch(
    () => ({})
  );
  const remoteCommit = await remoteGitCommit(repository, ref);
  if (
    installed.source === 'git' &&
    installed.repository === repository &&
    installed.gitRef === ref &&
    installed.gitCommit === remoteCommit
  ) {
    return {
      action: 'current',
      source: 'git',
      version: CLIENT_VERSION,
      repository,
      ref,
      commit: remoteCommit,
      skillRoot,
    };
  }

  const localCommit = await git(['-C', skillRoot, 'rev-parse', 'HEAD'])
    .then(({ stdout }) => stdout.trim())
    .catch(() => null);
  if (localCommit === remoteCommit) {
    const localRelease = await validateGitRelease(skillRoot);
    if (localRelease.version !== CLIENT_VERSION) {
      throw new Error(
        `Git checkout metadata says ${localRelease.version}, but the running Skill says ${CLIENT_VERSION}.`
      );
    }
    const nextConnection = {
      ...connection,
      clientVersion: CLIENT_VERSION,
      updateSource: 'git',
      gitRepository: repository,
      gitRef: ref,
    };
    if (options.version || options.pin) {
      nextConnection.pinnedVersion = CLIENT_VERSION;
    } else {
      delete nextConnection.pinnedVersion;
    }
    await writeFile(
      connectionPath,
      `${JSON.stringify(nextConnection, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    await writeInstallationMetadata(skillRoot, {
      version: CLIENT_VERSION,
      source: 'git',
      repository,
      gitRef: ref,
      gitCommit: remoteCommit,
    });
    return {
      action: 'current',
      source: 'git',
      adoptedCheckout: true,
      version: CLIENT_VERSION,
      repository,
      ref,
      commit: remoteCommit,
      skillRoot,
    };
  }

  const stageRoot = join(parentOf(skillRoot), `.${SKILL_ID}-git-${randomUUID()}`);
  try {
    const cloned = await cloneGitRelease(repository, ref, stageRoot);
    if (
      installed.source === 'git' &&
      installed.gitCommit &&
      cloned.release.version === CLIENT_VERSION
    ) {
      throw new Error(
        `Git Skill changed at ${ref} without a version bump; publish a new version before updating.`
      );
    }
    return await activateGitRelease(
      stageRoot,
      { ...cloned, repository, ref },
      connection,
      options
    );
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function parentOf(path) {
  return dirname(path);
}

export async function getSkillUpdateManifest(options = {}) {
  return apiRequest('/api/backlink-automation/skill', options);
}

export async function getConfiguredUpdateStatus(options = {}) {
  const { connection } = await connectionFor(options);
  const source = String(options.source || connection.updateSource || 'api');
  if (source === 'git') return inspectGitRelease(options);
  if (source === 'api') return getSkillUpdateManifest(options);
  throw new Error('Update source must be api or git.');
}

export async function synchronizeInstalledSkill(options = {}) {
  const { connection, connectionPath } = await connectionFor(options);
  const pinnedVersion = String(connection.pinnedVersion || '');
  if (options.automatic && pinnedVersion === CLIENT_VERSION) {
    return {
      action: 'pinned',
      version: CLIENT_VERSION,
      pinnedVersion,
      skillRoot,
    };
  }
  const source = String(options.source || connection.updateSource || 'api');
  if (source === 'git') {
    return synchronizeGitInstalledSkill(options);
  }
  if (source !== 'api') {
    throw new Error('Update source must be api or git.');
  }
  const manifest = await getSkillUpdateManifest(options);
  const targetVersion = String(options.version || manifest.defaultVersion || '');
  if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
    throw new Error('Blink did not provide a valid default Skill version.');
  }
  if (targetVersion === CLIENT_VERSION) {
    if (!options.automatic && Object.keys(connection).length) {
      const nextConnection = {
        ...connection,
        clientVersion: CLIENT_VERSION,
        updateSource: 'api',
      };
      delete nextConnection.gitRepository;
      delete nextConnection.gitRef;
      if (options.version) nextConnection.pinnedVersion = CLIENT_VERSION;
      else delete nextConnection.pinnedVersion;
      await writeFile(
        connectionPath,
        `${JSON.stringify(nextConnection, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 }
      );
    }
    return {
      action: options.version ? 'pinned' : 'current',
      version: CLIENT_VERSION,
      latestVersion: manifest.latestVersion,
      defaultVersion: manifest.defaultVersion,
      skillRoot,
    };
  }
  const release = await apiRequest(
    `/api/backlink-automation/skill/${encodeURIComponent(targetVersion)}`,
    options
  );
  return activateRelease(release, options);
}

export async function rollbackInstalledSkill(options = {}) {
  const parent = dirname(skillRoot);
  const historyRoot = join(parent, `.${SKILL_ID}-history`);
  const histories = await historyEntries(historyRoot);
  const selected = options.version
    ? histories.find((entry) => entry.version === options.version)
    : histories[0];
  if (!selected) {
    throw new Error(
      options.version
        ? `Local Skill version ${options.version} is not available for rollback.`
        : 'No local Skill rollback version is available.'
    );
  }

  const selectedConnectionPath = join(selected.path, 'connection.json');
  const selectedConnection = await readJson(selectedConnectionPath);
  await writeFile(
    selectedConnectionPath,
    `${JSON.stringify(
      {
        ...selectedConnection,
        clientVersion: selected.version,
        pinnedVersion: selected.version,
      },
      null,
      2
    )}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );

  const displaced = join(
    historyRoot,
    `${safeVersion(CLIENT_VERSION)}-${Date.now()}-${randomUUID()}`
  );
  await rename(skillRoot, displaced);
  try {
    await rename(selected.path, skillRoot);
  } catch (error) {
    await rename(displaced, skillRoot).catch(() => undefined);
    throw error;
  }
  await pruneHistory(historyRoot, options.keep).catch(() => undefined);
  return {
    action: 'rolled_back',
    fromVersion: CLIENT_VERSION,
    version: selected.version,
    skillRoot,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'check';
  const options = {
    connection: argument('connection', args),
    version: argument('version', args),
    source: argument('source', args),
    repository:
      argument('repo', args) || argument('repository', args),
    ref: argument('ref', args),
    keep: Number(argument('keep', args) || DEFAULT_HISTORY_LIMIT),
  };

  let result;
  if (command === 'check' || command === 'versions') {
    result = await getConfiguredUpdateStatus(options);
  } else if (command === 'git-check') {
    result = await inspectGitRelease({ ...options, source: 'git' });
  } else if (command === 'git-update') {
    result = await synchronizeInstalledSkill({
      ...options,
      source: 'git',
      pin: Boolean(options.ref || options.version),
    });
  } else if (command === 'update' || command === 'sync') {
    result = await synchronizeInstalledSkill(options);
  } else if (command === 'rollback') {
    result = await rollbackInstalledSkill(options);
  } else {
    throw new Error(
      'Usage: check [--source api|git] | versions | update [--source api|git] [--version X.Y.Z] | git-check [--ref REF] | git-update [--ref REF] | rollback [--version X.Y.Z] [--keep N]'
    );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
