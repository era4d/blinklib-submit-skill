# Platform adapters

Keep the Blink API, queue rules, status model, and evidence contract platform-neutral. Select one browser adapter from the current runtime; never assume that a tool name or browser backend exists merely because another platform provides it.

The Skill has already been installed from a Blink website download when these instructions run. Do not attempt to install itself, copy itself to another directory, or rewrite its packaged connection. Resolve resources from the active installed Skill directory.

## Browser selection order

Reuse an already working Remote Chrome connection first; never add a Python MCP merely to upload on a task controlled by that connection. When choosing the packaged [Python runner](python-runner.md) as the backend, version 1.7.3 automatically retains one local broker and MCP across ordinary CLI commands and stdin EOF. It owns opening, inspection, Google sign-in and upload. Use its `browser-tools` / `browser-call` bridge for semantic form actions on the same connection instead of starting another agent browser adapter. Do not mix page IDs across connections. The direct-tool selection below applies when Remote Chrome is already active, Python/background IPC is unavailable, or the runtime requires an exclusive adapter.

For a new task, select an already connected Remote Chrome browser first, otherwise the runtime's built-in browser. Inspect the runtime inventory or existing broker's `session-status` without requesting a new debugging session. A Remote Chrome tool being installed is not proof that a remote-debugging browser is connected. If its only connection probe would request fresh Chrome approval, choose the built-in browser instead. Do not invent tool names, CDP endpoints, ports, or profiles.

If no remote-debugging browser is available, automatically choose the installed built-in/in-app browser, without a confirmation question or a request to enable Chrome debugging. If neither is available, inspect other installed compatible adapters and report the precise missing capability. This fallback does not require installing a browser. A subsequent explicit requirement for a particular browser/account takes precedence; preserve that requirement rather than silently changing identities.

### Built-in browser fallback

Read the built-in runtime's actual tool documentation, then open the queued URL in a visible task tab. Keep related tabs in that runtime only while the task is active. Close untouched failed-login and completed tabs; preserve every unfinished tab after any question is filled, upload is accepted, or form step advances. The Python runner controls Chrome, not the in-app browser: do not send in-app IDs to Python or start Chrome for a missing upload capability. Use the built-in runtime's documented upload method; if it cannot upload a required image, return the blocker and continue.

The built-in browser may have a separate login profile. Use its existing Google session when present; a saved account preference selects a visible account but does not transfer Chrome cookies or establish authentication. Inspect and handle an actual login/verification requirement in the built-in browser under the existing login rules. Never copy browser session data between backends.

Keep the chosen backend and session for the active task. A later Remote Chrome connection failure is a recovery blocker, not a reason to switch backends or repeat a possible submission. Apply the shared tab-retention policy after settlement.

For uploads through Remote Chrome, confirm where its documented upload operation reads files. Use the API-downloaded `files[].path` directly when the runtime accepts client-local paths. If it requires a remote-host file, transfer that exact downloaded image using its supported file-transfer operation and use the returned remote path. Do not assume a local temporary path exists on the remote host. If neither upload nor transfer is supported, report the upload capability limitation; do not silently skip a required image or switch browsers mid-task.

