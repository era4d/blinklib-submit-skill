#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { auditResult } from './blink-audit.mjs';
import {
  planFormFields,
  validateFormExecutionReceipts,
} from './blink-form-plan.mjs';
import {
  createFileTransport,
  runTransportCommand,
} from './blink-runner-transport.mjs';
import { synchronizeInstalledSkill } from './blink-skill-manager.mjs';

const CLIENT_VERSION = '1.9.7';
const here = dirname(fileURLToPath(import.meta.url));
const client = resolve(here, 'blink-automation.mjs');
const terminalResultStatuses = new Set([
  'submitted',
  'awaiting_approval',
  'awaiting_email_verification',
  'published',
  'ineligible',
  'unavailable',
  'paid_only',
  'submission_outcome_unknown',
  'submission_failed',
]);
const runtimeBlockers = new Set([
  'runtime_confirmation_required',
  'runtime_denial',
  'browser_failure',
]);
const invalidAutomaticBlockers = new Set([
  'contact_email_confirmation',
  'ordinary_field_confirmation',
  'upload_confirmation',
  'next_confirmation',
  'final_submit_confirmation',
  'ordinary_terms_confirmation',
]);
const groundedNarrativeKinds = new Set(['text', 'textarea']);
const groundedNarrativeReasons = new Set([
  'no_high_confidence_fact',
  'requires_reasoning',
  'value_outside_length_constraints',
]);
const factualIdentityField =
  /\b(?:name|email|e-mail|url|website|link|phone|address|username|user name|handle|twitter|linkedin|facebook|instagram|github|founder|founded|year|date|price|pricing|revenue|employees?|country|city|legal|vat|tax|registration|domain)\b|名称|姓名|邮箱|网址|链接|电话|地址|用户名|账号|创始人|成立|年份|日期|价格|定价|收入|员工|国家|城市|法律|税号|注册|域名/i;
const narrativeQuestion =
  /\b(?:describe|explain|tell|share|why|how|strategy|strategies|plan|plans|future|roadmap|tech stack|technology|use case|problem|solution|benefit|advantage|differentiat|mission|story|goal|audience|feature|workflow|launch|motivation)\b|描述|介绍|为什么|如何|策略|计划|规划|技术栈|技术|使用场景|问题|解决方案|优势|愿景|故事|目标|用户|功能|工作流|发布|动机/i;
const googleLoginPolicy = Object.freeze({
  preferredProvider: 'google',
  attemptBeforeDeferral: true,
  clickVisibleSignIn: true,
  accountSelection: 'saved_preference_or_sole_signed_in',
  allowSignup: 'only_when_authorized',
  preserveProviderOnFailure: false,
  postLoginNavigation: Object.freeze({
    required: true,
    targetField: 'submissionUrl',
    action: 'navigate_task_tab_to_exact_submission_url',
    preservePathQueryAndFragment: true,
    waitForPageAndEmbeddedForm: true,
    reinspectAfterNavigation: true,
    continueOriginalAction: true,
  }),
  onUnsuccessfulLogin:
    'close_task_tab_and_auth_popups_only_when_no_form_progress',
  onAuthenticatedInterruption: 'preserve_if_any_form_progress_and_continue',
});
const browserInteractionPolicy = Object.freeze({
  userPrompts: 'preserved_progress_tabs_at_batch_end_only',
  onBlocker: 'defer_and_continue',
  onBlockerBeforeFormProgress: 'close_and_continue',
  onBlockerAfterFormProgress: 'preserve_and_continue',
  onFailedLoginBeforeFormProgress: 'close_and_continue',
  onFailedLoginAfterFormProgress: 'preserve_and_continue',
  onInterruptedBeforeFormProgress: 'close_and_continue',
  onInterruptedAfterFormProgress: 'preserve_for_user_completion',
  formProgressEvidence: [
    'applied_field',
    'accepted_upload',
    'advanced_form_step',
  ],
  preserveEveryProgressedTab: true,
  onRecordedResult: 'close_and_continue',
});
const validGoogleBlockerOutcomes = new Set([
  'unavailable',
  'ambiguous_accounts',
  'credential_challenge',
  'provider_error',
  'consent_requires_review',
  'callback_unconfirmed',
]);
const blockerCodes = new Set([
  'captcha',
  'login_required',
  'email_verification',
  'missing_required_fact',
  'asset_missing',
  'asset_rejected',
  ...runtimeBlockers,
  'assisted_final_review',
]);

// Repair the receipt, never replay a potentially completed browser mutation.
async function requestReceipt(io, request, validate) {
  let correction;
  while (true) {
    const receipt = await io.request({
      ...request,
      ...(correction
        ? {
            receiptOnly: true,
            correction,
            instruction:
              'Correct the receipt from the existing tab. Never repeat Submit or an already accepted upload. If the correction identifies a staged upload that was never attached, attach that exact temporary file with the current browser upload API, verify the field, and then return the corrected receipt.',
          }
        : {}),
    });
    const error =
      receipt?.requestId !== request.requestId
        ? 'Return the exact requestId from this request.'
        : validate(receipt);
    if (!error) return receipt;
    correction = error;
    await io.emit({
      type: 'receipt_rejected',
      code: 'INVALID_BROWSER_RECEIPT',
      requestId: request.requestId,
      runId: request.runId || request.task?.runId,
      message: error,
      continueRequired: true,
    });
  }
}

