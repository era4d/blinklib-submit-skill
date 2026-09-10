import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const RESULT_STATUSES = new Set([
  'submitted',
  'awaiting_approval',
  'awaiting_email_verification',
  'published',
  'submission_outcome_unknown',
  'submission_failed',
  'awaiting_user_login',
  'blocked_user_action',
  'blocked_missing_data',
  'blocked_execution_backend',
  'paid_only',
  'ineligible',
  'unavailable',
  'cancelled',
]);

const SUPPORTED_ROUTES = new Set([
  'directory_listing',
  'request_app',
  'claim_listing',
  'account_profile',
]);

const RESULT_PHASES = {
  submitted: new Set(['confirmation', 'follow_up']),
  awaiting_approval: new Set(['confirmation', 'follow_up']),
  awaiting_email_verification: new Set(['confirmation', 'follow_up']),
  published: new Set(['follow_up']),
  submission_outcome_unknown: new Set(['confirmation', 'follow_up']),
  submission_failed: new Set(['confirmation', 'follow_up']),
  awaiting_user_login: new Set(['verification', 'form']),
  blocked_user_action: new Set(['verification', 'form', 'confirmation']),
  blocked_missing_data: new Set(['eligibility', 'form']),
  blocked_execution_backend: new Set(['eligibility', 'verification', 'form']),
  paid_only: new Set(['eligibility', 'follow_up']),
  ineligible: new Set(['eligibility', 'follow_up']),
  unavailable: new Set(['eligibility', 'follow_up']),
  cancelled: new Set(['eligibility', 'verification', 'form', 'confirmation', 'follow_up']),
};

const EVIDENCE_REQUIRED = new Set([
  'submitted',
  'awaiting_approval',
  'awaiting_email_verification',
  'published',
  'submission_failed',
  'paid_only',
  'ineligible',
  'unavailable',
]);

const EVIDENCE_TYPES = new Set([
  'public_page',
  'submission_receipt',
  'status_page',
  'email_required_notice',
  'policy_page',
  'error_response',
  'controlled_capture',
  'user_confirmation',
]);

const STATE_TRANSITIONS = {
  claimed: new Set(['inspecting', 'awaiting_user_login', 'blocked_user_action', 'blocked_missing_data', 'blocked_execution_backend', 'paid_only', 'ineligible', 'unavailable', 'cancelled']),
  inspecting: new Set(['form_in_progress', 'awaiting_user_login', 'blocked_user_action', 'blocked_missing_data', 'blocked_execution_backend', 'paid_only', 'ineligible', 'unavailable', 'cancelled']),
  awaiting_user_login: new Set(['inspecting', 'form_in_progress', 'blocked_user_action', 'cancelled']),
  form_in_progress: new Set(['submitted', 'awaiting_approval', 'awaiting_email_verification', 'submission_outcome_unknown', 'submission_failed', 'blocked_user_action', 'blocked_missing_data', 'cancelled']),
  submitted: new Set(['awaiting_approval', 'awaiting_email_verification', 'published', 'submission_failed']),
  awaiting_approval: new Set(['published', 'submission_failed']),
  awaiting_email_verification: new Set(['awaiting_approval', 'published', 'submission_failed']),
  submission_outcome_unknown: new Set(['submitted', 'awaiting_approval', 'awaiting_email_verification', 'published', 'submission_failed']),
  submission_failed: new Set([]),
  published: new Set([]),
  blocked_user_action: new Set(['inspecting', 'form_in_progress', 'cancelled']),
  blocked_missing_data: new Set(['inspecting', 'form_in_progress', 'cancelled']),
  blocked_execution_backend: new Set(['inspecting', 'cancelled']),
  paid_only: new Set([]),
  ineligible: new Set([]),
  unavailable: new Set([]),
  cancelled: new Set([]),
};

