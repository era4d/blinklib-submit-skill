# Blink Backlink Submit Skill

Portable Blink backlink-submission Skill for Codex and compatible agent runtimes.

## Install from Git

```bash
git clone https://github.com/era4d/blinklib-submit-skill.git backlink-submit
cp backlink-submit/connection.example.json backlink-submit/connection.json
```

Fill `connection.json` with the Blink URL and the scoped installation key issued
by Blink. Never commit that file; it is ignored by Git.

Install the folder in the Skill directory used by your agent runtime. Read
[`INSTALL.md`](INSTALL.md) for platform paths and connection validation.

## Update

Use the bundled atomic updater from the installed Skill directory:

```bash
node scripts/blink-skill-manager.mjs git-update
node scripts/blink-skill-manager.mjs git-update --ref v1.11.0
node scripts/blink-skill-manager.mjs rollback
```

After `git-update`, future automatic checks use GitHub. To return to Blink's
server-managed release channel, run:

```bash
node scripts/blink-skill-manager.mjs update --source api
```

A clean Git checkout can also be updated conventionally:

```bash
git pull --ff-only
```

Version tags such as `v1.11.0` are immutable release points; `main` is the latest
published release.

## Submission flow

1. The user selects projects/resources in Blink. Queue creation captures the product, resource questions, permissions, daily target, and deduplication identity.
2. `blink-sequential-runner.mjs start` synchronizes the installed release and creates/reconnects one persistent controller. The controller reserves up to three independent tasks, audits its payload, hydrates versioned product facts from cache/API, and starts lease heartbeats.
3. Saved answers and deterministic product fields are reused. Only missing site questions are sent in one answer-generation request. Unavailable AI leaves known facts usable; grounded narrative gaps can be composed later from the supplied product context.
4. The browser opens the exact queued URL and returns editable controls. A deterministic form plan matches labels/keys and field constraints; the browser applies it as a batch and returns field receipts. Changed pages trigger fresh inspection.
5. The browser resolves remaining grounded answers, uploads staged API assets with visible acceptance evidence, advances ordinary steps, and performs the single authorized final Submit. Login uses the existing browser session; after a confirmed callback the exact queued URL is reopened in the same task tab.
6. A genuine confirmation decision parks the original tab as **`awaiting_confirmation`** before the agent yields. Other blockers retain their own status. Deferral releases the lease, records the tab alias/current URL, and rotates to other runnable work. Ordinary automatic submission does not introduce extra approval steps.
7. Explicit submission evidence settles the result; an ambiguous final action becomes `submission_outcome_unknown` and cannot be blindly retried. Delivery repair replays the same event, never the website submission. Completed tabs close; progressed and confirmation-pending tabs remain available.
8. Once runnable work drains, the controller reports preserved tabs and their remaining actions. After the user's decision, `start --resume-run-id RUN_ID` claims a new lease and returns the original tab/session context. Waiting for confirmation is neither an accepted submission nor directory editorial approval.

## Performance controls (1.11.0)

| Priority | Implemented behavior | Invalidation and limits |
| --- | --- | --- |
| P0 | Per-attempt preparation, inspection, fill/upload and delivery timings; P50/P95, accepted submissions per active minute (overlapping worker windows count once), answer/asset/recipe reuse. The Blink queue page shows the last 7 days. | Numeric-only metrics reference an existing owned settlement event and are deduplicated by run/lease. User waiting is measured separately when a retained task resumes. The latest 2,000 metric records are sampled and the UI labels truncation. |
| P0 | Successful form recipes retain verified field-source mappings, step signatures and accepted upload purposes. Live inspection validates the recipe before reuse. | No values, volatile selectors or final actions are stored in recipes. Changed labels, types, options, lengths or upload constraints invalidate the mapping. Hosted forms use the exact submission route as their recipe identity. |
| P1 | One controller uses batch claims with three workers by default, reduces intake after browser failure and recovers after successful work. Independent preparation, uploads and browser requests overlap. | Every worker has its own lease, heartbeat, request IDs, tab and recovery record. `--concurrency 1` selects serial execution. All owned cleanup drains before termination. |
| P1 | Saved answers and generic product narratives are reused by project version, question, language and length constraints. Known upload assets are prefetched and shared concurrent downloads are coalesced. | Answers and binary asset metadata are private to the authenticated connection. Site-specific answers remain route-scoped. Every cached file is checked for existence, size and SHA-256; browser attachment still needs current visible acceptance evidence. Local caches expire after 7 days and have bounded entry counts. |
| P1 | `pendingRequests` enables independent browser work and receipt arrays; revision-based status long polling avoids unchanged reads. Queue summaries are reused for up to 10 seconds rather than queried for every task. | Same-tab actions remain sequential. Receipt correction never replays a browser mutation. Saved metrics/logs use the durable outbox, independently of website submission. |
| P2 | With at least three observed settled attempts, ranking adjusts for acceptance and measured active time. Explicit ordered mode keeps curated order. Two consecutive login, paid-only or unavailable outcomes start a cooldown. | Initial cooldowns are 6 hours, 7 days and 1 hour respectively; repeated blockers increase the delay up to 30 days. A successful attempt resets the streak. Confirmation waits, missing facts and runtime failures never trigger site cooldowns. Only this owner's queued tasks are delayed. |

When all remaining work is cooling down, the controller finishes with `terminalReason: "cooldown_wait"` and `nextAvailableAt`; it does not poll for hours or create a background schedule. Run it again at/after that time. Existing task lists show the cooling-until time.

After the user explicitly resolves a confirmation, use `start --resume-run-id RUN_ID`, repeating the flag only for other approved runs. The first request reinspects the exact retained tab and skips existing values. Do not automatically resume all held forms. Inspect every `activeLeases` entry and saved delivery when recovering an abnormal exit.

Never cache CAPTCHA responses, credentials, or final Submit actions. A recipe accelerates preparation; it cannot authorize a new action or replace current submission evidence. Reported local metrics do not imply a measured production speedup until real attempts accumulate.

## Shared cloud SOPs (1.11.0)

When the claim enables `sopKnowledge`, successful attempts contribute semantic
steps to the instance's shared knowledge library. The browser records the full
remaining workflow; the controller combines it with verified planner writes,
removes values and volatile refs, and queues an independent contribution after
the result is acknowledged. Actual answers, credentials, screenshots and local
asset paths are excluded. A shared final-button descriptor records the workflow
boundary; it is never a replayable command or authorization to submit again.

All users on that Blink instance can receive compatible candidates in subsequent
claims. Exact resource, submission route, login context, locale and fresh form
signatures prevent unrelated forms from sharing mappings. Independent success
promotes a version; concrete structural failures suspend it, and stable older
versions remain available. See [cloud-sops.md](references/cloud-sops.md) for the
trace contract, privacy boundaries, confidence thresholds and delivery behavior.
