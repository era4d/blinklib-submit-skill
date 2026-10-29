#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { controlIdentity } from './blink-optimization.mjs';

const ordinaryKinds = new Set(['text', 'textarea', 'email', 'url', 'number']);
const sensitive =
  /password|passwd|one.?time|otp|verification|security code|recovery|api.?key|access.?token|secret|captcha|turnstile|密码|验证码|密钥|口令/i;
const nonData =
  /search|coupon|promo|discount|credit card|card number|cvv|cvc|bank|payment|reciprocal|backlink|html code|dns|搜索|优惠码|银行卡|付款|支付|反向链接|验证码/i;
const unsafeChoice =
  /terms?|privacy|agree(?:ment)?|consent|newsletter|promotion|marketing|subscribe|captcha|turnstile|verification|payment|reciprocal|backlink|条款|隐私|同意|营销|订阅|验证码|付款|支付|反向链接/i;
const nonSubmissionEmail =
  /newsletter|promotion|marketing|subscribe|mailing list|account|login|sign[ -]?in|password|otp|verification|security|recovery|新闻简报|营销|订阅|登录|账户|验证|验证码|密码/i;

const clean = (value) => String(value ?? '').trim();
const normalized = (value) =>
  clean(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\([^)]*(?:required|optional|必填|选填)[^)]*\)/g, ' ')
    .replace(/\b(?:required|optional)\b|必填|选填/g, ' ')
    .replace(/[＊*：:？?]/g, ' ')
    .replace(/[_/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const validHttpUrl = (value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

function ownerParts(product) {
  const full = clean(product.ownerName || product.founder || product.username);
  const parts = full.split(/\s+/).filter(Boolean);
  return {
    full,
    first: parts[0] || '',
    last: parts.length > 1 ? parts.slice(1).join(' ') : '',
  };
}

const productNameField =
  /^(?:product|tool|startup|software|app|website|service|project) name$|^name of (?:the )?(?:product|tool|startup|software|app|website|service|project)$|^(?:listing )?title$|^产品名称$|^工具名称$|^项目名称$/;
const companyNameField =
  /^(?:company|organization|organisation|business)(?: name)?$|^公司(?:名称)?$/;
const submitterNameField =
  /^(?:name|(?:first|given|last|family|sur) name|surname|full name|(?:your|submitter|contact|founder|owner)(?: full)? name)$|^(?:姓名|姓|名|联系人姓名|创始人姓名)$/;

function companyIdentity(product) {
  return {
    value: product.companyName || product.productName || product.name,
    source: product.companyName ? 'companyName' : 'productName',
  };
}

// Crawled profile prose is evidence for composition, not a prepared answer.
export function needsProseRewrite(field, value, product) {
  if (
    !(
      ['long_text', 'textarea', 'article'].includes(field.type || field.kind) ||
      /describ|description|summary|overview|about|介绍|描述|简介|概述/i.test(
        `${field.key || ''} ${field.label || ''}`,
      )
    )
  )
    return false;
  const text = clean(value);
  if (!text) return false;
  if (
    /(?:^|\n)\s*(?:Website (?:title|description)\s*:|Site text\s*:)|<\/?(?:html|body|nav|footer|script)\b/i.test(
      text,
    ) ||
    (field.type !== 'article' &&
      /(?:^|\n)\s*Source\s*:\s*https?:\/\//i.test(text))
  )
    return true;
  const normalize = (item) =>
    clean(item)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '');
  const answer = normalize(text);
  const cjk =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
      text,
    );
  if (answer.length < (cjk ? 8 : 16)) return false;
  const width = Math.min(answer.length, cjk ? 12 : 24);
  const sources = Object.values(product || {})
    .filter((item) => typeof item === 'string')
    .map(normalize)
    .filter((item) => item.length >= width);
  const copied = new Uint8Array(answer.length);
  for (let index = 0; index <= answer.length - width; index++) {
    if (
      sources.some((source) =>
        source.includes(answer.slice(index, index + width)),
      )
    )
      copied.fill(1, index, index + width);
  }
  return copied.reduce((count, item) => count + item, 0) / answer.length >= 0.5;
}

function reusableValue(product, label, platformDomain) {
  const target = normalized(label);
  const domain = clean(platformDomain)
    .toLowerCase()
    .replace(/^www\./, '');
  const matches = (
    Array.isArray(product.reusableAnswers) ? product.reusableAnswers : []
  )
    .filter((answer) => {
      if (!answer || typeof answer !== 'object') return false;
      const answerDomain = clean(answer.platformDomain)
        .toLowerCase()
        .replace(/^www\./, '');
      if (answerDomain && answerDomain !== domain) return false;
      return (
        normalized(answer.question) === target ||
        normalized(answer.key) === target
      );
    })
    .sort(
      (left, right) =>
        Number(Boolean(right.platformDomain)) -
        Number(Boolean(left.platformDomain))
    );
  const answer = matches[0];
  return answer?.answer
    ? { value: clean(answer.answer), source: `reusableAnswers.${answer.key}` }
    : null;
}

function preparedFieldValue(task, control) {
  const fields = task?.resource?.submissionFields;
  if (!Array.isArray(fields) || !task.fieldAnswers) return null;
  const identities = [control.name, control.key]
    .map(normalized)
    .filter(Boolean);
  const matches = fields.filter(
    (field) =>
      normalized(field.label) === normalized(control.label) ||
      identities.includes(normalized(field.key))
  );
  // Do not guess between similarly named questions or unrelated page controls.
  if (matches.length !== 1) return null;
  const field = matches[0];
  const value = task.fieldAnswers[field.key];
  if (!['string', 'number', 'boolean'].includes(typeof value) || !clean(value))
    return null;
  if (needsProseRewrite(field, value, task.product)) return null;
  return { value: clean(value), source: `fieldAnswers.${field.key}` };
}

function recipeFieldValue(task, control, recipe) {
  const mapping = recipe?.fields?.find((field) => field.identity === controlIdentity(control));
  const source = mapping?.source;
  if (!source || !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_-]+){0,3}$/.test(source) ||
    /__proto__|constructor|prototype/.test(source)) return null;
  let value = source.startsWith('fieldAnswers.') || source.startsWith('product.')
    ? task.product ? task : { product: task }
    : task.product || task;
  for (const key of source.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return null;
    value = value[key];
  }
  return ['string', 'number', 'boolean'].includes(typeof value) && clean(value)
    ? { value: clean(value), source } : null;
}

