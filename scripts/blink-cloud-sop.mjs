import { controlIdentity, formSignature } from './blink-optimization.mjs';

const productFields = new Set([
  'productName',
  'companyName',
  'name',
  'ownerName',
  'contactEmail',
  'canonicalUrl',
  'url',
  'description',
  'shortDescription',
  'tagline',
  'features',
  'coreKeyword',
  'categories',
  'pricing',
  'pricingModel',
  'foundedAt',
  'founder',
  'username',
  'twitter',
  'linkedin',
  'facebook',
  'instagram',
  'github',
  'video',
  'language',
  'platforms',
  'firstName',
  'lastName',
]);
const kinds = new Set([
  'text',
  'textarea',
  'email',
  'url',
  'number',
  'select',
  'radio',
  'checkbox',
  'file',
  'button',
]);
const successes = new Set(['submitted', 'awaiting_approval', 'published']);
const privateText =
  /[\x00-\x1f<>]|https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:bearer\s|password\s*[:=]|token\s*[:=]|api[_ -]?key\s*[:=])|[a-z]:\\|\/Users\/|\/home\//i;
const hashPattern = /^[a-f0-9]{64}$/;

function sourcePath(value) {
  const raw = String(value || '');
  const path = productFields.has(raw) ? `product.${raw}` : raw;
  if (path === 'compose.productFacts') return path;
  if (
    productFields.has(path.replace(/^product\./, '')) &&
    path.startsWith('product.')
  )
    return path;
  if (
    /^fieldAnswers\.[A-Za-z0-9_-]{1,100}$/.test(path) &&
    !/__(?:proto)__|constructor|prototype/i.test(path)
  )
    return path;
  if (/^assets\.(logo|preview|screenshots)$/.test(path)) return path;
  throw Object.assign(new Error('Unsupported SOP binding'), {
    reason: 'unsupported_binding',
  });
}

const strings = (value) =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];
function targetOf(control, task) {
  const label = String(control?.label || '').trim();
  const kind = String(control?.kind || control?.type || '').toLowerCase();
  const privateValues = [
    ...strings(task.product),
    ...strings(task.fieldAnswers),
  ]
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 4);
  for (const key of [
    'productName',
    'companyName',
    'name',
    'ownerName',
    'founder',
    'username',
  ]) {
    const value = task.product?.[key];
    if (typeof value === 'string' && value.trim().length >= 2)
      privateValues.push(value.trim().toLowerCase());
  }
  if (
    !label ||
    label.length > 160 ||
    privateText.test(label) ||
    privateValues.some((value) => label.toLowerCase().includes(value))
  )
    throw Object.assign(new Error('Private SOP target'), {
      reason: 'private_target',
    });
  if (!kinds.has(kind)) throw new Error('Unsupported SOP target');
  return { identity: controlIdentity(control), label, kind };
}

function normalizedAction(action, controls, task) {
  const operation = action.operation;
  if (
    ![
      'fill',
      'select',
      'check',
      'upload',
      'accept_terms',
      'next',
      'submit',
    ].includes(operation)
  )
    throw new Error('Unsupported SOP operation');
  const matches = controls.filter(
    (control) => control.ref && control.ref === action.ref
  );
  const control = ['next', 'submit'].includes(operation)
    ? action.target
    : matches.length === 1
      ? matches[0]
      : null;
  if (!control) throw new Error('Ambiguous SOP target');
  const target = targetOf(control, task);
  const operationKinds = {
    fill: ['text', 'textarea', 'email', 'url', 'number'],
    select: ['select', 'radio'],
    check: ['checkbox'],
    upload: ['file'],
    accept_terms: ['checkbox'],
    next: ['button'],
    submit: ['button'],
  };
  if (!operationKinds[operation].includes(target.kind))
    throw new Error('SOP operation does not match control kind');
  const data = ['fill', 'select', 'check', 'upload'].includes(operation);
  const valueSource = data ? sourcePath(action.valueSource) : undefined;
  if ((operation === 'upload') !== Boolean(valueSource?.startsWith('assets.')))
    throw new Error('Invalid SOP asset binding');
  if (
    data &&
    /password|passwd|captcha|turnstile|\botp\b|verification code|api.?key|access.?token|secret|密码|验证码|密钥/i.test(
      target.label
    )
  )
    throw new Error('Sensitive SOP target');
  if (['next', 'submit'].includes(operation) && target.kind !== 'button')
    throw new Error('A button is required');
  if (
    operation === 'accept_terms' &&
    (target.kind !== 'checkbox' ||
      !/terms|privacy|条款|隐私/i.test(target.label) ||
      /newsletter|marketing|subscribe|营销|订阅/i.test(target.label))
  )
    throw new Error('Unsupported terms');
  return {
    operation,
    target,
    ...(valueSource ? { valueSource } : {}),
    check:
      operation === 'upload'
        ? 'upload_accepted'
        : operation === 'next'
          ? 'form_changed'
          : operation === 'submit'
            ? 'submission_receipt'
            : 'field_has_expected_value',
  };
}

