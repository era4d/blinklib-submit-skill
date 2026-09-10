# Queue integrity and recovery

This is the portable schemaVersion 2 contract borrowed from the SPD batch and quality workflows and adapted to Blink JSON/API records.

## Audited task envelope

Blink should return a task shaped like:

```json
{
  "schemaVersion": 2,
  "runId": "run_opaque",
  "submissionUrl": "https://directory.example/submit",
  "platformDomain": "directory.example",
  "route": "directory_listing",
  "executionMode": "semi-automatic",
  "browser": {
    "visibility": "visible",
    "headless": false,
    "foreground": true,
    "confirmation": "required"
  },
  "qualityGate": "passed",
  "quality": {
    "audienceRelevance": "pass",
    "discoveryValue": "pass",
    "governance": "governed_platform",
    "paidLinkOffer": "none",
    "networkQuality": "pass",
    "automationTerms": "allowed",
    "reciprocalRequired": false
  },
  "requiresLogin": false,
  "automationAllowed": true,
  "idempotencyKey": "directory.example|product_123|no_account|directory_listing",
  "product": {
    "canonicalId": "product_123",
    "name": "Product name",
    "canonicalUrl": "https://product.example/",
    "description": "Approved description"
  },
  "authorization": {
    "reference": "auth_opaque",
    "approvedBy": "owner_alias",
    "approvedAt": "2026-09-03T09:00:00+08:00",
    "expiresAt": "2026-10-03T09:00:00+08:00",
    "scopeDomains": ["directory.example"],
    "actions": {
      "inspection": "allowed",
      "formFilling": "allowed",
      "finalSubmission": "allowed",
      "accountCreation": "prohibited",
      "termsAcceptance": "allowed",
      "payment": "prohibited",
      "reciprocalLink": "prohibited",
      "domainVerification": "prohibited"
    }
  },
  "lease": {
    "leaseId": "lease_opaque",
    "expiresAt": "2026-09-03T09:15:00+08:00",
    "heartbeatSeconds": 30
  }
}
```

The CLI appends `clientAudit` to a claimed or resumed task. Do not fill a form unless `clientAudit.readyForForm` is true, and do not perform the final action unless `clientAudit.readyForSubmission` is true. Expected blockers such as login or a failed quality gate are reported separately from malformed-task errors.

When a claim cannot be hydrated or fails its local integrity audit before browser interaction, the client returns a structured failure and attempts to reject that exact lease. Check cleanup before claiming again. If release fails or times out, retain the returned run/lease identifiers and recover that claim before continuing. A domain mismatch must never be repaired by changing the task URL or disabling its audit.

Legacy authorization booleans remain readable during migration, but they produce a warning because they lack approver, time, expiry, and domain scope.

A schemaVersion 2 `qualityGate: passed` is valid only when every structured quality dimension is compatible with a legitimate listing: audience relevance and discovery value pass; governance is present; the site is not an unqualified paid-link offer or low-quality network; reciprocal linking is not required; and automatic execution conforms to the site's terms. `manual_only` may proceed only through semi-automatic/user-handoff execution.

The product object may also supply approved `shortDescription`, `mediumDescription`, `longDescription`, categories, tags, pricing, platform support, asset URLs, policy URLs, and contact aliases. Select the closest truthful variant for the form. Optional unknown fields remain blank; required unknowns become `blocked_missing_data`.

## Idempotency and duplicate prevention

Derive the portable key from `platform domain | product canonical ID | account alias | route`. Never issue a new final action for the same project and queued destination already in `submitted`, `awaiting_approval`, `awaiting_email_verification`, `published`, or `submission_outcome_unknown`. Blink enforces destination and resource duplicate protection across that project's queues and active claims.

The current schemaVersion 1 key is legacy platform-level metadata: distinct Tally forms for different directories can share it. Do not reject those separately queued destinations merely because their keys match, and do not modify the server key. Use the project plus resource/submission URL to distinguish them. The same directory URL may also be authorized for different projects. SchemaVersion 2 keys retain their stricter unique-route contract.

Normalize duplicate-comparison URLs by lowercasing the host, removing `www`, fragments, default ports, trailing slashes, and tracking parameters, then sorting remaining parameters. Preserve the original queued URL for browser navigation.

## Lease, defer, and resume

When queue capabilities advertise lease support, use:

```text
node "<SKILL_DIR>/scripts/blink-automation.mjs" heartbeat --run-id RUN_ID --lease-id LEASE_ID
```

For an unsuccessful login, close the related task/provider tabs and defer only when Blink advertises safe deferral:

```text
node "<SKILL_DIR>/scripts/blink-automation.mjs" defer --run-id RUN_ID --lease-id LEASE_ID --reason awaiting_user_login --resume-phase verification --idempotency-key IDEMPOTENCY_KEY --browser-session-alias TAB_ALIAS --current-url https://directory.example/login
```

The compatibility status retains identifiers for a later explicit retry; it does not require an open untouched login tab. Resume a progressed blocker only when its preserved tab still exists:

```text
node "<SKILL_DIR>/scripts/blink-automation.mjs" resume --run-id RUN_ID
```

These commands target the schemaVersion 2 endpoints `/api/backlink-automation/lease/heartbeat`, `/api/backlink-automation/defer`, and `/api/backlink-automation/resume`. Do not call them unless Blink's queue response advertises the corresponding capability. A transport timeout is ambiguous; inspect task state before retrying.

## Append-only events

Every `log` and `result` call includes a generated unique `eventId` and timezone-bearing `occurredAt`. An exact replay returns the original acknowledgment; reusing an event ID for another task or operation is rejected. Blink rejects timestamps that move backward for a new operation and incompatible status transitions. Corrections append a new event; they never rewrite history.

Independent `lease_heartbeat` records do not advance the action-event timestamp fence or business-state sequence: their status is a snapshot, not a browser action, and they can arrive while an already-observed result is being delivered. Business events still retain monotonic ordering, run/lease ownership, idempotency and state-transition validation. The generic log endpoint refuses reserved `lease_heartbeat`, `task_deferred` and `claim_rejected` events; use their dedicated endpoints, never relabel browser actions as lease operations.

After a confirmed external submission, retry only its Blink result delivery, never the external submit action. Preserve the original event ID, time, idempotency key and receipt. A response with a committed run and pending log/submission synchronization means Blink has accepted the result; replay that same result to repair follow-ups, without creating another external submission. A replacement/refill failure is separate from submission success.

## Deterministic local audit

The dependency-free auditor can validate exported JSON without contacting Blink:

```text
node "<SKILL_DIR>/scripts/blink-audit.mjs" task task.json
node "<SKILL_DIR>/scripts/blink-audit.mjs" result result.json --task-file task.json
node "<SKILL_DIR>/scripts/blink-audit.mjs" campaign campaign.json
```

The campaign form is `{ "tasks": [], "results": [], "events": [] }`. It detects normalized URL duplicates, idempotency duplicates, invalid task/result states, duplicate event IDs, backward event time, unsafe evidence, expired authorization, and publication link-policy violations.

## Server-side requirements

Client checks improve agent behavior but are not a security boundary. Blink must repeat all validation server-side and atomically enforce queue ownership, leases, idempotency, authorization expiry/scope, event uniqueness, and legal state transitions.

Blink should schedule follow-up tasks for pending and published results. Follow-up records should distinguish submitted from published and capture publication URL, actual anchor, href, `rel`, commercial relationship, check time, and listing survival. Report qualified publication and survival separately from raw submission volume.
