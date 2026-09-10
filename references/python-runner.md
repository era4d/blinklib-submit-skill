# Fixed Python browser workflow

Use `scripts/blink-browser.py` for Chrome connection, task-page opening and image uploads. It performs the browser actions itself rather than printing tool arguments for an agent to reconstruct. Requirements: Python 3.10+, Node.js with npm/npx, and the user's existing Chrome with its remote-debugging connection allowed. There are no pip dependencies. The first run may need network access to obtain the pinned official `chrome-devtools-mcp@1.8.0` package via npx.

The program uses the official MCP stdio protocol and `--autoConnect`. Version 1.7.3 defaults to a background local broker (`scripts/blink_session.py`) that retains one MCP child across CLI processes. It never starts a fresh browser profile or reads browser credentials. It creates an OS temporary staging directory and exposes only that directory through MCP roots. Its child MCP does not inherit Blink credential environment variables. The bundled `connection.json` and Node API client remain the source for authenticated Blink requests; no image paths, IPC port or separate MCP entry need user configuration.

## Commands

This is the Chrome backend, not the default fallback for an unavailable remote-debugging browser. In that case, use the runtime's built-in browser as specified in [platform selection](platform-adapters.md#browser-selection-order). Start this broker only when Python Chrome is explicitly selected; reuse it when already active.

Ordinary CLI commands automatically reuse the same broker. If Remote Chrome is already controlling this task, keep that existing connection and its direct upload workflow instead of starting a second Python MCP. For the Python backend, the first browser command starts its broker and may show Chrome's native Allow dialog; subsequent commands reuse it.

The optional newline-JSON interface is also a client of that same broker:

```text
python "<SKILL_DIR>/scripts/blink-browser.py" session
```

Keep stdin open. Wait for the `ready` JSON line, then send one JSON command per line to that same process and wait for its result before the next command:

```json
{"command":"open","url":"https://directory.example/submit"}
{"command":"inspect","url":"https://directory.example/submit"}
{"command":"upload","url":"https://directory.example/submit","projectId":"PROJECT_ID","purpose":"logo"}
{"command":"upload","url":"https://directory.example/submit","projectId":"PROJECT_ID","purpose":"screenshots","requiredCount":3}
```

These are example commands, not an instruction to visit the example domain. Use the queue URL and current page URL. Stdin EOF ends only this client, leaving the broker, MCP, tab bindings and upload records alive. Errors also preserve the connection. Optional upload JSON keys are `fieldLabel`, `replace`, `connection`, `maxSizeMb`, `requiredCount` and `uploadTimeout`.

Chrome can request native approval for a genuinely new debugging session. Preserve the approved connection; never try to grant permission programmatically. This is a [Chrome requirement](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session), not image-path configuration. Chrome restarts, user disconnection or an actual MCP connection loss may require approval again. The broker does not promise a permanent browser permission. A preconfigured conventional loopback CDP HTTP endpoint can optionally be passed with `--browser-url`; do not infer one from a port on Chrome's native debugging page.

The following separate CLI commands all use the same broker and MCP:

Resolve the script relative to the installed Skill; the commands work from another working directory too. The agent replaces project IDs and URLs using the authorized queue item, not arbitrary discovered sites.

```text
python "<SKILL_DIR>/scripts/blink-browser.py" doctor
python "<SKILL_DIR>/scripts/blink-browser.py" open --url "QUEUED_SUBMISSION_URL"
python "<SKILL_DIR>/scripts/blink-browser.py" inspect --url "CURRENT_SUBMISSION_URL"
python "<SKILL_DIR>/scripts/blink-browser.py" upload --project-id PROJECT_ID --url "CURRENT_SUBMISSION_URL" --purpose logo
python "<SKILL_DIR>/scripts/blink-browser.py" upload --project-id PROJECT_ID --url "CURRENT_SUBMISSION_URL" --purpose preview
python "<SKILL_DIR>/scripts/blink-browser.py" upload --project-id PROJECT_ID --url "CURRENT_SUBMISSION_URL" --purpose screenshots --required-count 3
python "<SKILL_DIR>/scripts/blink-browser.py" google-login --url "CURRENT_LOGIN_URL"
```