For the Chrome DevTools `upload_file` adapter, file paths must be local to the browser instance. Follow [the concrete file-selection procedure](browser-execution.md#remote-chrome-file-selection), including `prepare-upload`, the observed upload control UID, and verification before Next. For supported shared-host Chrome DevTools, automatically use OS temporary staging through `prepare-upload --browser-filesystem shared`; users do not configure upload roots. Check remote file-transfer support when hosts differ. See [automatic staging](browser-execution.md#automatic-temporary-directory-staging). A successful Chrome connection or a shell-writable workspace does not establish file-upload permission. Follow [path access recovery](browser-execution.md#upload-path-access-recovery) on a root denial; do not switch backends to evade it.

## Chrome connection preflight

Run this before claiming work. Prefer the user's existing signed-in Chrome through the installed Remote Chrome adapter. Discover the live schemas and actually call its connection/page-list operation. For the Chrome DevTools adapter this is `mcp__chrome_devtools__list_pages({})`; read its response, including restart/reconnect notices. Tool discovery alone does not start or connect a browser.

After a successful connection, claim the next task and open its exact submission URL using the documented new-tab operation in the existing profile. For Chrome DevTools, call `new_page` with `url` and `background: false`, omitting `isolatedContext`. Use the returned page ID, inspect the loaded page and record `browser_opened` only after the correct site is observed. For an existing task, reacquire its tab from the page list instead of opening a duplicate. When foregrounding is needed, `select_page` accepts the current `pageId` and `bringToFront: true`. A visible task tab also gives the user a clear start-of-work signal in automatic mode; subsequent visibility can follow the task mode.

If no initial remote connection is available, use the built-in fallback before any form work rather than invoking connect/start/reconnect or asking for native Chrome approval. For an already active Chrome task, preserve its browser and use documented recovery only; do not move a partially filled form or uncertain submission to another backend. Never launch a fresh Chrome profile, invent a debugging port, kill/restart Chrome, or use a fallback to evade a denied action. If the user explicitly requests Chrome setup, its native authorization still applies.

After reconnecting, list pages and refresh the target snapshot because old IDs may be stale. Keep a Google callback in the same profile only during the single login attempt; close task-related pages if authentication remains unconfirmed.

## Required browser capability contract

The selected adapter must be able to:

- open the exact queued HTTP(S) URL;
- inspect current rendered page state;
- fill ordinary text fields, text areas, selects, checkboxes, and radio controls;
- click the final control exactly once when the task's effective mode and runtime authorize it;
- detect navigation, validation errors, login walls, and visible success text;
- return the current safe page URL;
- preserve every unfinished task tab with any applied field, accepted upload, or advanced form step for a later user-only handoff;
- make each preserved tab visible or foreground when the batch ends.

If the adapter lacks a required capability, report `blocked_execution_backend`, settle the task, and continue. Do not start another browser or interrupt the user mid-run.

For a `semi-automatic` task, the task envelope's `browser` contract is mandatory: `visibility` must be `visible`, `headless` must be `false`, `foreground` must be `true`, and `confirmation` must be `required`. A missing or incompatible contract is a blocker, not permission to choose a background runtime.

## Codex

For campaign execution, start the packaged `blink-sequential-runner.mjs` once and keep its stdin session alive. It owns one lease and browser task at a time, verifies browser receipts, settles the task, and claims the next task without an `emit`/`eval` bootstrap or collaboration-tool adapter.

1. Follow the shared selection order: already connected Remote Chrome first, then the built-in in-app browser. For Codex's CUA runtime, follow its first-call instructions and open a visible tab immediately, then navigate it to the queued URL with the runtime's documented tab API. An IAB/CUA tab is a browser runtime, not a native Windows app: do not load the Windows Computer Use skill or its native-app confirmation guide for operations inside that tab. Read the returned browser documentation before subsequent operations; do not assume Playwright or file-upload APIs exist. If this runtime is unavailable, inspect other installed adapters.
2. Keep automatic work in the runtime's normal background mode when allowed.
3. For `semi-automatic`, enable browser visibility, bring the exact filled tab forward, and preserve it while waiting for submission confirmation.
4. For login, try the existing Google session once. If credentials, a challenge, consent review, or ambiguous account choice remains before authentication, close the related tabs, return the blocker, and continue without asking.
5. Follow the selected browser tool's actual response. Record `runtime_confirmation_required` or `runtime_denial` only when that tool returns a concrete non-bypassable confirmation or denial receipt; a predicted policy conflict is not a blocker.

Codex-only UI metadata under `agents/openai.yaml` is optional and must not be treated as part of the shared execution contract.

## Claude Code

1. Invoke the installed Skill as `/backlink-submit` or allow Claude to select it from its description.
2. Follow the shared selection order, preferring an installed Remote Chrome capability before other browser-control skills, MCP servers, or browser tools. Do not assume Claude Code itself provides a browser backend.
3. Use the directory containing this `SKILL.md` when resolving bundled scripts and references. `${CLAUDE_SKILL_DIR}` may be used only when the active Claude Code runtime documents that substitution; do not place it in shared result data.
4. If no compatible browser adapter is available, preserve the Blink task and report `blocked_execution_backend` instead of attempting form submission with blind HTTP requests.

The shared frontmatter intentionally uses only Agent Skills fields. Do not add Claude-only invocation, model, context, hook, or tool-grant fields to the shared `SKILL.md`.

## WorkBuddy

1. Follow the shared selection order, preferring an installed Remote Chrome capability. When it is unavailable or incompatible, use WorkBuddy's installed `web-access` skill for browser/CDP work if it satisfies the task contract. Read the selected skill completely and run its dependency preflight before browser actions.
2. Use a task-created tab rather than altering unrelated user tabs. Close failed-login popups and untouched task tabs; preserve every unfinished task tab with form progress.
3. WorkBuddy `web-access` background tabs are suitable for automatic mode. Foreground progressed blocker tabs at batch end when supported; otherwise report their safe URLs without asking during execution.
4. After the user completes login, refresh and inspect the same CDP target before resuming.
5. Never load or use CAPTCHA-solving, Cloudflare-bypass, proxy-rotation, fingerprint-evasion, or stealth-login helpers for this workflow, even if another installed WorkBuddy skill exposes them.

WorkBuddy marketplace metadata such as `_skillhub_meta.json` is not required for a local skill and should not be copied from unrelated skills.

## Portable script execution

The API client is dependency-free ESM and requires Node.js 18 or later. Resolve `scripts/blink-automation.mjs` relative to the loaded Skill directory, then invoke it with that absolute path. Do not assume the current working directory is the Skill directory.

Use the Blink-generated `connection.json` bundled beside `SKILL.md`. `BLINK_APP_URL` and `BLINK_API_KEY` may override it for managed deployments. Never expose either source in logs or browser fields.
