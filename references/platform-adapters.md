# Platform adapters

Keep the Blink API, queue rules, status model, and evidence contract platform-neutral. Select one browser adapter from the current runtime; never assume that a tool name or browser backend exists merely because another platform provides it.

The Skill has already been installed from a Blink website download when these instructions run. Do not attempt to install itself, copy itself to another directory, or rewrite its packaged connection. Resolve resources from the active installed Skill directory.

## Browser selection order

The default order for new browser work is **Tabbit → built-in browser**. Prefer Tabbit through the installed `tabbit` skill and its stable CLI launcher; if unavailable, use the runtime's built-in/in-app browser directly. Remote Chrome, the Python Chrome runner, and other adapters are not automatic fallbacks. Resume an existing task in its original backend and session rather than migrating its tabs. Never add a Python MCP merely to upload on a task controlled by another connection. When explicitly choosing the packaged [Python runner](python-runner.md) as the Chrome backend, version 1.7.3 automatically retains one local broker and MCP across ordinary CLI commands and stdin EOF. It owns opening, inspection, Google sign-in and upload. Use its `browser-tools` / `browser-call` bridge for semantic form actions on the same connection. Do not mix page IDs across connections.

An explicit user-selected browser or account takes precedence. Use AdsPower only when the user explicitly requested it and supplied an existing profile ID; read [adspower.md](adspower.md). Otherwise check Tabbit first, then the built-in browser. Do not probe or connect Chrome merely because Tabbit is unavailable. Chrome instructions below apply only to an explicitly requested Chrome backend or recovery of an existing Chrome task. Do not invent tool names, CDP endpoints, ports, or profiles.

AdsPower is not a fallback chosen by the agent. Its packaged adapter may start the exact user-selected profile and expose its loopback debugging origin, but it must not create or update profiles, change proxies/fingerprints/locales/extensions, solve challenges, or stop a profile it did not start. Keep the same AdsPower profile serially for the campaign. A progressed task or ambiguous submit prevents profile shutdown until handoff or reconciliation is complete.

If Tabbit is unavailable, automatically choose the installed built-in/in-app browser, without a confirmation question or a request to enable Chrome debugging. If neither is available, report `blocked_execution_backend` with the precise missing capability; do not automatically select another adapter. This fallback does not require installing a browser. Preserve an explicit browser/account requirement rather than silently changing identities. Once browser work starts, a runtime denial or confirmation requirement is not permission to switch backends.

### Tabbit preferred backend

Read the installed `tabbit` skill before browser actions. Use its stable launcher: `& "$env:LOCALAPPDATA\Tabbit\LocalAgent\bin\tabbit-cli.exe"` on Windows PowerShell or `"$HOME/.local/bin/tabbit-cli"` on macOS. Use `diagnose` and `tabs` to discover actual capabilities and ownership; follow the skill's documented JavaScript transport and browser-owned Playwright API. If the skill or launcher is absent, use the built-in browser before starting form work.

Reuse one Tabbit task name for the campaign and resume its retained group when continuing. Open each queued URL in an owned task tab, keep Google login popups in the same browser session, and upload exact staged asset paths through the documented file-input API. Close completed and untouched failed-login tabs under the shared tab policy. Preserve every progressed unfinished tab and any ambiguous-submit reconciliation tab. At batch end, make preserved tabs visible and run the documented normal `finish` once to release ownership while retaining useful tabs; do not use `finish --discard` on preserved work. Tabbit tabs do not use Codex in-app `markHandoff()`.

### Built-in browser fallback

Read the built-in runtime's actual tool documentation, then open the queued URL in a visible task tab. Keep related tabs in that runtime only while the task is active. Close untouched failed-login and completed tabs; preserve every unfinished tab after any question is filled, upload is accepted, or form step advances. The Python runner controls Chrome, not the in-app browser: do not send in-app IDs to Python or start Chrome for a missing upload capability. Use the built-in runtime's documented upload method; if it cannot upload a required image, return the blocker and continue.

The built-in browser may have a separate login profile. Use its existing Google session when present; a saved account preference selects a visible account but does not transfer Chrome cookies or establish authentication. Inspect and handle an actual login/verification requirement in the built-in browser under the existing login rules. Never copy browser session data between backends.

Keep the chosen backend and session for the active task. A later Remote Chrome connection failure is a recovery blocker, not a reason to switch backends or repeat a possible submission. Apply the shared tab-retention policy after settlement.

For uploads through Remote Chrome, confirm where its documented upload operation reads files. Use the API-downloaded `files[].path` directly when the runtime accepts client-local paths. If it requires a remote-host file, transfer that exact downloaded image using its supported file-transfer operation and use the returned remote path. Do not assume a local temporary path exists on the remote host. If neither upload nor transfer is supported, report the upload capability limitation; do not silently skip a required image or switch browsers mid-task.

