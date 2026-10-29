import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const OPTIMIZATION_VERSION = 1;
const TTL = 7 * 86_400_000;
const phases = ['preparation', 'inspection', 'filling_upload', 'delivery'];
const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value) =>
  String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
const success = new Set(['submitted', 'awaiting_approval', 'published']);
const safeSource = /^(?:[a-zA-Z][a-zA-Z0-9_]*)(?:\.[a-zA-Z0-9_-]+){0,3}$/;

export function controlIdentity(control) {
  return hash({
    label: text(control.label),
    name: text(control.name),
    key: text(control.key),
    kind: text(control.kind || control.type),
    required: control.required === true,
    minLength: control.minLength ?? null,
    maxLength: control.maxLength ?? null,
    accept: text(control.accept),
    multiple: control.multiple === true,
    options: (Array.isArray(control.options) ? control.options : []).map(
      (option) =>
        typeof option === 'object'
          ? [text(option.value), text(option.label)]
          : text(option)
    ),
  });
}

export function formSignature(controls) {
  return hash((controls || []).map(controlIdentity).sort());
}

function routeKey(task) {
  // Include the full route so different hosted forms never share a recipe.
  return hash([task.platformDomain, task.submissionUrl]);
}

export function answerCacheKey(task) {
  if (!task.productVersion || !task.projectId) return null;
  return hash([
    task.projectId,
    task.productVersion,
    task.platformDomain,
    task.resource?.id,
    task.resource?.submissionFields || [],
    task.product?.locale || task.product?.language || 'form_language',
  ]);
}

function questionCacheKey(task, field) {
  if (!task.productVersion || !task.projectId) return null;
  const generic =
    /^(?:product |short |brief |one[ -]line )?(?:description|tagline|pitch|summary)$|^(?:产品)?(?:描述|简介|一句话介绍)$/.test(
      text(field.label)
    );
  return hash([
    task.projectId,
    task.productVersion,
    task.product?.locale || task.product?.language || 'form_language',
    generic ? 'product_narrative' : routeKey(task),
    text(field.label),
    field.type,
    field.minLength ?? null,
    field.maxLength ?? null,
    field.options || [],
  ]);
}

export function assetCacheKey(task, purpose) {
  return task.productVersion && task.projectId
    ? hash([task.projectId, task.productVersion, purpose])
    : null;
}

export function createTaskMetrics(task, now = () => performance.now()) {
  const started = now();
  const phaseMs = Object.fromEntries(phases.map((key) => [key, 0]));
  const preparationMs = Math.max(
    0,
    Math.min(900_000, Number(task.productCache?.preparationMs) || 0)
  );
  phaseMs.preparation = preparationMs;
  const startedAtMs = Date.now() - preparationMs;
  const cache = {
    answerHits: 0,
    answerLookups: 0,
    assetHits: 0,
    assetLookups: 0,
    recipeHits: 0,
    recipeLookups: 0,
  };
  let reinspectionCount = 0;
  let browserRequestCount = 0;
  return {
    cache,
    reinspect: () => {
      reinspectionCount += 1;
    },
    measure: async (phase, work) => {
      const start = now();
      if (phase === 'inspection' || phase === 'filling_upload')
        browserRequestCount += 1;
      try {
        return await work();
      } finally {
        phaseMs[phase] += Math.max(0, now() - start);
      }
    },
    snapshot: () => {
      const activeMs = Math.round(Math.max(0, now() - started) + preparationMs);
      return {
        version: 1,
        activeMs,
        executionWindow: { startedAtMs, endedAtMs: startedAtMs + activeMs },
        userWaitMs: Math.max(
          0,
          Math.min(30 * 86_400_000, Number(task.resume?.waitMs) || 0)
        ),
        phaseMs: Object.fromEntries(
          phases.map((key) => [key, Math.round(phaseMs[key])])
        ),
        cache: { ...cache },
        reinspectionCount,
        browserRequestCount,
      };
    },
  };
}