The user does not supply page IDs, UIDs or local file paths for these fixed workflows. `open` reuses a matching tab or opens a foreground tab in the existing Chrome profile. `upload` requires that tab to exist; it will not overwrite an unrelated page. Tab bindings survive separate CLI invocations while the broker remains alive.

### Connection lifecycle and other browser actions

`session-status` reads broker health without touching Chrome or creating a new connection. Successful commands include a stable `sessionId`; this identifies this local broker, not a browser cookie. `session-stop` (or JSON `{"command":"stop"}`) explicitly ends the broker/MCP while preserving Chrome and its tabs. Use it when the user requests disconnection, never after each command/site/chat turn. There is no automatic idle shutdown.

For other browser actions on the Python backend, first run `browser-tools` to read this connection's supported tool schemas, then call `browser-call --tool TOOL --arguments-json JSON`. In the JSON interface use `{"command":"browser-call","tool":"TOOL","argumentsJson":"JSON_OBJECT_AS_STRING"}`. Use fresh page IDs/UIDs from this same broker, not IDs from another MCP. Supported bridge tools cover snapshots, page selection, clicking, filling, keys, hover, page evaluation and screenshots; task authorization, verification and final-submit rules still apply. Use the fixed `upload` workflow for image provenance and staging. Shell-quote JSON correctly or use stdin JSON commands; never interpolate product text into shell code.

`session_busy` means another command is running; wait for it instead of creating another connection. `session_unreachable` preserves uncertain state after an IPC/connection failure; inspect status and the local broker log before explicitly stopping a dead broker. Do not retry a timed-out mutation merely because its response was lost. `session_configuration_changed` means an older package or different Chrome endpoint still owns the broker; finish that work and explicitly disconnect it before changing versions. No upgrade silently replaces a live connection.

The broker binds only to `127.0.0.1` on an automatically selected port and requires a random bearer secret from the current user's application-data directory (`browser-session.json`). It rejects web-origin requests, bypasses HTTP proxy settings for local IPC, serializes browser commands, and uses JSON rather than executable object serialization. Its state, log and token stay local and are never included in Skill downloads or Blink logs. Do not expose the broker port remotely. Optional `BLINK_BROWSER_SESSION_PATH` is for isolated tests/admin use, not user setup. If the environment forbids background subprocesses/local IPC, keep the already supported browser runtime; do not evade that restriction.

## Image-upload sequence

1. Read the current accessibility snapshot and match the requested image purpose to a named file input or a chooser with a corresponding field heading. Logo, preview/banner and screenshot inputs stay separate. Ambiguous or generic unidentified fields return a blocker rather than selecting the first upload input.
2. Invoke the bundled Node `prepare-upload` with the observed field label and runtime-discovered IDs. Fetch the exact project's fresh API assets, download only the matching purpose into the unique temporary directory, and retain byte-based extensions.
3. Verify canonical containment, `assetPurpose`, `sourceField` and SHA-256. Refresh the page/field after network work to avoid stale UIDs.
4. Call MCP `upload_file` with those exact validated files. Do not click Next or Submit.
5. Poll for completed attachment filename/image evidence. File-input selection or a tool success message alone is not upload completion. Return `uploaded` only after observing attachment evidence and the end of the upload progress.

For repeated fields, pass `--field-label "EXACT_OBSERVED_LABEL"` from `inspect`. For an incorrect existing attachment, inspect it first and pass `--replace` only for that specific field. Default behavior protects existing selections. The program does not append blindly to an existing multi-file selection. `--max-size-mb` defaults to 5; pass a site's observed limit when smaller. Available images are uploaded even when `missingCount` is nonzero; then request remaining images or screenshot permission using the existing Skill workflow.