function inspectionError(receipt) {
  return receipt.type !== 'inspection' ||
    !Array.isArray(receipt.controls) ||
    !String(receipt.tabId || '').trim()
    ? 'An inspection needs type inspection, a stable tabId, and a controls array.'
    : null;
}

export async function prepareTaskAnswers(io, task) {
  const fields = (task.resource?.submissionFields || []).filter(
    (field) =>
      field.aiEnabled === true &&
      field.key &&
      !['logo', 'preview', 'screenshot', 'image', 'checkbox'].includes(
        field.type
      ) &&
      !/password|captcha|turnstile|\botp\b|verification|secret|api.?key|terms|privacy|newsletter|验证码|密码|条款|订阅/i.test(
        `${field.key} ${field.label}`
      )
  );
  const values = { ...task.fieldAnswers };
  const pending = [];
  for (const field of fields) {
    const kind = ['email', 'url', 'number'].includes(field.type)
      ? field.type
      : ['select', 'radio', 'checkbox', 'multi_select'].includes(field.type)
        ? field.type
        : 'text';
    const plan = planFormFields(task, [
      {
        ref: field.key,
        label: field.label,
        kind,
        maxLength: field.maxLength,
        required: field.required,
      },
    ]);
    const fact = plan.fields.find(
      (entry) => entry.ref === field.key && entry.value
    );
    if (fact) values[field.key] = fact.value;
    else if (!String(values[field.key] ?? '').trim()) pending.push(field.key);
  }
  let preparation = {
    status: 'ready',
    questionCount: fields.length,
    reusedAnswerCount: fields.filter((field) => String(values[field.key] ?? '').trim()).length,
    requestedCount: pending.length,
  };
  if (
    pending.length && task.aiGeneration?.available === false
  ) {
    preparation.status = 'credits_unavailable';
  } else if (
    pending.length &&
    task.resource?.id &&
    task.authorization?.formFilling === true
  ) {
    try {
      // One call for the site's unanswered questions; the server reuses saved run answers.
      const result = await io.cli([
        'answers',
        '--resource-id',
        task.resource.id,
        '--project-id',
        task.projectId,
        '--run-id',
        task.runId,
        '--lease-id',
        task.lease.leaseId,
        ...pending.flatMap((key) => ['--field-key', key]),
      ]);
      for (const key of pending) {
        const value = result.values?.[key];
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          Array.isArray(value)
        )
          values[key] = value;
      }
      preparation = {
        ...preparation,
        context: result.context,
        cached: result.cached === true,
        status: pending.every((key) => String(values[key] ?? '').trim())
          ? 'ready'
          : 'partial',
      };
    } catch {
      // Keep known facts usable. A generation failure must not discard the task.
      preparation.status = 'answer_request_failed';
    }
  } else if (pending.length) preparation.status = 'partial';
  return { ...task, fieldAnswers: values, answerPreparation: preparation };
}

export function groundedAnswerContext(task, plan) {
  const unresolved = Array.isArray(plan?.unresolved) ? plan.unresolved : [];
  const composableFields = unresolved.filter((field) => {
    const label = String(field?.label || '');
    return (
      groundedNarrativeKinds.has(String(field?.kind || '').toLowerCase()) &&
      groundedNarrativeReasons.has(field?.reason) &&
      narrativeQuestion.test(label) &&
      !factualIdentityField.test(label)
    );
  });
  return {
    productContext: task.product || {},
    groundedAnswerPolicy: {
      mode: 'compose_open_ended_from_product_context',
      composableFields,
      preserveKnownAnswers: true,
      optionalUnknownFacts: 'leave_blank',
      requiredUnknownFacts: 'missing_required_fact',
      forbiddenInventions: [
        'identity_or_contact',
        'pricing_or_financials',
        'metrics_or_customer_claims',
        'dates_or_legal_commitments',
        'credentials_or_verification',
      ],
    },
  };
}

function validFormProgress(progress) {
  return (
    progress &&
    Number.isInteger(progress.filledFieldCount) &&
    progress.filledFieldCount >= 0 &&
    Number.isInteger(progress.acceptedUploadCount) &&
    progress.acceptedUploadCount >= 0 &&
    typeof progress.advancedStep === 'boolean'
  );
}

export function blockerTabDispositionError(receipt, priorReceipts = []) {
  if (receipt?.type !== 'blocker') return null;
  if (!validFormProgress(receipt.formProgress)) {
    return 'A blocker receipt must report formProgress with non-negative integer filledFieldCount and acceptedUploadCount plus boolean advancedStep. Inspect the existing tab; do not close it until progress is classified.';
  }
  const hasPriorAppliedField = priorReceipts.some(
    (entry) => entry?.status === 'applied'
  );
  const hasFormProgress =
    hasPriorAppliedField ||
    receipt.formProgress.filledFieldCount > 0 ||
    receipt.formProgress.acceptedUploadCount > 0 ||
    receipt.formProgress.advancedStep;
  if (hasFormProgress && receipt.tabDisposition !== 'preserved') {
    return 'At least one form question, upload, or step already changed. Keep this unfinished task tab open and return tabDisposition "preserved"; this rule applies to every blocker and has no one-tab limit.';
  }
  if (!hasFormProgress && receipt.tabDisposition !== 'closed') {
    return 'No form progress exists. Close the untouched task tab and any login popup, then return tabDisposition "closed" so the controller can rotate.';
  }
  return null;
}