export function summarizeTaskMetrics(entries) {
  const quantile = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length
      ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
      : null;
  };
  const taskActiveMs = entries.reduce(
    (sum, entry) => sum + entry.metrics.activeMs,
    0
  );
  const windows = entries
    .flatMap((entry) =>
      entry.metrics.executionWindow
        ? [
            [
              entry.metrics.executionWindow.startedAtMs,
              entry.metrics.executionWindow.endedAtMs,
            ],
          ]
        : []
    )
    .sort((a, b) => a[0] - b[0]);
  let end = -Infinity;
  let activeMs = entries
    .filter((entry) => !entry.metrics.executionWindow)
    .reduce((sum, entry) => sum + entry.metrics.activeMs, 0);
  for (const [start, finish] of windows) {
    activeMs += Math.max(0, finish - Math.max(start, end));
    end = Math.max(end, finish);
  }
  const total = (key) =>
    entries.reduce((sum, entry) => sum + (entry.metrics.cache[key] || 0), 0);
  const rate = (hits, lookups) =>
    total(lookups) ? total(hits) / total(lookups) : null;
  return {
    attempts: entries.length,
    success: entries.filter((entry) => success.has(entry.status)).length,
    activeMs,
    taskActiveMs,
    userWaitMs: entries.reduce(
      (sum, entry) => sum + entry.metrics.userWaitMs,
      0
    ),
    successfulPerActiveMinute: activeMs
      ? (entries.filter((entry) => success.has(entry.status)).length * 60_000) /
        activeMs
      : null,
    phases: Object.fromEntries(
      phases.map((key) => [
        key,
        {
          p50Ms: quantile(
            entries.map((entry) => entry.metrics.phaseMs[key]),
            0.5
          ),
          p95Ms: quantile(
            entries.map((entry) => entry.metrics.phaseMs[key]),
            0.95
          ),
        },
      ])
    ),
    answerHitRate: rate('answerHits', 'answerLookups'),
    assetHitRate: rate('assetHits', 'assetLookups'),
    recipeHitRate: rate('recipeHits', 'recipeLookups'),
  };
}