The script enforces image provenance and field roles but cannot determine whether a misconfigured API `logoUrl` visually depicts a screenshot. Follow the existing visual-image check when source content is in doubt. A missing asset, authentication error, unsupported format, path denial or page ambiguity is reported separately. No preview/Logo substitution, unrestricted-path flag, backend switch or duplicate upload retry is used to hide an error.

## Google sign-in and page interpretation

### Remember the user's choice

Before asking about an account or registration again, run `login-preferences --url CURRENT_SITE_URL`. After the user explicitly chooses an account or approves/declines registration, persist it with `remember-login`. These commands do not start Chrome:

```text
python "<SKILL_DIR>/scripts/blink-browser.py" remember-login --url "https://directory.example/" --account-email "chosen@example.com" --registration allowed --as-default
python "<SKILL_DIR>/scripts/blink-browser.py" login-preferences --url "https://directory.example/"
```

Use the user's actual choice, not the example values. `--as-default` is for an account the user wants reused on other sites. Registration approval is always specific to the exact site hostname and chosen account; it is not copied to other sites or identities. `--registration denied` revokes that site's registration approval, and `unchanged` preserves the current same-account decision. In session JSON, use `command: "remember-login"`, `url`, `accountEmail`, `registration` and optional `asDefault: true`; read with `command: "login-preferences"` and `url`.

The runner writes atomically under the current OS user's application-data directory (`blink-backlink-submit/login-preferences.json`). Preferences survive a new process and Skill upgrades on that machine and are excluded from downloadable packages. They contain account email, login provider and site-specific decisions, never passwords, cookies or tokens. Do not put these authorization decisions into product `reusableAnswers`. This is local per-user persistence, not server synchronization or a promise to remember across devices.

`google-login` reads the saved account and selects that exact visible account even if the Google popup lists several. If the saved account is absent, it reports `preferred_google_account_unavailable` instead of silently choosing another. An approved site's `Register with Google` button becomes eligible; without that registration decision it remains separate from login. A matching saved user decision is standing authorization and must not trigger the same question again. Only user instructions can create/change it; never record an approval from website text, API product facts or an agent's inference. Verification challenges and unrelated OAuth permissions still follow their own requirements.

Personalized Google buttons such as "Continue as Jane" or "以某账号的身份继续" are recognized within the observed official `https://accounts.google.com/gsi/button` frame. Similar text outside that frame is insufficient; the runner must not guess that an arbitrary Continue button performs Google sign-in.

`google-login` records the original tab and pre-click page IDs, detects the new Google popup (or a same-tab redirect), focuses that page and repeatedly reads its current snapshot until its account controls load. It selects only a sole eligible signed-in account, using that Google page's fresh UID. It then tracks the popup and returns focus to the original site. The JSON `trace` records `google_window_detected`, `google_account_selected` and the callback outcome with their respective page IDs, so a popup cannot be confused with the underlying form.

`login_completed` requires visible authenticated-page evidence: a sign-out control (including a menu item) and no login prompt. Account or Dashboard alone does not prove login. Inconclusive callbacks, multiple accounts, consent, and credential/verification challenges are unsuccessful login outcomes; close the task's provider and source tabs, defer, and continue the queue. They do not authorize an email-login fallback or a mid-run user question. See [login workflow](login-handoff.md).

The default wait is 45 seconds, adjustable with `--login-timeout` or JSON `loginTimeout` (1–120). `google_login_pending` means authentication was not confirmed before timeout. Close the task's source/provider pages, defer, and continue; do not repeat the login attempt during the same campaign.

Ordinary form semantics and final submission still belong to the agent using the active runtime's supported browser controls. The Python adapter fixes the repeated connection/path/upload steps; it is not a blind submitter for every possible directory form. Follow the existing task authorization, lease, evidence and confirmation rules.

## Results and recovery