export function googleLoginBlockerError(receipt, priorReceipts = []) {
  if (receipt?.type !== 'blocker' || receipt.blockerCode !== 'login_required')
    return null;
  if (
    receipt.loginAttempt?.provider !== 'google' ||
    !validGoogleBlockerOutcomes.has(receipt.loginAttempt?.outcome)
  ) {
    return 'Inspect and try the visible Google sign-in path before deferring login, then report its concrete outcome.';
  }
  return blockerTabDispositionError(receipt, priorReceipts);
}

export function groundedAnswerBlockerError(receipt, answerContext) {
  if (
    receipt?.type === 'blocker' &&
    receipt.blockerCode === 'missing_required_fact' &&
    answerContext?.groundedAnswerPolicy?.composableFields?.some(
      (field) => field.required === true
    )
  ) {
    return 'Compose the required open-ended answer from productContext and continue the form.';
  }
  return null;
}

// Stage API-owned images before asking the browser worker to attach them.
// Paths stay in local controller state, never in Blink progress/result logs.
export async function stageTaskUploads(io, task, controls, cache = new Map()) {
  if (task.authorization?.assetUpload !== true) return [];
  const uploads = [];
  for (const control of controls) {
    if (
      String(control.kind).toLowerCase() !== 'file' ||
      control.value ||
      control.sensitive
    )
      continue;
    const label = String(control.label || '')
      .normalize('NFKC')
      .toLowerCase();
    const purposes = [
      ['logo', /\b(?:logos?|icons?|favicons?)\b|图标|標誌|标志|商标/],
      [
        'preview',
        /\b(?:banners?|covers?|previews?|hero\s+images?)\b|封面|横幅|橫幅|预览图|預覽圖/,
      ],
      [
        'screenshots',
        /\b(?:screen[\s-]?shots?|gallery)\b|截图|截圖|画廊|圖庫|图库/,
      ],
    ]
      .filter(([, pattern]) => pattern.test(label))
      .map(([purpose]) => purpose);
    if (purposes.length !== 1) continue;
    const purpose = purposes[0];
    if (!cache.has(purpose)) {
      try {
        // No output override: the client downloads to os.tmpdir()/blink-upload-*.
        const assets = await io.cli([
          'assets',
          '--project-id',
          task.projectId,
          '--download',
          purpose,
        ]);
        cache.set(purpose, {
          status: assets.files?.length ? 'staged' : 'missing_asset',
          files: assets.files || [],
        });
      } catch {
        // A download failure is not evidence that the user omitted the image.
        cache.set(purpose, { status: 'download_failed', files: [] });
      }
    }
    const staged = cache.get(purpose);
    uploads.push({
      ref: control.ref,
      label: control.label,
      purpose,
      required: control.required === true,
      ...staged,
      uploaded: false,
      fileHost: 'controller',
      tempStaged: staged.status === 'staged',
      nextAction:
        staged.status === 'staged'
          ? 'must_attach_with_current_browser_upload_api_and_verify_before_outcome'
          : 'inspect_asset_problem_without_prompting_user',
    });
  }
  return uploads;
}

function matchingUploadReceipt(receipts, upload) {
  return receipts.find(
    (entry) =>
      String(entry?.ref || '') === String(upload.ref || '') &&
      String(entry?.purpose || '') === String(upload.purpose || '')
  );
}

function observedUploadEvidence(receipt) {
  return String(receipt?.evidence || receipt?.observedEvidence || '').trim();
}

export function uploadCompletionError(receipt, uploads = []) {
  const staged = uploads.filter(
    (upload) => upload?.status === 'staged' && upload.files?.length
  );
  if (!staged.length) return null;

  const receipts = Array.isArray(receipt?.uploadReceipts)
    ? receipt.uploadReceipts
    : [];
  const accepted = [];
  for (const upload of staged) {
    const observed = matchingUploadReceipt(receipts, upload);
    if (!observed) {
      return `The staged ${upload.purpose} for file control ${upload.ref} has no upload receipt. Use its exact uploads[].files[].path from the system temporary directory with the current browser upload API, then re-inspect the same field for a filename, thumbnail, or completed state.`;
    }
    if (
      observed.status === 'accepted' &&
      Number.isInteger(observed.fileCount) &&
      observed.fileCount > 0 &&
      observedUploadEvidence(observed)
    ) {
      accepted.push(observed);
      continue;
    }
    const failedUploadIsTheBlocker =
      receipt?.type === 'blocker' &&
      ((receipt.blockerCode === 'asset_rejected' &&
        observed.status === 'rejected') ||
        (runtimeBlockers.has(receipt.blockerCode) &&
          observed.status === 'failed')) &&
      observedUploadEvidence(observed);
    if (!failedUploadIsTheBlocker) {
      return `The staged ${upload.purpose} for file control ${upload.ref} is not verified as accepted. Downloading to temp or opening a chooser is insufficient; attach it automatically, wait for completion, and report status "accepted", a positive fileCount, and visible evidence.`;
    }
  }

  if (
    receipt?.type === 'blocker' &&
    validFormProgress(receipt.formProgress) &&
    receipt.formProgress.acceptedUploadCount < accepted.length
  ) {
    return `formProgress.acceptedUploadCount must include the ${accepted.length} verified staged upload(s). Inspect the current tab and correct the receipt without uploading them again.`;
  }
  return null;
}