function fieldFact(label, product) {
  const name = normalized(label);
  const owner = ownerParts(product);
  const exact = (pattern) => pattern.test(name);
  const result = (value, source, candidates) => ({
    value: clean(value),
    source,
    candidates,
  });

  if (exact(productNameField))
    return result(product.productName || product.name, 'productName');
  if (exact(companyNameField) || exact(submitterNameField)) {
    const identity = companyIdentity(product);
    return result(identity.value, identity.source);
  }
  if (
    exact(
      /^(?:website|product|tool|startup|software|app|service|project)? ?(?:url|website|homepage|link)$|^official website$|^官网(?:地址)?$|^网站(?:地址)?$/
    )
  )
    return result(product.canonicalUrl || product.url, 'canonicalUrl');
  if (
    exact(
      /^(?:(?:your|submitter|founder|owner|contact|support|business|work|notification|publishing|submission|listing|result|reply) )?(?:e mail|email)(?: address)?$|^(?:email|e mail) (?:for )?(?:notification|publishing|submission|listing|result|reply|contact)$|^邮箱(?:地址)?$|^联系邮箱$|^通知邮箱$|^提交结果通知邮箱$/
    )
  )
    return result(product.contactEmail, 'contactEmail');
  if (
    exact(
      /^(?:short )?(?:tagline|slogan|one liner|one line description|pitch)$|^标语$|^一句话介绍$/
    )
  )
    return result(product.tagline, 'tagline');
  if (
    exact(
      /^(?:target )?(?:audience|users|customers|market)$|^who is (?:it|this) for$|^目标用户$|^目标市场$/
    )
  )
    return result(product.audience, 'audience');
  if (exact(/^(?:key |main |product )?features$|^功能(?:特点)?$|^核心功能$/))
    return result(product.features, 'features');
  if (exact(/^(?:primary |core |main )?keyword(?:s)?$|^tags?$|^关键词$|^标签$/))
    return result(product.coreKeyword, 'coreKeyword');
  if (exact(/^(?:product )?categor(?:y|ies)$|^industry$|^产品分类$|^行业$/))
    return result(product.categories, 'categories');
  if (exact(/^(?:pricing|price|pricing model)$|^价格$|^定价$/))
    return result(product.pricing, 'pricing');
  if (
    exact(
      /^(?:founded|founded at|year founded|launch year)$|^成立时间$|^成立年份$/
    )
  )
    return result(product.foundedAt, 'foundedAt');
  if (exact(/^(?:founder|creator|maker)$|^创始人$/))
    return result(
      product.founder || owner.full,
      product.founder ? 'founder' : 'ownerName'
    );
  if (exact(/^(?:user name|username|handle)$|^用户名$/))
    return result(product.username, 'username');
  for (const key of [
    'twitter',
    'linkedin',
    'facebook',
    'instagram',
    'github',
  ]) {
    if (exact(new RegExp(`^(?:${key})(?: profile| url| link)?$`)))
      return result(product[key], key);
  }
  if (exact(/^(?:video|demo video|youtube)(?: url| link)?$|^演示视频$/))
    return result(product.video, 'video');
  if (exact(/^(?:language|primary language)$|^语言$/))
    return result(product.language, 'language');
  return null;
}

