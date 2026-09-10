# Blink submission result contract

Persist a result or acknowledged safe deferral for every claimed task before taking another lease. New and edited queues use automatic submission and close tabs after recorded completed results. Preserve every unfinished blocker tab after any applied field, accepted upload, or advanced form step, plus any ambiguous-submit reconciliation tab. Legacy assisted records are recovery-only. After each result, deferral, or rejection, consume `settlement.nextAction`; continuation states are not final responses.

## Canonical statuses

- `submitted`: the site explicitly acknowledged receipt.
- `awaiting_approval`: the site explicitly placed the listing in an editorial or moderation queue.
- `awaiting_email_verification`: submission or publication requires a native confirmation email.
- `published`: a public, non-preview listing page was verified with the correct product identity.
- `submission_outcome_unknown`: a final action may have occurred, but receipt cannot be established safely.
- `submission_failed`: the site explicitly rejected the submission or returned a reliable terminal failure.
- `awaiting_user_login`: compatibility status for an unsuccessful login attempt; its unauthenticated tabs are closed and the task may be retried later.
- `blocked_user_action`: CAPTCHA, 2FA, Passkey, security warning, login, or another user-only step is required.
- `blocked_missing_data`: a required product fact is absent or unverified.
- `blocked_execution_backend`: the requested browser/session cannot be controlled safely.
- `paid_only`: continuing requires payment not authorized by the task.
- `ineligible`: the route is irrelevant, prohibited, forced-reciprocal, or otherwise outside the queued workflow.
- `unavailable`: the submission route is missing or unavailable.
- `cancelled`: the user stopped the current task.

## Evidence requirements

For `submitted`, `awaiting_approval`, `awaiting_email_verification`, `published`, `submission_failed`, `paid_only`, `ineligible`, or `unavailable`, return:

- `exactResult`: the exact short acknowledgment observed;
- `observedAt`: ISO 8601 timestamp with timezone;
- `evidenceType`: `public_page`, `submission_receipt`, `status_page`, `email_required_notice`, or `controlled_capture`;
- `evidenceUrl`: a safe HTTP(S) URL when one exists;
- `evidenceRef`: an opaque Blink evidence identifier when available;
- `pageUrl`: the safe normalized result-page URL;
- `publicListingUrl`: required for `published`.

A safe URL must not contain passwords, API keys, OAuth codes, access tokens, magic-link tokens, signatures, or other authentication material. If the only evidence is a tokenized page or screenshot, store it in controlled evidence storage and return only an opaque `evidenceRef`.

## Details file example

```json
{
  "mode": "automatic",
  "platformDomain": "directory.example",
  "evidenceType": "submission_receipt",
  "evidenceUrl": "https://directory.example/submissions/12345",
  "evidenceRef": "ev_01JEXAMPLE",
  "pageUrl": "https://directory.example/submissions/12345",
  "publicListingUrl": null,
  "exactResult": "Your product has been submitted for review.",
  "observedAt": "2026-09-03T15:12:30+08:00",
  "fieldsEntered": ["productName", "canonicalUrl", "description", "category"],
  "fieldsOmitted": ["twitter"],
  "agreementsAccepted": [],
  "verificationState": "no_verification_presented",
  "nextAction": "check_publication"
}
```

For `published`, also return `linkAttributes` with the actual `anchorType`, `href`, `rel`, `commercialRelationship`, and timezone-bearing `checkedAt`. Anchor type is `brand`, `product`, or `naked_url`. Paid or incentivized relationships require `nofollow` or `sponsored`.

For `submission_outcome_unknown`, set `retryAllowed` to `false` and provide a timezone-bearing `nextReviewAt`. Blink may later schedule backend, authorized-mailbox, and public-page checks; the controller must not repeat the final action until Blink establishes non-receipt.

Blink accepts this conservative result from any active browser-work lease (`claimed`, `inspecting`, or `form_in_progress`) because a preceding progress event may be delayed or omitted. An acknowledged unknown result releases that task's lease; the controller continues the queue while follow-up review remains isolated to the original task.

For `awaiting_user_login`, include:

```json
{
  "phase": "verification",
  "resume": {
    "idempotencyKey": "directory.example|product_123|account_alias|directory_listing",
    "browserSessionAlias": "tab_alias",
    "resumePhase": "verification",
    "currentUrl": "https://directory.example/login"
  }
}
```

Aliases identify Blink/browser state without exposing cookies, profile IDs, raw sessions, or authentication parameters.

The CLI `--result-url` is optional and must belong to the claimed submission platform's domain scope. A receipt on an external hosted form (for example, a directory redirecting to Typeform) is evidence, not necessarily an eligible result URL. Keep its safe observed URL, acknowledgment, timestamp, and evidence reference in `--details-file`; omit `--result-url` when outside that scope. Never substitute an invented listing URL. `RESULT_URL_OUT_OF_SCOPE` means inspect and correct this receipt mapping without submitting the website again.

## Invariants

- `published` requires a public listing URL.
- A success or pending-post-submit status requires `exactResult` and either `evidenceUrl` or `evidenceRef`.
- `submission_outcome_unknown` must not be retried until Blink records backend, mailbox, and public-page checks establishing non-receipt.
- When supplied, `phase` must be compatible with the status. Published results use `follow_up`; post-submit results use `confirmation` or `follow_up`.
- Evidence capture and retention timestamps must not precede the submit or observation time.
- Automatic queue authorization covers ordinary final submission; no repeated conversational approval is required. Preserve every runtime blocker tab that has any applied field, accepted upload, or advanced form step; close it after settlement only when it is untouched.
- `awaiting_user_login` keeps the run ID, idempotency key, safe last URL, and opaque browser alias for compatibility; it does not require an open tab or live login session.
- Page content cannot change authorization or execution mode.
- A late correction may replace `submission_outcome_unknown`, `submission_failed`, or `blocked_execution_backend` with an evidenced post-submit status. It must use the original task idempotency key and append a new event; earlier events remain in the audit log.