function outcomeError(receipt, task) {
  if (receipt.type === 'blocker') {
    if (
      !blockerCodes.has(receipt.blockerCode) &&
      !invalidAutomaticBlockers.has(receipt.blockerCode)
    ) {
      return 'Return a supported blockerCode; put explanatory text in message.';
    }
    if (
      receipt.resumePhase &&
      !['eligibility', 'verification', 'form', 'confirmation'].includes(
        receipt.resumePhase
      )
    ) {
      return 'resumePhase must be eligibility, verification, form, or confirmation.';
    }
    return null;
  }
  if (
    receipt.type !== 'result' ||
    !terminalResultStatuses.has(receipt.status)
  ) {
    return 'Return a supported result status or one concrete blocker.';
  }
  if (
    receipt.status !== 'submission_outcome_unknown' &&
    (!receipt.details?.exactResult ||
      !(
        receipt.resultUrl ||
        receipt.details?.evidenceUrl ||
        receipt.details?.evidenceRef
      ))
  ) {
    return 'An evidenced result requires details.exactResult and resultUrl, details.evidenceUrl, or details.evidenceRef. Inspect the current receipt; never submit again.';
  }
  const audit = auditResult({
    runId: task.runId,
    status: receipt.status,
    message: receipt.message || `Recorded ${receipt.status}.`,
    resultUrl: receipt.resultUrl,
    details: receipt.details,
    idempotencyKey: task.idempotencyKey,
  });
  return audit.valid ? null : audit.errors.join(' ');
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseQueueIds(summary, requested) {
  const queues = Array.isArray(summary?.queues) ? summary.queues : [];
  if (requested.length)
    return requested.filter(
      (id) =>
        !queues.some((queue) => queue.id === id && queue.mode === 'assisted')
    );
  return queues
    .filter((queue) => ['queued', 'running'].includes(queue.status))
    .filter((queue) => queue.mode !== 'assisted')
    .map((queue) => queue.id)
    .filter(Boolean);
}

function executionEvidence(plan, receipts, controls, pageChanged = false) {
  return {
    planId: plan.planId,
    requiredRefs: plan.requiredExecutions.map((entry) => entry.ref),
    receipts: receipts.map(({ ref, status }) => ({ ref, status })),
    observedFields: (Array.isArray(controls) ? controls : [])
      .filter((control) => String(control?.ref || '').trim())
      .map((control) => ({
        ref: String(control.ref).slice(0, 200),
        label: String(control?.label || '').slice(0, 500),
        kind: String(control?.kind || '')
          .toLowerCase()
          .slice(0, 100),
        required: control?.required === true,
        valuePresent: Boolean(String(control?.value || '').trim()),
      })),
    pageChanged: Boolean(pageChanged),
  };
}

function runtimeEvidenceValid(blockerCode, evidence) {
  if (!runtimeBlockers.has(blockerCode)) return true;
  if (!evidence || typeof evidence !== 'object') return false;
  if (typeof evidence.tool !== 'string' || !evidence.tool.trim()) return false;
  if (typeof evidence.callId !== 'string' || !evidence.callId.trim())
    return false;
  if (Number.isNaN(new Date(evidence.observedAt).getTime())) return false;
  if (blockerCode === 'runtime_confirmation_required') {
    return evidence.decision === 'confirmation_required';
  }
  if (blockerCode === 'runtime_denial') return evidence.decision === 'denied';
  return evidence.decision === 'failed';
}

export async function runSequentialSession(io, options = {}) {
  const requestedQueueIds = options.queueIds ?? [];
  const blocked = [];
  let cursor = 0;
  let claimedCount = 0;

  async function claimNext() {
    const summary = await io.cli(['queue']);
    const queueIds = parseQueueIds(summary, requestedQueueIds);
    const settlements = [];
    for (let attempt = 0; attempt < queueIds.length; attempt += 1) {
      const index = (cursor + attempt) % queueIds.length;
      const queueId = queueIds[index];
      const task = await io.cli(['next', '--queue-id', queueId], {
        allowFailureResult: true,
      });
      cursor = (index + 1) % Math.max(queueIds.length, 1);
      if (task?.executable === false) {
        if (task.leaseReleased !== true) {
          return { stop: true, reason: 'claim_release_unknown', task, summary };
        }
        continue;
      }
      if (task?.runId && task?.lease?.leaseId) return { task, summary };
      if (task?.claim === null && task?.settlement) {
        settlements.push({ queueId, ...task.settlement });
      }
    }
    return { task: null, summary, settlements };
  }

  while (true) {
    await io.flushDeliveries?.();
    const claimed = await claimNext();
    if (claimed.stop) {
      return io.emit({
        type: 'runner_stopped',
        reason: claimed.reason,
        task: claimed.task,
        blocked,
      });
    }
    if (!claimed.task) {
      const queues = Array.isArray(claimed.summary?.queues)
        ? claimed.summary.queues
        : [];
      const settlements = Array.isArray(claimed.settlements)
        ? claimed.settlements
        : [];
      const terminalActions = new Set([
        'batch_handoff',
        'campaign_complete',
        'queue_stopped',
      ]);
      const allSettled =
        settlements.length > 0 &&
        settlements.every((settlement) =>
          terminalActions.has(settlement.nextAction)
        );
      const noSelectedQueues =
        settlements.length === 0 &&
        parseQueueIds(claimed.summary, requestedQueueIds).length === 0;
      const legacyQueues = queues.filter(
        (queue) =>
          queue.mode === 'assisted' &&
          ['queued', 'running'].includes(queue.status) &&
          (!requestedQueueIds.length || requestedQueueIds.includes(queue.id))
      );
      if (allSettled || noSelectedQueues) {
        const pendingLogCount = (await io.flushDeliveries?.(true)) || 0;
        const skillUpdate =
          claimed.summary?.skillUpdate ||
          queues.find((queue) => queue?.skillUpdate)?.skillUpdate ||
          settlements.find((settlement) => settlement?.skillUpdate)?.skillUpdate ||
          null;
        return io.emit({
          type: 'campaign_finished',
          pendingLogCount,
          logDeliveryComplete: pendingLogCount === 0,
          campaignComplete:
            legacyQueues.length === 0 &&
            (noSelectedQueues ||
              settlements.every(
                (settlement) => settlement.campaignComplete === true
              )),
          terminalReason: noSelectedQueues
            ? legacyQueues.length
              ? 'legacy_configuration_required'
              : 'no_selected_queues'
            : settlements.some(
                  (settlement) => settlement.nextAction === 'batch_handoff'
                )
              ? 'batch_handoff'
              : settlements.some(
                    (settlement) => settlement.nextAction === 'queue_stopped'
                  )
                ? 'queue_stopped'
                : 'campaign_complete',
          claimedCount,
          blocked,
          settlements,
          queues,
          legacyQueues,
          ...(skillUpdate
            ? {
                skillUpdate,
                userReminder: skillUpdate.message,
              }
            : {}),
        });
      }
      await io.emit({
        type: 'runner_waiting',
        signal: 'CONTINUE_REQUIRED',
        campaignComplete: false,
        continueRequired: true,
        nextAction:
          settlements.find(
            (settlement) => settlement.nextAction === 'continue_claiming'
          )?.nextAction ||
          settlements.find(
            (settlement) => settlement.nextAction === 'refresh_queue'
          )?.nextAction ||
          'wait_for_active_workers',
        claimedCount,
        blocked,
        settlements,
        queues,
      });
      await io.wait(5_000);
      continue;
    }

    let task = claimed.task;
    claimedCount += 1;
    const stopHeartbeat = io.startHeartbeat(task);
    let plan;
    let receipts = [];
    const appliedProgressReceipts = new Map();
    let observedControls = [];
    let currentUrl = task.submissionUrl;
    let tabId;
    const stagedAssets = new Map();
    try {
      await io.emit({ type: 'task_preparing', runId: task.runId, continueRequired: true });
      task = await prepareTaskAnswers(io, task);
      const browserTask = {
        ...task,
        browser: {
          ...task.browser,
          preserveAfterSubmission: false,
          preserveAfterAnyFormProgress: true,
          preserveEveryProgressedTab: true,
        },
      };
      await io.emit({
        type: 'task_prepared',
        runId: task.runId,
        productCache: task.productCache,
        answerPreparation: task.answerPreparation,
        continueRequired: true,
      });
      const progress = async (status, event) =>
        io.cli([
          'log',
          '--run-id',
          task.runId,
          '--lease-id',
          task.lease.leaseId,
          '--event-id',
          randomUUID(),
          '--occurred-at',
          new Date().toISOString(),
          '--event',
          event,
          '--status',
          status,
          '--message-file',
          await io.textFile(
            'progress-message',
            `Browser workflow entered ${status}.`
          ),
        ]);
      await progress('inspecting', 'browser_opened');
      const inspectRequestId = randomUUID();
      const inspection = await requestReceipt(
        io,
        {
          type: 'browser_action_required',
          action: 'open_and_inspect',
          requestId: inspectRequestId,
          submissionUrl: task.submissionUrl,
          task: browserTask,
          loginPolicy: googleLoginPolicy,
          interactionPolicy: browserInteractionPolicy,
        },
        inspectionError
      );
      currentUrl = inspection.currentUrl || currentUrl;
      tabId = inspection.tabId;
      observedControls = inspection.controls;
      plan = planFormFields(task, inspection.controls, {
        platformDomain: task.platformDomain,
      });
      // Once a browser mutation is possible, an expired lease must not be
      // automatically requeued as an untouched task.
      await progress('form_in_progress', 'form_started');

      while (true) {
        if (plan.requiredExecutions.length === 0) break;
        const fillRequestId = randomUUID();
        const fill = await requestReceipt(
          io,
          {
            type: 'browser_action_required',
            action: 'apply_form_plan',
            requestId: fillRequestId,
            runId: task.runId,
            tabId,
            submissionUrl: task.submissionUrl,
            currentUrl,
            plan,
            loginPolicy: googleLoginPolicy,
            interactionPolicy: browserInteractionPolicy,
          },
          (receipt) =>
            receipt.type !== 'form_execution' ||
            receipt.planId !== plan.planId ||
            !Array.isArray(receipt.receipts)
              ? 'Return type form_execution, the exact planId, and a receipts array for the fields already applied.'
              : null
        );
        receipts = fill.receipts;
        for (const receipt of receipts) {
          if (receipt?.status === 'applied') {
            appliedProgressReceipts.set(
              `${plan.planId}:${String(receipt.ref || '')}`,
              receipt
            );
          }
        }
        const validation = validateFormExecutionReceipts(plan, receipts);
        if (!validation.complete || fill.pageChanged) {
          await io.emit({
            type: 'receipt_rejected',
            code: fill.pageChanged
              ? 'PAGE_CHANGED_REINSPECTION_REQUIRED'
              : 'INCOMPLETE_FORM_EXECUTION',
            runId: task.runId,
            planId: plan.planId,
            pending: validation.pending,
            rejected: validation.rejected,
          });
          if (fill.pageChanged) {
            const reinspectionId = randomUUID();
            const reinspection = await requestReceipt(
              io,
              {
                type: 'browser_action_required',
                action: 'reinspect',
                requestId: reinspectionId,
                runId: task.runId,
                tabId,
                submissionUrl: task.submissionUrl,
                currentUrl: fill.currentUrl || currentUrl,
                loginPolicy: googleLoginPolicy,
                interactionPolicy: browserInteractionPolicy,
              },
              inspectionError
            );
            currentUrl = reinspection.currentUrl || currentUrl;
            observedControls = reinspection.controls;
            plan = planFormFields(task, reinspection.controls, {
              platformDomain: task.platformDomain,
            });
            receipts = [];
          }
          continue;
        }
        currentUrl = fill.currentUrl || currentUrl;
        break;
      }

      resolutionLoop: while (true) {
        const uploads = await stageTaskUploads(
          io,
          task,
          observedControls,
          stagedAssets
        );
        const answerContext = groundedAnswerContext(task, plan);
        let decision;
        while (true) {
          const decisionRequestId = randomUUID();
          decision = await requestReceipt(
            io,
            {
              type: 'browser_action_required',
              action: 'resolve_then_submit_or_block',
              requestId: decisionRequestId,
              runId: task.runId,
              tabId,
              submissionUrl: task.submissionUrl,
              currentUrl,
              unresolved: plan.unresolved,
              fieldAnswers: task.fieldAnswers,
              submissionFields: task.resource?.submissionFields || [],
              answerPreparation: task.answerPreparation,
              ...answerContext,
              blockers: plan.blockers,
              authorization: task.authorization,
              projectId: task.projectId,
              uploads,
              uploadPolicy: {
                mode: 'automatic_temp_staging',
                sourcePaths: 'uploads[].files[].path',
                attachBeforeOutcome: true,
                browserAction: 'use_current_runtime_file_upload',
                verification:
                  'selected_filename_thumbnail_or_completed_upload_state',
                requireUploadReceipts: true,
                nativeFilePicker: 'do_not_leave_open',
              },
              executionMode: task.executionMode,
              loginPolicy: googleLoginPolicy,
              interactionPolicy: browserInteractionPolicy,
              knownFormProgress: {
                filledFieldCount: appliedProgressReceipts.size,
                acceptedUploadCount: 0,
                advancedStep: false,
              },
            },
            (receipt) =>
              outcomeError(receipt, task) ||
              uploadCompletionError(receipt, uploads) ||
              googleLoginBlockerError(
                receipt,
                [...appliedProgressReceipts.values()]
              ) ||
              blockerTabDispositionError(
                receipt,
                [...appliedProgressReceipts.values()]
              )
          );
          if (
            decision.type === 'blocker' &&
            task.executionMode === 'automatic' &&
            invalidAutomaticBlockers.has(decision.blockerCode)
          ) {
            await io.emit({
              type: 'receipt_rejected',
              code: 'INVALID_AUTOMATIC_BLOCKER',
              runId: task.runId,
              nextAction: 'continue_automatic_submission',
            });
            continue;
          }
          const groundedAnswerError = groundedAnswerBlockerError(
            decision,
            answerContext
          );
          if (groundedAnswerError) {
            await io.emit({
              type: 'receipt_rejected',
              code: 'GROUNDED_ANSWER_REQUIRED',
              runId: task.runId,
              message: groundedAnswerError,
              nextAction: 'compose_from_product_context_and_continue',
            });
            continue;
          }
          if (
            decision.type === 'blocker' &&
            !runtimeEvidenceValid(
              decision.blockerCode,
              decision.runtimeEvidence
            )
          ) {
            await io.emit({
              type: 'receipt_rejected',
              code: 'INVALID_RUNTIME_BLOCKER_EVIDENCE',
              runId: task.runId,
            });
            continue;
          }
          break;
        }
        const formExecution = executionEvidence(
          plan,
          receipts,
          observedControls,
          decision?.pageChanged
        );

        if (decision.type === 'blocker') {
          const formFile = await io.jsonFile('form-execution', formExecution);
          const runtimeFile = decision.runtimeEvidence
            ? await io.jsonFile('runtime-evidence', decision.runtimeEvidence)
            : null;
          const args = [
            'defer',
            '--event-id',
            randomUUID(),
            '--occurred-at',
            new Date().toISOString(),
            '--run-id',
            task.runId,
            '--lease-id',
            task.lease.leaseId,
            '--reason',
            decision.blockerCode === 'login_required'
              ? 'awaiting_user_login'
              : 'blocked_user_action',
            '--blocker-code',
            decision.blockerCode,
            '--resume-phase',
            decision.resumePhase || 'form',
            '--idempotency-key',
            task.idempotencyKey,
            '--browser-session-alias',
            String(tabId || `run-${task.runId}`),
            '--current-url',
            decision.currentUrl || currentUrl,
            '--form-execution-file',
            formFile,
          ];
          if (runtimeFile) args.push('--runtime-evidence-file', runtimeFile);
          const settled = await io.cli(args);
          if (settled?.settled === false) {
            await io.emit({
              type: 'receipt_rejected',
              code: settled.code || 'DEFERRAL_REJECTED',
              runId: task.runId,
              nextAction: settled.nextAction || 'continue_automatic_submission',
            });
            continue resolutionLoop;
          }
          blocked.push({
            runId: task.runId,
            tabId,
            blockerCode: decision.blockerCode,
            currentUrl: decision.currentUrl || currentUrl,
            formProgress: decision.formProgress,
            tabDisposition: decision.tabDisposition,
          });
          const continueRequired =
            settled?.settlement?.continueRequired ?? true;
          await io.emit({
            type: 'task_settled',
            signal: continueRequired ? 'CONTINUE_REQUIRED' : 'SETTLED',
            runId: task.runId,
            outcome: 'deferred',
            settlement: settled.settlement,
            continueRequired,
          });
          break resolutionLoop;
        }

        if (
          decision.type !== 'result' ||
          !terminalResultStatuses.has(decision.status)
        ) {
          throw new Error('Expected a supported result or blocker receipt.');
        }
        const details = {
          ...(decision.details || {}),
          formExecution,
          idempotencyKey: task.idempotencyKey,
        };
        const detailsFile = await io.jsonFile('result-details', details);
        const messageFile = await io.textFile(
          'result-message',
          decision.message || `Recorded ${decision.status}.`
        );
        const args = [
          'result',
          '--event-id',
          randomUUID(),
          '--occurred-at',
          new Date().toISOString(),
          '--run-id',
          task.runId,
          '--lease-id',
          task.lease.leaseId,
          '--status',
          decision.status,
          '--message-file',
          messageFile,
          '--details-file',
          detailsFile,
          '--idempotency-key',
          task.idempotencyKey,
        ];
        if (decision.resultUrl) args.push('--result-url', decision.resultUrl);
        // Delivery retries replay only the same Blink event, never the external Submit.
        let settled;
        for (let attempt = 0; ; attempt += 1) {
          try {
            settled = await io.cli(args);
            break;
          } catch (error) {
            if (
              attempt >= 2 ||
              !/fetch failed|timeout|timed out|ECONNRESET|502|503|504/i.test(
                error.message
              )
            )
              throw error;
            await io.emit({
              type: 'delivery_retry',
              runId: task.runId,
              continueRequired: true,
              message:
                'Retrying the same saved Blink receipt; do not submit the website again.',
            });
            await io.wait(1_000 * (attempt + 1));
          }
        }
        const continueRequired = settled?.settlement?.continueRequired ?? true;
        await io.emit({
          type: 'task_settled',
          signal: continueRequired ? 'CONTINUE_REQUIRED' : 'SETTLED',
          runId: task.runId,
          outcome: decision.status,
          settlement: settled.settlement,
          continueRequired,
        });
        break resolutionLoop;
      }
    } catch (error) {
      // Stop renewing first. Cleanup bypasses a stop request, never lease ownership.
      await stopHeartbeat().catch(() => {});
      try {
        const release = await io.cli(
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
          release,
        });
      } catch (releaseError) {
        await io.emit({
          type: 'worker_release_pending',
          runId: task.runId,
          message:
            'Lease cleanup could not be confirmed. Heartbeats stopped; server expiry will recover the slot.',
        });
      }
      throw error;
    } finally {
      await stopHeartbeat();
    }
  }
}