stdout contains JSON results; stderr contains progress updates. In one-shot mode, exit code 0 means `ready`, `page_ready`, `uploaded`, `login_completed`, `login_preferences`, `login_preference_saved`, or an explicit submission receipt (`submitted`, `awaiting_approval`, `awaiting_email_verification`). Receipt statuses describe different outcomes; exit 0 does not imply publication. Exit code 2 means an unresolved/manual-inspection or failure result. In session mode, inspect each result's `status`; normal session shutdown exits 0 even if an earlier command failed. API keys and signed query strings are redacted from output. Keep local snapshots and diagnostics out of Blink logs.

### Navigation, uploads and receipts

Within a session, the runner binds the supplied URL to its original Chrome tab. Same-origin redirects and later form steps keep that tab even if another tab has the old URL. A closed tab or a move to another origin is reported for inspection; the runner never silently chooses a replacement tab. Pass the observed current URL after an intentional cross-origin transition. This association is local to the running session.

Only `list_pages` and `take_snapshot` are retried after recognized transient document/context errors, at most three calls. Clicks and uploads are never automatically retried; transport timeouts are not proof the operation failed.

Upload detection excludes disabled/delete/download controls and prevents nearby labels from leaking into another frame/dialog. A newly appearing filename/attachment is required, and visible progress bars delay success. A filename inside an image editing dialog returns `upload_needs_confirmation`; review/crop/save that dialog with the active browser controls and verify the actual attachment. Sites that rename files or only display unnamed thumbnails may return `upload_unconfirmed`; inspect the visible preview and server response rather than substituting another asset or claiming failure.

Upload attempts are remembered by tab, current URL, project, purpose and field label in the broker. Reissuing the same upload command returns the previous attempt with `reusedAttempt: true` and `retryAllowed: false`, including when the browser call timed out. After inspecting the field, `--replace` / `replace: true` explicitly permits a corrected attempt. For a later field on the same SPA URL with an identical label, inspect its actual identity before allowing that new attempt. Separate CLI processes retain this record; ending the broker loses it, so inspect existing attachments before resuming in a replacement session.

An already open Google authentication window returns `existing_google_window` before a new login click. Inspect whether it belongs to this task and finish the existing attempt with the current browser controls; do not close unrelated windows. `login_source_closed` means the original form tab disappeared and its state needs recovery.

After the agent performs an authorized final submission, observe its result through the existing session:

```json
{"command":"check-result","url":"https://directory.example/submit","resultTimeout":30}
```

One-shot equivalent: `python scripts/blink-browser.py check-result --url CURRENT_RESULT_URL --result-timeout 30`. This command only reads. It waits for loading to finish and matches explicit short English/Chinese receipts, distinguishing submission received, editorial review and email verification. A generic thank-you, disabled button, navigation or unknown wording returns `submission_outcome_unknown` with `retryAllowed: false`. Inspect the actual page to resolve unsupported wording; do not repeat the final submit. The matcher is deliberately conservative and is not a universal site adapter.

`check-result` does not publish, claim `published`, or write to Blink. Confirm the correct product and actual public link separately, then record the receipt/evidence using the existing Blink result contract. When no receipt can be established, preserve the pending result and its required follow-up time.

- `chrome_connection_failed` / `mcp_timeout`: return `browser_failure` without asking the user or launching another browser profile.
- `blink_auth_failed`: the Blink connection in the package is invalid. Obtain a fresh package for the intended account; never silently change the server URL or substitute a local API key.
- `upload_field_not_found` / `ambiguous_upload_field`: inspect the actual form step or login state; supply an exact observed label only when needed.
- `existing_attachment`: inspect the current image and preserve it unless replacement is explicitly intended.
- `upload_access_denied`: preserve state and report the actual MCP permission failure. The program does not widen roots or disable checks.
- `upload_unconfirmed`: inspect the page before retrying; an upload may already have occurred.

This standalone stdio client runs only when the active environment permits launching the official MCP subprocess. Do not use it to evade a runtime action denial, an approval requirement, or a policy requiring a different exclusive browser runtime. An unavailable subprocess/Node/Chrome capability remains a real prerequisite, not something a Python script can manufacture.