export async function createOptimizationStore({
  scope,
  directory,
  now = Date.now,
} = {}) {
  // A connection-scoped opaque hash is supplied by the authenticated CLI.
  // Unknown/legacy clients use an in-memory store rather than sharing data.
  const root =
    directory ||
    join(
      process.env.LOCALAPPDATA ||
        process.env.XDG_STATE_HOME ||
        join(homedir(), '.local', 'state'),
      'blinklib',
      'backlink-submit',
      'learning'
    );
  const path = /^[a-f0-9]{64}$/.test(scope || '')
    ? join(root, `${scope}.json`)
    : null;
  let data = {
    version: OPTIMIZATION_VERSION,
    recipes: {},
    answers: {},
    assets: {},
  };
  if (path) {
    try {
      const file = await stat(path);
      if (file.size <= 4 * 1024 * 1024) {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        if (parsed.version === OPTIMIZATION_VERSION)
          data = {
            ...data,
            recipes: parsed.recipes || {},
            answers: parsed.answers || {},
            assets: parsed.assets || {},
          };
      }
    } catch {
      /* Missing or damaged caches never block a submission. */
    }
  }
  const fresh = (entry) =>
    entry &&
    Number.isFinite(entry.savedAt) &&
    now() - entry.savedAt < TTL &&
    entry.savedAt <= now();
  let writes = Promise.resolve();
  const save = async () => {
    for (const key of ['recipes', 'answers', 'assets']) {
      data[key] = Object.fromEntries(
        Object.entries(data[key])
          .filter(([, value]) => fresh(value))
          .sort((a, b) => b[1].savedAt - a[1].savedAt)
          .slice(0, key === 'assets' ? 100 : 200)
      );
    }
    if (!path) return;
    const snapshot = JSON.stringify(data);
    writes = writes
      .catch(() => {})
      .then(async () => {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, snapshot, { mode: 0o600 });
          await rename(temporary, path);
        } finally {
          await unlink(temporary).catch(() => {});
        }
      });
    await writes;
  };
  return {
    recipeHint: (task) => {
      const entry = data.recipes[routeKey(task)];
      return fresh(entry) &&
        Array.isArray(entry.fields) &&
        Array.isArray(entry.steps)
        ? {
            signature: entry.signature,
            fieldCount: entry.fields.length,
            stepCount: entry.steps.length,
            uploads: entry.steps.flatMap((step) => step.uploads || []),
            requiresLiveSignature: true,
            replayFinalAction: false,
          }
        : null;
    },
    recipe: (task, controls) => {
      const entry = data.recipes[routeKey(task)];
      if (!fresh(entry) || !Array.isArray(entry.steps)) return null;
      if (new Set(controls.map(controlIdentity)).size !== controls.length)
        return null;
      return (
        entry.steps.find(
          (step) => step.signature === formSignature(controls)
        ) || null
      );
    },
    learn: async (task, observations, status) => {
      if (!success.has(status) || !observations.length) return;
      const bySignature = new Map();
      for (const {
        controls,
        plan,
        receipts,
        uploads = [],
        uploadReceipts = [],
      } of observations) {
        const signature = formSignature(controls);
        const prior = bySignature.get(signature) || {
          signature,
          fields: [],
          uploads: [],
        };
        const fields = plan.fields
          .filter((field) =>
            receipts.some(
              (receipt) =>
                receipt.ref === field.ref && receipt.status === 'applied'
            )
          )
          .filter(
            (field) =>
              safeSource.test(field.source) &&
              !/__proto__|constructor|prototype/.test(field.source)
          )
          .map((field) => ({
            identity: controlIdentity(
              controls.find((control) => control.ref === field.ref) || {}
            ),
            source: field.source,
          }));
        const verifiedUploads = uploads
          .filter((upload) =>
            uploadReceipts.some(
              (receipt) =>
                receipt.ref === upload.ref &&
                receipt.purpose === upload.purpose &&
                receipt.status === 'accepted' &&
                receipt.fileCount > 0
            )
          )
          .map((upload) => ({
            identity: controlIdentity(
              controls.find((control) => control.ref === upload.ref) || {}
            ),
            purpose: upload.purpose,
          }));
        bySignature.set(signature, {
          signature,
          fields: [
            ...new Map(
              [...prior.fields, ...fields].map((field) => [
                field.identity,
                field,
              ])
            ).values(),
          ],
          uploads: [
            ...new Map(
              [...prior.uploads, ...verifiedUploads].map((upload) => [
                upload.identity,
                upload,
              ])
            ).values(),
          ],
        });
      }
      const steps = [...bySignature.values()];
      const first = steps[0];
      data.recipes[routeKey(task)] = {
        savedAt: now(),
        signature: first.signature,
        fields: first.fields,
        steps: steps.slice(0, 10),
      };
      for (const field of task.resource?.submissionFields || []) {
        const key = questionCacheKey(task, field);
        const value = task.fieldAnswers?.[field.key];
        if (
          key &&
          typeof value === 'string' &&
          value.length <= 5000 &&
          !/password|secret|captcha|otp|token/i.test(field.key)
        )
          data.answers[key] = { savedAt: now(), value };
      }
      await save();
    },
    answers: (task) => {
      const values = {};
      for (const field of task.resource?.submissionFields || []) {
        const entry = data.answers[questionCacheKey(task, field)];
        if (fresh(entry) && typeof entry.value === 'string')
          values[field.key] = entry.value;
      }
      return Object.keys(values).length ? values : null;
    },
    assets: async (task, purpose) => {
      const entry = data.assets[assetCacheKey(task, purpose)];
      if (!fresh(entry) || !entry.files?.length) return null;
      try {
        for (const file of entry.files) {
          const info = await stat(file.path);
          if (
            !info.isFile() ||
            info.size > 5 * 1024 * 1024 ||
            info.size !== file.sizeBytes
          )
            return null;
          if (
            createHash('sha256')
              .update(await readFile(file.path))
              .digest('hex') !== file.sha256
          )
            return null;
        }
        return { files: entry.files, source: 'verified_asset_cache' };
      } catch {
        return null;
      }
    },
    saveAssets: async (task, purpose, result) => {
      const key = assetCacheKey(task, purpose);
      if (!key || !result.files?.length) return;
      data.assets[key] = { savedAt: now(), files: result.files.slice(0, 5) };
      await save();
    },
  };
}