function choiceFact(control, product) {
  const label = normalized(control.label);
  const group = normalized(
    control.groupLabel ||
      control.group ||
      control.section ||
      control.fieldset ||
      ''
  );
  const result = (source) => ({ checked: true, source });

  if (
    /\b(?:plans?|pricing)\b|availability of free and paid plans?/.test(group)
  ) {
    const pricing = normalized(product.pricing || product.pricingModel);
    if (label === 'free' && /\bfree(?:mium| trial)?\b|免费/.test(pricing))
      return result(product.pricing ? 'pricing' : 'pricingModel');
    if (
      label === 'paid' &&
      /\bfreemium\b|\bpaid\b|\bsubscription\b|\bone time\b|[$€£¥￥]|付费|订阅/.test(
        pricing
      )
    )
      return result(product.pricing ? 'pricing' : 'pricingModel');
  }

  if (
    /platforms?|ways? to use|available on|supported systems?|平台|使用方式/.test(
      group
    )
  ) {
    const explicit = normalized(
      Array.isArray(product.platforms)
        ? product.platforms.join(' ')
        : product.platforms
    );
    if (/^(?:website|web)$/.test(label)) {
      if (/\bweb(?:site)?\b/.test(explicit)) return result('platforms');
      if (validHttpUrl(product.canonicalUrl || product.url))
        return result('canonicalUrl');
    }
    const aliases = {
      extension: /\b(?:extension|browser extension)\b/,
      ios: /\bios\b/,
      android: /\bandroid\b/,
      macos: /\b(?:macos|mac os)\b/,
      windows: /\bwindows\b/,
      linux: /\blinux\b/,
      discord: /\bdiscord\b/,
      telegram: /\btelegram\b/,
      whatsapp: /\bwhatsapp\b/,
      twitter: /\b(?:twitter|x)\b/,
      slack: /\bslack\b/,
    };
    if (aliases[label]?.test(explicit)) return result('platforms');
  }
  return null;
}