For the Chrome DevTools `upload_file` adapter, file paths must be local to the browser instance. Follow [the concrete file-selection procedure](browser-execution.md#remote-chrome-file-selection), including `prepare-upload`, the observed upload control UID, and verification before Next. For supported shared-host Chrome DevTools, automatically use OS temporary staging through `prepare-upload --browser-filesystem shared`; users do not configure upload roots. Check remote file-transfer support when hosts differ. See [automatic staging](browser-execution.md#automatic-temporary-directory-staging). A successful Chrome connection or a shell-writable workspace does not establish file-upload permission. Follow [path access recovery](browser-execution.md#upload-path-access-recovery) on a root denial; do not switch backends to evade it.

## Chrome connection preflight

Run this before claiming work only when the user explicitly selected Chrome or when resuming an existing Chrome task. Reuse the user's existing signed-in Chrome through the installed Remote Chrome adapter. Discover the live schemas and actually call its connection/page-list operation. For the Chrome DevTools adapter this is `mcp__chrome_devtools__list_pages({})`; read its response, including restart/reconnect notices. Tool discovery alone does not start or connect a browser.

After a successful connection, claim the next task and open its exact submission URL using the documented new-tab operation in the existing profile. For Chrome DevTools, call `new_page` with `url` and `background: false`, omitting `isolatedContext`. Use the returned page ID, inspect the loaded page and record `browser_opened` only after the correct site is observed. For an existing task, reacquire its tab from the page list instead of opening a duplicate. When foregrounding is needed, `select_page` accepts the current `pageId` and `bringToFront: true`. A visible task tab also gives the user a clear start-of-work signal in automatic mode; subsequent visibility can follow the task mode.

If an explicitly requested Chrome connection is unavailable, report the connection blocker instead of silently changing browsers. For an already active Chrome task, preserve its browser and use documented recovery only; do not move a partially filled form or uncertain submission to another backend. Never launch a fresh Chrome profile, invent a debugging port, kill/restart Chrome, or use a fallback to evade a denied action. If the user explicitly requests Chrome setup, its native authorization still applies.

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

1. Follow the shared selection order: Tabbit first, then the built-in in-app browser. Read the installed `tabbit` skill when using Tabbit. For Codex's CUA fallback, follow its first-call instructions and open a visible tab immediately, then navigate it to the queued URL with the runtime's documented tab API. An IAB/CUA tab is a browser runtime, not a native Windows app: do not load the Windows Computer Use skill or its native-app confirmation guide for operations inside that tab. Read the returned browser documentation before subsequent operations; do not assume Playwright or file-upload APIs exist. If neither backend is available, report `blocked_execution_backend`.
2. Keep automatic work in the runtime's normal background mode when allowed.
3. For `semi-automatic`, enable browser visibility, bring the exact filled tab forward, and preserve it while waiting for submission confirmation.
4. For login, try the existing Google session once. If credentials, a challenge, consent review, or ambiguous account choice remains before authentication, close the related tabs, return the blocker, and continue without asking.
5. Follow the selected browser tool's actual response. Record `runtime_confirmation_required` or `runtime_denial` only when that tool returns a concrete non-bypassable confirmation or denial receipt; a predicted policy conflict is not a blocker.
6. Codex in-app tabs created by the agent close automatically at turn end unless explicitly marked. As soon as a deferral with `tabDisposition: "preserved"` is acknowledged, call `await tab.markHandoff()` on that exact task tab. At `campaign_finished`, `runner_failed`, `runner_stopped`, or `runner_recovery_required`, reacquire every preserved tab by its stable tab ID, call `markHandoff()` again, enable browser visibility, and bring the preserved tabs forward for the user before returning the batch report. Handoff marks are turn-scoped, so repeat the call in every later turn that must keep the tab. Do not use `markDeliverable()` for work that must continue in a later turn, and do not mark completed task tabs, failed-login tabs without form progress, provider popups, or unrelated user tabs.

Codex-only UI metadata under `agents/openai.yaml` is optional and must not be treated as part of the shared execution contract.

## Claude Code

1. Invoke the installed Skill as `/backlink-submit` or allow Claude to select it from its description.
2. Follow the shared selection order: prefer the installed `tabbit` skill and stable CLI, then a compatible built-in browser. Do not assume Claude Code itself provides a browser backend or automatically select Remote Chrome.
3. Use the directory containing this `SKILL.md` when resolving bundled scripts and references. `${CLAUDE_SKILL_DIR}` may be used only when the active Claude Code runtime documents that substitution; do not place it in shared result data.
4. If no compatible browser adapter is available, preserve the Blink task and report `blocked_execution_backend` instead of attempting form submission with blind HTTP requests.

The shared frontmatter intentionally uses only Agent Skills fields. Do not add Claude-only invocation, model, context, hook, or tool-grant fields to the shared `SKILL.md`.

## WorkBuddy

1. Follow the shared selection order: prefer the installed `tabbit` skill and stable CLI, then WorkBuddy's compatible built-in browser. If neither is available, report `blocked_execution_backend`. Use a separate `web-access` or Remote Chrome adapter only when explicitly requested or resuming existing work. Read the selected skill completely and run its dependency preflight before browser actions.
2. Use a task-created tab rather than altering unrelated user tabs. Close failed-login popups and untouched task tabs; preserve every unfinished task tab with form progress.
3. WorkBuddy `web-access` background tabs are suitable for automatic mode. Foreground progressed blocker tabs at batch end when supported; otherwise report their safe URLs without asking during execution.
4. After the user completes login, refresh and inspect the same CDP target before resuming.
5. Never load or use CAPTCHA-solving, Cloudflare-bypass, proxy-rotation, fingerprint-evasion, or stealth-login helpers for this workflow, even if another installed WorkBuddy skill exposes them.

WorkBuddy marketplace metadata such as `_skillhub_meta.json` is not required for a local skill and should not be copied from unrelated skills.

## Portable script execution

The API client is dependency-free ESM and requires Node.js 18 or later. Resolve `scripts/blink-automation.mjs` relative to the loaded Skill directory, then invoke it with that absolute path. Do not assume the current working directory is the Skill directory.

Use the Blink-generated `connection.json` bundled beside `SKILL.md`. `BLINK_APP_URL` and `BLINK_API_KEY` may override it for managed deployments. Never expose either source in logs or browser fields.