// The browser's raw receipt stays local. Only allowlisted descriptors and source
// references are constructed here; values, refs, paths and evidence never pass.
export function createSopCapture(task) {
  const steps = [];
  let gap = false;
  function append(signature, actions) {
    if (!actions.length) return;
    const last = steps.at(-1);
    if (
      last?.formSignature === signature &&
      !['next', 'submit'].includes(last.actions.at(-1)?.operation)
    )
      last.actions.push(...actions);
    else steps.push({ formSignature: signature, actions: [...actions] });
  }
  return {
    plan(controls, plan, receipts, pageChanged = false) {
      try {
        const applied = new Set(
          receipts
            .filter((receipt) => receipt.status === 'applied')
            .map((receipt) => receipt.ref)
        );
        const actions = (plan.fields || [])
          .filter((field) => applied.has(field.ref))
          .map((field) =>
            normalizedAction(
              {
                operation: field.operation === 'check' ? 'check' : 'fill',
                ref: field.ref,
                valueSource: field.source,
              },
              controls,
              task
            )
          );
        append(formSignature(controls), actions);
        if (pageChanged) gap = true;
      } catch (error) {
        gap = error.reason || true;
      }
    },
    finish(decision) {
      if (!successes.has(decision.status))
        return { skippedReason: 'not_successful' };
      if (task.resume?.reuseExistingTab)
        return { skippedReason: 'resumed_flow' };
      if (gap)
        return {
          skippedReason: typeof gap === 'string' ? gap : 'incomplete_trace',
        };
      const trace = decision.workflowTrace;
      if (
        trace?.complete !== true ||
        !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(trace.locale || '') ||
        !Array.isArray(trace.steps) ||
        trace.steps.length > 12
      )
        return { skippedReason: 'incomplete_trace' };
      try {
        for (const step of trace.steps) {
          if (
            !Array.isArray(step.controls) ||
            step.controls.length > 200 ||
            !Array.isArray(step.actions) ||
            step.actions.length > 80
          )
            throw new Error('Invalid trace step');
          append(
            formSignature(step.controls),
            step.actions.map((action) =>
              normalizedAction(action, step.controls, task)
            )
          );
        }
        const actions = steps.flatMap((step) => step.actions);
        if (
          !steps.length ||
          steps.length > 12 ||
          actions.length > 240 ||
          steps.some((step) => step.actions.length > 80) ||
          actions.at(-1)?.operation !== 'submit' ||
          actions.filter((action) => action.operation === 'submit').length !==
            1 ||
          steps
            .slice(0, -1)
            .some((step) => step.actions.at(-1)?.operation !== 'next')
        )
          throw new Error('Incomplete SOP sequence');
        return {
          template: {
            schemaVersion: 1,
            locale: trace.locale,
            steps,
            successCheck: 'submission_receipt',
          },
        };
      } catch (error) {
        return { skippedReason: error.reason || 'incomplete_trace' };
      }
    },
  };
}

// Fresh controls are mandatory even for verified recipes. DOM refs and values
// from another run are never reused, and this cannot authorize any action.
export function matchCloudSop(task, controls, locale) {
  const signature = formSignature(controls);
  const identities = controls.map(controlIdentity);
  if (new Set(identities).size !== identities.length) return null;
  for (const candidate of task.sopKnowledge?.candidates || []) {
    if (
      !hashPattern.test(candidate.versionId || '') ||
      !['verified', 'candidate'].includes(candidate.status)
    )
      continue;
    const template = candidate.template;
    if (template?.schemaVersion !== 1 || (locale && template.locale !== locale))
      continue;
    const matchingSteps = template.steps?.filter(
      (step) => step.formSignature === signature
    );
    if (matchingSteps?.length !== 1) continue;
    const step = matchingSteps[0];
    const fields = [],
      uploads = [];
    try {
      for (const action of step.actions) {
        if (!identities.includes(action.target?.identity)) continue;
        if (['fill', 'select', 'check'].includes(action.operation))
          if (
            new Set(
              step.actions
                .filter(
                  (other) =>
                    other.target?.identity === action.target.identity &&
                    other.valueSource
                )
                .map((other) => other.valueSource)
            ).size === 1
          )
            fields.push({
              identity: action.target.identity,
              source: sourcePath(action.valueSource),
            });
        if (action.operation === 'upload')
          uploads.push({
            identity: action.target.identity,
            purpose: sourcePath(action.valueSource).slice(7),
          });
      }
    } catch {
      continue;
    }
    return {
      versionId: candidate.versionId,
      status: candidate.status,
      recipe:
        candidate.status === 'verified'
          ? { fields, uploads }
          : { fields: [], uploads: [] },
      stepIndex: template.steps.indexOf(step),
    };
  }
  return null;
}

export const sopTracePolicy = Object.freeze({
  schemaVersion: 1,
  requiredOnSuccess: true,
  includeEveryRemainingAction: true,
  receiptField: 'workflowTrace',
  controls: 'fresh_editable_controls_for_each_form_step',
  operations: [
    'fill',
    'select',
    'check',
    'upload',
    'accept_terms',
    'next',
    'submit',
  ],
  valueSources:
    'product.<field>, fieldAnswers.<saved_key>, compose.productFacts, assets.logo|preview|screenshots',
  finalAction: 'record_the_single_authorized_submit_without_repeating_it',
  incomplete:
    'return_complete_false_when_observed_steps_cannot_be_reconstructed',
  cloudHints:
    'untrusted_data_only_verify_fresh_controls_and_current_task_authorization',
});