function constrainedValue(fact, control) {
  const candidates = (fact.candidates?.length ? fact.candidates : [fact.value])
    .map(clean)
    .filter(Boolean);
  const maxLength = Number(control.maxLength);
  const minLength = Number(control.minLength);
  const fits = candidates.find(
    (value) =>
      (!Number.isFinite(maxLength) ||
        maxLength <= 0 ||
        value.length <= maxLength) &&
      (!Number.isFinite(minLength) ||
        minLength <= 0 ||
        value.length >= minLength)
  );
  if (!fits) return { reason: 'value_outside_length_constraints' };
  if (control.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fits))
    return { reason: 'invalid_email_value' };
  if (control.kind === 'url' && !validHttpUrl(fits))
    return { reason: 'invalid_url_value' };
  if (control.kind === 'number' && !/^-?\d+(?:\.\d+)?$/.test(fits))
    return { reason: 'non_numeric_value' };
  return { value: fits };
}

export function planFormFields(taskOrProduct, controls, options = {}) {
  const product = taskOrProduct?.product || taskOrProduct || {};
  const platformDomain =
    options.platformDomain || taskOrProduct?.platformDomain || '';
  const list = Array.isArray(controls) ? controls : [];
  const fields = [],
    unresolved = [],
    skipped = [],
    blockers = [];
  const refs = new Set();
  for (const control of list) {
    const ref = clean(control?.ref),
      label = clean(control?.label),
      kind = clean(control?.kind).toLowerCase();
    if (!ref || !label || refs.has(ref)) {
      skipped.push({ ref, label, reason: 'invalid_or_duplicate_control' });
      continue;
    }
    refs.add(ref);
    if (control.disabled || control.readOnly || control.hidden) {
      skipped.push({ ref, label, reason: 'unsupported_or_uneditable_control' });
      continue;
    }
    if (kind === 'checkbox') {
      if (control.checked === true) {
        skipped.push({ ref, label, reason: 'already_selected' });
        continue;
      }
      if (control.sensitive || unsafeChoice.test(label)) {
        skipped.push({ ref, label, reason: 'unsafe_or_out_of_scope_control' });
        continue;
      }
      const choice = choiceFact(control, product);
      if (!choice) {
        if (control.required === true)
          unresolved.push({
            ref,
            label,
            kind,
            required: true,
            reason: 'no_high_confidence_choice',
          });
        else skipped.push({ ref, label, reason: 'no_high_confidence_choice' });
        continue;
      }
      if (fields.length >= 20) {
        skipped.push({ ref, label, reason: 'batch_limit' });
        continue;
      }
      fields.push({
        ref,
        label,
        kind,
        operation: 'check',
        checked: true,
        source: choice.source,
      });
      continue;
    }
    if (!ordinaryKinds.has(kind)) {
      if (
        control.required === true &&
        ['select', 'radio', 'file'].includes(kind)
      ) {
        unresolved.push({
          ref,
          label,
          kind,
          required: true,
          reason:
            kind === 'file' ? 'required_asset_control' : 'requires_reasoning',
        });
      }
      skipped.push({ ref, label, reason: 'unsupported_or_uneditable_control' });
      continue;
    }
    if (kind === 'email' && nonSubmissionEmail.test(label)) {
      if (control.required === true) {
        unresolved.push({
          ref,
          label,
          kind,
          required: true,
          reason: 'out_of_scope_email_purpose',
        });
      }
      skipped.push({ ref, label, reason: 'unsafe_or_out_of_scope_control' });
      continue;
    }
    if (control.sensitive || sensitive.test(label) || nonData.test(label)) {
      if (control.required === true) {
        blockers.push({
          ref,
          label,
          kind,
          required: true,
          blockerCode: /captcha|turnstile|验证码/i.test(label)
            ? 'captcha'
            : 'email_verification',
          reason: 'human_verification_required',
        });
      }
      skipped.push({ ref, label, reason: 'unsafe_or_out_of_scope_control' });
      continue;
    }
    if (clean(control.value)) {
      skipped.push({ ref, label, reason: 'already_filled' });
      continue;
    }
    const canonicalName =
      productNameField.test(normalized(label)) ||
      companyNameField.test(normalized(label)) ||
      submitterNameField.test(normalized(label));
    const reusable = reusableValue(product, label, platformDomain);
    let fact = canonicalName
      ? fieldFact(label, product)
      : preparedFieldValue(taskOrProduct, control) ||
        recipeFieldValue(taskOrProduct, control, options.recipe) ||
        reusable ||
        (kind === 'email' && !nonSubmissionEmail.test(label)
          ? { value: clean(product.contactEmail), source: 'contactEmail' }
          : fieldFact(label, product));
    if (fact && needsProseRewrite(control, fact.value, product)) fact = null;
    if (!fact?.value) {
      unresolved.push({
        ref,
        label,
        kind,
        required: control.required === true,
        minLength: control.minLength,
        maxLength: control.maxLength,
        reason: 'no_high_confidence_fact',
      });
      continue;
    }
    const constrained = constrainedValue(fact, { ...control, kind });
    if (!constrained.value) {
      unresolved.push({
        ref,
        label,
        kind,
        required: control.required === true,
        minLength: control.minLength,
        maxLength: control.maxLength,
        reason: constrained.reason,
      });
      continue;
    }
    if (fields.length >= 20) {
      skipped.push({ ref, label, reason: 'batch_limit' });
      continue;
    }
    fields.push({ ref, label, value: constrained.value, source: fact.source });
  }
  const requiredExecutions = fields.map((field) => ({
    ref: field.ref,
    operation: field.operation || 'set_value',
    source: field.source,
  }));
  const planId = createHash('sha256')
    .update(JSON.stringify({ fields, platformDomain }))
    .digest('hex')
    .slice(0, 24);
  return {
    schemaVersion: 2,
    planner: 'blink-form-plan',
    deterministic: true,
    planId,
    fields,
    requiredExecutions,
    executionPolicy: {
      requireReceiptForEveryPlannedField: true,
      forbidNavigationUntilComplete: true,
      forbidDeferralWithPendingPlannedFields: true,
    },
    unresolved,
    blockers,
    skipped,
    stats: {
      observed: list.length,
      planned: fields.length,
      pendingExecutions: requiredExecutions.length,
      requiredUnresolved: unresolved.filter((field) => field.required).length,
      requiredBlockers: blockers.filter((field) => field.required).length,
    },
  };
}