async function createProcessIo(options) {
  let signalStop = false;
  let leaseDeadline = null;
  const stopOnSignal = () => {
    signalStop = true;
  };
  if (options.fileTransport) {
    process.on('SIGINT', stopOnSignal);
    process.on('SIGTERM', stopOnSignal);
  }
  const stateDir =
    options.stateDir || (await mkdtemp(join(tmpdir(), 'blink-sequential-')));
  await mkdir(stateDir, { recursive: true });
  const connectionArgs = options.connection
    ? ['--connection', resolve(options.connection)]
    : [];
  const reader = options.fileTransport
    ? null
    : createInterface({ input: process.stdin, crlfDelay: Infinity });
  const messages = [];
  const waiters = [];
  reader?.on('line', (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      value = { type: 'invalid_json' };
    }
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else messages.push(value);
  });
  const receive = () =>
    messages.length
      ? Promise.resolve(messages.shift())
      : new Promise((resolvePromise) => waiters.push(resolvePromise));
  const emit = async (value) => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return value;
  };
  const cli = async (args, behavior = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(
        process.execPath,
        [client, ...args, ...connectionArgs],
        {
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', rejectPromise);
      child.on('close', (code) => {
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          rejectPromise(
            new Error(`Blink client returned invalid JSON. ${stderr || stdout}`)
          );
          return;
        }
        if (code && !behavior.allowFailureResult) {
          rejectPromise(new Error(parsed?.error?.message || stderr || stdout));
          return;
        }
        resolvePromise(parsed);
      });
    });
  let heartbeatPromise = Promise.resolve();
  const startHeartbeat = (task) => {
    let stopped = false;
    leaseDeadline = Date.parse(task.lease?.expiresAt);
    const interval = Math.max(
      10_000,
      Math.min(30_000, Number(task.lease?.heartbeatSeconds || 60) * 500)
    );
    const timer = setInterval(() => {
      if (stopped) return;
      heartbeatPromise = heartbeatPromise
        .then(() =>
          cli([
            'heartbeat',
            '--run-id',
            task.runId,
            '--lease-id',
            task.lease.leaseId,
          ])
        )
        .then((renewed) => {
          if (
            renewed?.leaseId === task.lease.leaseId &&
            renewed?.leaseExpiresAt
          ) {
            leaseDeadline = Date.parse(renewed.leaseExpiresAt);
          }
        })
        .catch((error) =>
          emit({
            type: 'heartbeat_failed',
            runId: task.runId,
            message: error.message,
          })
        );
    }, interval);
    timer.unref?.();
    return async () => {
      stopped = true;
      clearInterval(timer);
      await heartbeatPromise;
      leaseDeadline = null;
    };
  };
  const uniquePath = (label, contents) => {
    const digest = createHash('sha256')
      .update(contents)
      .digest('hex')
      .slice(0, 16);
    return join(stateDir, `${label}-${digest}`);
  };
  const io = {
    checkControl: async () => {
      if (
        leaseDeadline !== null &&
        (!Number.isFinite(leaseDeadline) || Date.now() >= leaseDeadline)
      ) {
        throw Object.assign(
          new Error('The worker no longer has a confirmed live lease.'),
          { code: 'LEASE_EXPIRED' }
        );
      }
      if (signalStop)
        throw Object.assign(new Error('Controller termination requested.'), {
          code: 'RUNNER_STOPPED',
        });
    },
    cli,
    emit,
    request: async (value) => {
      await emit(value);
      return receive();
    },
    startHeartbeat,
    wait: (milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    jsonFile: async (label, value) => {
      const text = JSON.stringify(value);
      const path = uniquePath(label, text) + '.json';
      await writeFile(path, text, { mode: 0o600 });
      return path;
    },
    textFile: async (label, value) => {
      const text = String(value);
      const path = uniquePath(label, text) + '.txt';
      await writeFile(path, text, { mode: 0o600 });
      return path;
    },
  };
  return options.fileTransport ? createFileTransport(io, options.stateDir) : io;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const queueIds = process.argv.flatMap((value, index) =>
    value === '--queue-id' ? [process.argv[index + 1]] : []
  );
  if (['start', 'status', 'respond', 'stop'].includes(process.argv[2])) {
    await runTransportCommand({
      command: process.argv[2],
      runnerPath: fileURLToPath(import.meta.url),
      stateDir: argument('state-dir'),
      connection: argument('connection'),
      queueIds,
      receiptFile: argument('receipt-file'),
      beforeStart:
        process.argv[2] === 'start'
          ? async () => {
              try {
                const update = await synchronizeInstalledSkill({
                  automatic: true,
                  connection: argument('connection'),
                });
                if (update.action === 'updated') {
                  process.stderr.write(
                    `Blink Skill synchronized ${update.fromVersion} -> ${update.version}.\n`
                  );
                }
              } catch (error) {
                // A transient update check must not strand an already
                // compatible installation. API compatibility remains
                // authoritative per request.
                process.stderr.write(
                  `Blink Skill update check failed; continuing with ${CLIENT_VERSION}: ${
                    error instanceof Error ? error.message : String(error)
                  }\n`
                );
              }
            }
          : undefined,
    });
  } else {
    const io = await createProcessIo({
      stateDir: argument('state-dir')
        ? resolve(argument('state-dir'))
        : undefined,
      connection: argument('connection'),
      fileTransport: process.argv.includes('--file-transport'),
    });
    try {
      await runSequentialSession(io, { queueIds });
    } catch (error) {
      process.exitCode = error.code === 'RUNNER_STOPPED' ? 0 : 1;
      await io.emit({
        type:
          error.code === 'RUNNER_STOPPED' ? 'runner_stopped' : 'runner_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