const TRACKING_QUERY_KEYS = new Set([
  'dclid', 'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'msclkid', 'referrer',
]);
const SENSITIVE_QUERY_KEY = /^(?:access_?token|api_?key|auth|authorization|code|credential|key|magic|oauth_?(?:code|state)|password|recovery_?code|refresh_?token|secret|sig|signature|state|token)$/i;
const SENSITIVE_KEY = /^(?:accessToken|access_token|apiKey|api_key|authorization|cookie|cookies|magicLink|magic_link|oauthCode|oauth_code|otp|password|recoveryCode|recovery_code|refreshToken|refresh_token|secret|sessionId|session_id)$/i;
const PRIVATE_PATH = /(?:\b[A-Za-z]:\\Users\\|\/Users\/|\/home\/)/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i;
const API_KEY_LIKE = /\bsk_[A-Za-z0-9_-]{12,}\b/i;
const COMMON_MULTI_LABEL_SUFFIXES = new Set([
  'ac.uk', 'co.in', 'co.jp', 'co.kr', 'co.nz', 'co.uk', 'com.ar', 'com.au',
  'com.br', 'com.cn', 'com.hk', 'com.mx', 'com.sg', 'com.tr', 'com.tw',
  'net.au', 'org.au', 'org.uk',
]);

function token(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[–—-]+/g, '_')
    .replace(/[\s/]+/g, '_')
    .replace(/_+/g, '_');
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function domainName(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
    : '';
}

function nonemptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function safeUrl(value, field, errors, { allowTracking = true } = {}) {
  if (value === undefined || value === null) return undefined;
  if (!nonemptyString(value)) {
    errors.push(`${field} must be a nonempty URL string.`);
    return undefined;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${field} must be a valid absolute URL.`);
    return undefined;
  }
  if (!['http:', 'https:'].includes(url.protocol)) errors.push(`${field} must use HTTP or HTTPS.`);
  if (url.username || url.password) errors.push(`${field} must not contain embedded credentials.`);
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY.test(key)) errors.push(`${field} contains a sensitive query parameter: ${key}.`);
    if (!allowTracking && (key.toLowerCase().startsWith('utm_') || TRACKING_QUERY_KEYS.has(key.toLowerCase()))) {
      errors.push(`${field} contains a tracking query parameter: ${key}.`);
    }
  }
  url.hash = '';
  return url;
}

export function normalizeSubmissionUrl(value) {
  const errors = [];
  const url = safeUrl(value, 'submissionUrl', errors);
  if (!url || errors.length) return undefined;
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.toString();
}

export function platformDomainFromUrl(value) {
  let hostname;
  try {
    hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return undefined;
  }
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname === 'localhost') return hostname;
  const labels = hostname.split('.');
  const suffix = labels.slice(-2).join('.');
  if (labels.length >= 3 && COMMON_MULTI_LABEL_SUFFIXES.has(suffix)) return labels.slice(-3).join('.');
  return labels.length >= 2 ? labels.slice(-2).join('.') : hostname;
}

export function deriveIdempotencyKey(task) {
  const productId = task?.product?.canonicalId || task?.productCanonicalId || normalizeSubmissionUrl(task?.product?.canonicalUrl);
  const domain = token(task?.platformDomain || platformDomainFromUrl(task?.submissionUrl));
  const account = token(task?.accountAlias || task?.account?.alias || 'no_account');
  const route = token(task?.route || 'directory_listing');
  if (!domain || !productId) return undefined;
  return `${domain}|${token(productId)}|${account}|${route}`;
}

function scanSensitive(value, errors, path = 'payload', options = {}) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSensitive(entry, errors, `${path}[${index}]`, options));
    return;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const isTaskAuthorization = options.allowAuthorizationObject && path === 'task' && key === 'authorization';
      if (SENSITIVE_KEY.test(key) && !isTaskAuthorization) errors.push(`${path}.${key} is not allowed in a shareable Blink record.`);
      scanSensitive(entry, errors, `${path}.${key}`, options);
    }
    return;
  }
  if (typeof value !== 'string') return;
  if (!options.allowPersonalData && PRIVATE_PATH.test(value)) errors.push(`${path} contains a private absolute path.`);
  if (!options.allowPersonalData && EMAIL.test(value)) errors.push(`${path} contains an unredacted email address.`);
  if (BEARER.test(value) || API_KEY_LIKE.test(value)) errors.push(`${path} appears to contain a credential.`);
  for (const candidate of value.match(/https?:\/\/[^\s)>]+/gi) || []) {
    safeUrl(candidate.replace(/[.,;:'"]+$/, ''), path, errors);
  }
}

function authorizationDecision(authorization, action) {
  if (!isObject(authorization)) return undefined;
  if (isObject(authorization.actions)) return token(authorization.actions[action]);
  return authorization[action] === true ? 'allowed' : authorization[action] === false ? 'prohibited' : undefined;
}

function auditAuthorization(task, domain, at, errors, warnings) {
  const authorization = task.authorization;
  if (!isObject(authorization)) {
    errors.push('task.authorization must be an object.');
    return { inspection: false, formFilling: false, finalSubmission: false };
  }

  const strict = Number(task.schemaVersion || 1) >= 2;
  if (strict) {
    for (const field of ['reference', 'approvedBy', 'approvedAt', 'expiresAt', 'scopeDomains']) {
      if (authorization[field] === undefined || authorization[field] === '') errors.push(`authorization.${field} is required for schemaVersion 2.`);
    }
  } else if (!authorization.reference || !authorization.expiresAt || !authorization.scopeDomains) {
    warnings.push('Legacy authorization has no complete reference, expiry, and domain scope; migrate this queue item to schemaVersion 2.');
  }

  const approvedAt = parseTimestamp(authorization.approvedAt);
  const expiresAt = authorization.expiresAt === 'no_expiry' ? Infinity : parseTimestamp(authorization.expiresAt);
  if (authorization.approvedAt && approvedAt === undefined) errors.push('authorization.approvedAt must be ISO 8601 with timezone.');
  if (authorization.expiresAt && expiresAt === undefined) errors.push('authorization.expiresAt must be ISO 8601 with timezone or no_expiry.');
  if (approvedAt !== undefined && approvedAt > at) errors.push('authorization is not active yet.');
  if (expiresAt !== undefined && expiresAt <= at) errors.push('authorization has expired.');
  if (approvedAt !== undefined && expiresAt !== undefined && expiresAt < approvedAt) errors.push('authorization expiry precedes approval.');

  const scopes = Array.isArray(authorization.scopeDomains)
    ? authorization.scopeDomains.map(domainName)
    : authorization.scopeDomains ? [domainName(authorization.scopeDomains)] : [];
  if (scopes.length && !scopes.includes('all_queued_sites') && !scopes.includes('all_listed_sites') && !scopes.includes(domainName(domain))) {
    errors.push(`authorization scope does not include ${domain}.`);
  }

  const decisions = {
    inspection: authorizationDecision(authorization, 'inspection'),
    formFilling: authorizationDecision(authorization, 'formFilling'),
    assetUpload:
      authorizationDecision(authorization, 'assetUpload') ||
      authorizationDecision(authorization, 'formFilling'),
    finalSubmission: authorizationDecision(authorization, 'finalSubmission'),
    accountCreation: authorizationDecision(authorization, 'accountCreation'),
    termsAcceptance: authorizationDecision(authorization, 'termsAcceptance'),
    payment: authorizationDecision(authorization, 'payment'),
    reciprocalLink: authorizationDecision(authorization, 'reciprocalLink'),
    domainVerification: authorizationDecision(authorization, 'domainVerification'),
  };
  if (strict) {
    for (const action of Object.keys(decisions)) {
      if (!['allowed', 'ask', 'prohibited'].includes(decisions[action])) errors.push(`authorization action ${action} has no valid decision.`);
    }
  }
  if (decisions.inspection === undefined && !strict) decisions.inspection = 'allowed';
  for (const action of ['inspection', 'formFilling', 'finalSubmission']) {
    if (!['allowed', 'ask', 'prohibited'].includes(decisions[action])) errors.push(`authorization action ${action} has no valid decision.`);
  }
  for (const action of ['payment', 'reciprocalLink', 'domainVerification']) {
    if (decisions[action] === 'allowed') errors.push(`unsafe queue authorization must not allow ${action}.`);
  }
  return {
    inspection: decisions.inspection === 'allowed',
    formFilling: decisions.formFilling === 'allowed',
    assetUpload: decisions.assetUpload === 'allowed',
    finalSubmission: decisions.finalSubmission === 'allowed',
    decisions,
  };
}

function auditQuality(task, mode, errors, blockers) {
  const qualityGate = token(task.qualityGate || 'not_checked');
  if (!['passed', 'failed', 'not_checked'].includes(qualityGate)) errors.push('task.qualityGate must be passed, failed, or not_checked.');
  if (qualityGate !== 'passed') blockers.push(`quality_gate_${qualityGate}`);
  if (Number(task.schemaVersion || 1) < 2 || qualityGate !== 'passed') return qualityGate;

  const quality = task.quality;
  if (!isObject(quality)) {
    errors.push('task.quality is required when a schemaVersion 2 quality gate is passed.');
    return qualityGate;
  }
  const required = {
    audienceRelevance: ['pass'],
    discoveryValue: ['pass'],
    governance: ['pass', 'governed_platform'],
    paidLinkOffer: ['none', 'qualified_paid_placement'],
    networkQuality: ['pass'],
    automationTerms: ['allowed', 'manual_only'],
  };
  for (const [field, allowed] of Object.entries(required)) {
    const actual = token(quality[field]);
    if (!allowed.includes(actual)) errors.push(`task.quality.${field} is incompatible with a passed quality gate.`);
  }
  if (quality.reciprocalRequired !== false) errors.push('task.quality.reciprocalRequired must be false for an executable listing.');
  if (token(quality.automationTerms) === 'manual_only' && mode === 'automatic') blockers.push('automation_not_allowed');
  return qualityGate;
}

function auditBrowserExecution(task, mode, errors, blockers) {
  if (mode !== 'semi_automatic') return;
  const browser = task.browser;
  if (!isObject(browser)) {
    blockers.push('visible_browser_required');
    return;
  }
  if (
    browser.visibility !== 'visible' ||
    browser.headless !== false ||
    browser.foreground !== true
  ) {
    blockers.push('visible_browser_required');
  }
  if (browser.confirmation !== 'required') {
    blockers.push('user_confirmation_required');
  }
  if (
    browser.visibility !== 'visible' &&
    browser.visibility !== 'runtime_default'
  ) {
    errors.push('task.browser.visibility must be visible or runtime_default.');
  }
  if (
    browser.headless !== false &&
    browser.headless !== 'runtime_default'
  ) {
    errors.push('task.browser.headless must be false or runtime_default.');
  }
  if (typeof browser.foreground !== 'boolean') {
    errors.push('task.browser.foreground must be a boolean.');
  }
  if (browser.confirmation !== 'required' && browser.confirmation !== 'runtime') {
    errors.push('task.browser.confirmation must be required or runtime.');
  }
}

export function auditTask(task, options = {}) {
  const errors = [];
  const warnings = [];
  const blockers = [];
  const now = options.now === undefined ? Date.now() : Number(options.now);
  if (!isObject(task)) return { valid: false, executable: false, errors: ['task must be a JSON object.'], warnings, blockers };
  scanSensitive(task, errors, 'task', { allowPersonalData: true, allowAuthorizationObject: true });

  if (!nonemptyString(task.runId)) errors.push('task.runId is required.');
  if (!nonemptyString(task.submissionUrl)) errors.push('task.submissionUrl is required.');
  const submission = safeUrl(task.submissionUrl, 'task.submissionUrl', errors);
  const normalizedSubmissionUrl = normalizeSubmissionUrl(task.submissionUrl);
  const platformDomain = domainName(task.platformDomain || platformDomainFromUrl(task.submissionUrl));
  if (task.platformDomain && domainName(task.platformDomain) !== platformDomainFromUrl(task.submissionUrl)) {
    errors.push('task.platformDomain does not match task.submissionUrl.');
  }

  const mode = token(task.executionMode || 'semi_automatic');
  if (!['automatic', 'semi_automatic'].includes(mode)) errors.push('task.executionMode must be automatic or semi-automatic.');
  auditBrowserExecution(task, mode, errors, blockers);
  if (isObject(task.policy)) {
    if (mode === 'automatic' && task.policy.allowSubmit !== true) {
      errors.push('automatic task policy must allow final submission.');
    }
    if (mode === 'automatic' && task.policy.stopBeforeSubmit !== false) {
      errors.push('automatic task policy must not stop before final submission.');
    }
    if (mode === 'semi_automatic' && task.policy.allowSubmit === true) {
      errors.push('semi-automatic task policy must not allow final submission.');
    }
    if (mode === 'semi_automatic' && task.policy.stopBeforeSubmit === false) {
      errors.push('semi-automatic task policy must stop before final submission.');
    }
  }
  const route = token(task.route || 'directory_listing');
  if (!SUPPORTED_ROUTES.has(route)) errors.push(`unsupported task route: ${route || 'missing'}.`);

  if (!isObject(task.product)) {
    errors.push('task.product must be an object.');
  } else {
    for (const field of ['name', 'canonicalUrl', 'description']) {
      if (!nonemptyString(task.product[field])) errors.push(`task.product.${field} is required.`);
    }
    safeUrl(task.product.canonicalUrl, 'task.product.canonicalUrl', errors, { allowTracking: false });
  }

  const qualityGate = auditQuality(task, mode, errors, blockers);

  const authorization = auditAuthorization(task, platformDomain, now, errors, warnings);
  if (!authorization.inspection) blockers.push('inspection_not_authorized');
  if (!authorization.formFilling) blockers.push('form_filling_not_authorized');
  if (!authorization.finalSubmission) blockers.push('final_submission_not_authorized');

  const idempotencyKey = deriveIdempotencyKey(task);
  if (!idempotencyKey) errors.push('cannot derive an idempotency key from platform, product, account, and route.');
  if (task.idempotencyKey && token(task.idempotencyKey) !== token(idempotencyKey)) errors.push('task.idempotencyKey does not match the derived key.');
  if (Array.isArray(options.seenIdempotencyKeys) && options.seenIdempotencyKeys.map(token).includes(token(idempotencyKey))) {
    blockers.push('duplicate_idempotency_key');
  }
  if (Array.isArray(options.seenSubmissionUrls) && options.seenSubmissionUrls.map(normalizeSubmissionUrl).includes(normalizedSubmissionUrl)) {
    blockers.push('duplicate_normalized_submission_url');
  }

  if (submission && task.requiresPayment === true) blockers.push('payment_required');
  if (task.requiresReciprocalLink === true) blockers.push('reciprocal_link_required');
  if (task.automationAllowed === false && mode === 'automatic') blockers.push('automation_not_allowed');

  const valid = errors.length === 0;
  return {
    valid,
    executable: valid && blockers.length === 0,
    readyForInspection: valid && authorization.inspection,
    readyForForm: valid && qualityGate === 'passed' && authorization.formFilling,
    readyForSubmission: valid && qualityGate === 'passed' && authorization.finalSubmission,
    normalized: {
      submissionUrl: normalizedSubmissionUrl,
      platformDomain,
      executionMode: mode.replace('_', '-'),
      route,
      idempotencyKey,
    },
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    blockers: [...new Set(blockers)],
  };
}

export function auditLog(payload) {
  const progressStatuses = new Set(['claimed', 'inspecting', 'form_in_progress']);
  if (payload?.event === 'submission_result' || (payload?.status && !progressStatuses.has(payload.status))) {
    return auditResult(payload);
  }
  const errors = [];
  if (!isObject(payload)) return { valid: false, errors: ['log must be a JSON object.'], warnings: [] };
  scanSensitive(payload, errors, 'log');
  if (!nonemptyString(payload.runId)) errors.push('log.runId is required.');
  if (!nonemptyString(payload.message)) errors.push('log.message is required.');
  if (!nonemptyString(payload.event)) errors.push('log.event is required.');
  safeUrl(payload.resultUrl, 'log.resultUrl', errors);
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function auditResult(payload, options = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(payload)) return { valid: false, errors: ['result must be a JSON object.'], warnings };
  scanSensitive(payload, errors, 'result');
  const status = token(payload.status);
  if (!RESULT_STATUSES.has(status)) errors.push(`unsupported result status: ${status || 'missing'}.`);
  if (!nonemptyString(payload.runId)) errors.push('result.runId is required.');
  if (!nonemptyString(payload.message)) errors.push('result.message is required.');
  safeUrl(payload.resultUrl, 'result.resultUrl', errors);

  const details = isObject(payload.details) ? payload.details : {};
  if (payload.details !== undefined && !isObject(payload.details)) errors.push('result.details must be an object.');
  if (details.retryAllowed !== undefined && typeof details.retryAllowed !== 'boolean') errors.push('details.retryAllowed must be a boolean.');
  if (details.retryAllowed === true && ['submitted', 'awaiting_approval', 'awaiting_email_verification', 'published', 'submission_outcome_unknown'].includes(status)) {
    errors.push(`${status} cannot allow a repeated submission: details.retryAllowed must be false or omitted.`);
  }
  const phase = token(details.phase || (status === 'published' ? 'follow_up' : status === 'awaiting_user_login' ? 'verification' : 'confirmation'));
  if (RESULT_PHASES[status] && !RESULT_PHASES[status].has(phase)) errors.push(`incompatible result phase/status: ${phase} / ${status}.`);
  if (details.mode && !['automatic', 'semi_automatic'].includes(token(details.mode))) errors.push('details.mode must be automatic or semi-automatic.');
  for (const field of ['evidenceUrl', 'pageUrl', 'publicListingUrl', 'currentUrl']) safeUrl(details[field], `result.details.${field}`, errors);

  if (EVIDENCE_REQUIRED.has(status)) {
    if (!nonemptyString(details.exactResult)) errors.push(`${status} requires details.exactResult.`);
    if (!EVIDENCE_TYPES.has(token(details.evidenceType))) errors.push(`${status} requires a canonical details.evidenceType.`);
    if (!payload.resultUrl && !details.evidenceUrl && !details.evidenceRef) errors.push(`${status} requires a safe evidence URL or opaque evidenceRef.`);
    if (parseTimestamp(details.observedAt) === undefined) errors.push(`${status} requires details.observedAt with timezone.`);
  }
  if (details.evidenceRef !== undefined && (typeof details.evidenceRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,100}$/.test(details.evidenceRef))) {
    errors.push('details.evidenceRef must be an opaque ID, not a URL, path, or email.');
  }

  const submitAt = parseTimestamp(details.submitActionAt);
  const observedAt = parseTimestamp(details.observedAt);
  const retentionUntil = details.evidenceRetentionUntil === 'campaign_policy' ? Infinity : parseTimestamp(details.evidenceRetentionUntil);
  if (details.submitActionAt && submitAt === undefined) errors.push('details.submitActionAt must be ISO 8601 with timezone.');
  if (details.evidenceRetentionUntil && retentionUntil === undefined) errors.push('details.evidenceRetentionUntil must be ISO 8601 with timezone or campaign_policy.');
  if (submitAt !== undefined && observedAt !== undefined && observedAt < submitAt) errors.push('details.observedAt precedes details.submitActionAt.');
  if (observedAt !== undefined && retentionUntil !== undefined && retentionUntil < observedAt) errors.push('evidence retention precedes evidence capture.');

  if (status === 'published') {
    const publicUrl = details.publicListingUrl || payload.resultUrl;
    if (!publicUrl) errors.push('published requires details.publicListingUrl or resultUrl.');
    const link = details.linkAttributes;
    if (!isObject(link)) {
      errors.push('published requires details.linkAttributes.');
    } else {
      if (!['brand', 'product', 'naked_url'].includes(token(link.anchorType))) errors.push('published link anchorType must be brand, product, or naked_url.');
      if (!nonemptyString(link.href)) errors.push('published link href is required.');
      safeUrl(link.href, 'result.details.linkAttributes.href', errors);
      const rel = token(link.rel || 'none').split('_').filter(Boolean);
      if (!rel.length || rel.some((entry) => !['none', 'nofollow', 'sponsored', 'ugc'].includes(entry))) errors.push('published link rel is invalid.');
      const relationship = token(link.commercialRelationship || 'none');
      if (!['none', 'paid', 'incentivized', 'reciprocal'].includes(relationship)) errors.push('published commercialRelationship is invalid.');
      if (['paid', 'incentivized'].includes(relationship) && !rel.some((entry) => ['nofollow', 'sponsored'].includes(entry))) {
        errors.push('paid or incentivized links require sponsored or nofollow.');
      }
      if (parseTimestamp(link.checkedAt) === undefined) errors.push('published link checkedAt must be ISO 8601 with timezone.');
    }
  }

  if (status === 'submission_outcome_unknown') {
    if (details.retryAllowed !== false) errors.push('submission_outcome_unknown requires details.retryAllowed=false.');
    if (parseTimestamp(details.nextReviewAt) === undefined) errors.push('submission_outcome_unknown requires details.nextReviewAt with timezone.');
  }

  if (status === 'awaiting_user_login') {
    const resume = details.resume;
    if (!isObject(resume)) {
      errors.push('awaiting_user_login requires details.resume.');
    } else {
      for (const field of ['idempotencyKey', 'browserSessionAlias', 'resumePhase']) {
        if (!nonemptyString(resume[field])) errors.push(`awaiting_user_login requires details.resume.${field}.`);
      }
      if (!nonemptyString(resume.currentUrl || payload.resultUrl)) errors.push('awaiting_user_login requires a current URL.');
      safeUrl(resume.currentUrl || payload.resultUrl, 'result.details.resume.currentUrl', errors);
    }
  }

  const keys = [payload.idempotencyKey, details.idempotencyKey, details.resume?.idempotencyKey].filter((key) => key !== undefined);
  if (keys.some((key) => !nonemptyString(key)) || new Set(keys).size > 1) errors.push('result idempotency keys must be nonempty and agree.');
  if (options.task) {
    if (payload.runId !== options.task.runId) errors.push('result.runId does not match the task runId.');
    const expectedKey = deriveIdempotencyKey(options.task);
    const actualKey = payload.idempotencyKey || details.idempotencyKey || details.resume?.idempotencyKey;
    if (actualKey && expectedKey && token(actualKey) !== token(expectedKey)) errors.push('result idempotency key does not match the task.');
  }

  return { valid: errors.length === 0, status, phase, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function auditCampaign(campaign) {
  const errors = [];
  const warnings = [];
  const tasks = Array.isArray(campaign?.tasks) ? campaign.tasks : [];
  const results = Array.isArray(campaign?.results) ? campaign.results : [];
  const events = Array.isArray(campaign?.events) ? campaign.events : [];
  if (!isObject(campaign)) errors.push('campaign must be a JSON object.');
  if (!tasks.length) warnings.push('campaign contains no tasks.');

  const seenUrls = new Map();
  const seenKeys = new Map();
  const taskAudits = tasks.map((task, index) => {
    const audit = auditTask(task);
    for (const error of audit.errors) errors.push(`task ${index + 1}: ${error}`);
    for (const warning of audit.warnings) warnings.push(`task ${index + 1}: ${warning}`);
    const url = audit.normalized?.submissionUrl;
    const key = audit.normalized?.idempotencyKey;
    const project = task.product?.canonicalId || task.product?.canonicalUrl || '';
    const scopedUrl = JSON.stringify([project, url]);
    // Legacy v1 keys identify a platform, not an individual hosted form. Two
    // Tally forms for distinct directories can legitimately share that key.
    const scopedKey = Number(task.schemaVersion || 1) < 2 ? JSON.stringify([key, url]) : key;
    if (url && seenUrls.has(scopedUrl)) errors.push(`task ${index + 1}: duplicate normalized submission URL also used by task ${seenUrls.get(scopedUrl)}.`);
    else if (url) seenUrls.set(scopedUrl, index + 1);
    if (key && seenKeys.has(scopedKey)) errors.push(`task ${index + 1}: duplicate idempotency key also used by task ${seenKeys.get(scopedKey)}.`);
    else if (key) seenKeys.set(scopedKey, index + 1);
    return audit;
  });

  const taskByRun = new Map(tasks.map((task) => [task.runId, task]));
  const resultAudits = results.map((result, index) => {
    const audit = auditResult(result, { task: taskByRun.get(result?.runId) });
    for (const error of audit.errors) errors.push(`result ${index + 1}: ${error}`);
    return audit;
  });

  const eventIds = new Set();
  const lastEventAt = new Map();
  const lastStatus = new Map();
  scanSensitive(events, errors, 'campaign.events');
  for (const [index, event] of events.entries()) {
    if (!event?.eventId || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,100}$/.test(event.eventId)) errors.push(`event ${index + 1}: invalid eventId.`);
    else if (eventIds.has(event.eventId)) errors.push(`event ${index + 1}: duplicate eventId.`);
    else eventIds.add(event.eventId);
    const occurredAt = parseTimestamp(event?.occurredAt);
    if (occurredAt === undefined) errors.push(`event ${index + 1}: invalid occurredAt.`);
    const previous = lastEventAt.get(event?.runId);
    const heartbeatOnly = event?.event === 'lease_heartbeat';
    if (!heartbeatOnly && occurredAt !== undefined && previous !== undefined && occurredAt < previous) errors.push(`event ${index + 1}: event time moves backward for its run.`);
    if (!heartbeatOnly && occurredAt !== undefined) lastEventAt.set(event?.runId, occurredAt);
    if (event?.status && !heartbeatOnly) {
      const currentStatus = token(event.status);
      if (!STATE_TRANSITIONS[currentStatus]) {
        errors.push(`event ${index + 1}: invalid canonical status.`);
      } else {
        const previousStatus = lastStatus.get(event?.runId);
        if (previousStatus && currentStatus !== previousStatus && !STATE_TRANSITIONS[previousStatus]?.has(currentStatus)) {
          errors.push(`event ${index + 1}: illegal status transition ${previousStatus} -> ${currentStatus}.`);
        }
        lastStatus.set(event?.runId, currentStatus);
      }
    }
  }

  const counts = {};
  for (const result of results) counts[token(result?.status) || 'missing'] = (counts[token(result?.status) || 'missing'] || 0) + 1;
  return {
    valid: errors.length === 0,
    totals: { tasks: tasks.length, results: results.length, events: events.length },
    resultCounts: counts,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    tasks: taskAudits.map(({ normalized, executable, blockers }) => ({ normalized, executable, blockers })),
    results: resultAudits,
  };
}

async function runCli() {
  const [command, file] = process.argv.slice(2);
  if (!['task', 'result', 'campaign'].includes(command) || !file) {
    throw new Error('Usage: blink-audit.mjs task|result|campaign <json-file> [--task-file <json-file>]');
  }
  const value = JSON.parse(await readFile(file, 'utf8'));
  let report;
  if (command === 'task') report = auditTask(value);
  if (command === 'result') {
    const taskIndex = process.argv.indexOf('--task-file');
    const task = taskIndex >= 0 ? JSON.parse(await readFile(process.argv[taskIndex + 1], 'utf8')) : undefined;
    report = auditResult(value, { task });
  }
  if (command === 'campaign') report = auditCampaign(value);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.valid ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runCli();
}