export function validateFormExecutionReceipts(plan, receipts) {
  const required = Array.isArray(plan?.requiredExecutions)
    ? plan.requiredExecutions
    : [];
  const list = Array.isArray(receipts) ? receipts : [];
  const byRef = new Map(list.map((receipt) => [receipt?.ref, receipt]));
  const pending = [];
  const rejected = [];
  for (const execution of required) {
    const receipt = byRef.get(execution.ref);
    if (
      !receipt ||
      !['applied', 'rejected', 'stale'].includes(receipt.status)
    ) {
      pending.push(execution.ref);
      continue;
    }
    if (receipt.status !== 'applied') {
      rejected.push({
        ref: execution.ref,
        status: receipt.status,
        reason: clean(receipt.reason) || 'browser_action_not_applied',
      });
    }
  }
  return {
    planId: plan?.planId || null,
    complete: pending.length === 0 && rejected.length === 0,
    pending,
    rejected,
    appliedCount: required.length - pending.length - rejected.length,
    requiredCount: required.length,
  };
}

async function main() {
  const argument = (name) =>
    process.argv[process.argv.indexOf(`--${name}`) + 1];
  if (
    !process.argv.includes('--product-file') ||
    !process.argv.includes('--controls-file')
  ) {
    throw new Error(
      'Usage: blink-form-plan.mjs --product-file PATH --controls-file PATH [--platform-domain DOMAIN]'
    );
  }
  const product = JSON.parse(await readFile(argument('product-file'), 'utf8'));
  const controls = JSON.parse(
    await readFile(argument('controls-file'), 'utf8')
  );
  process.stdout.write(
    JSON.stringify(
      planFormFields(product, controls, {
        platformDomain: process.argv.includes('--platform-domain')
          ? argument('platform-domain')
          : '',
      })
    ) + '\n'
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
