# Google sign-in, login handoff and continuation

Use this workflow when Blink marks a task `requiresLogin: true` or when browser inspection unexpectedly reaches a login wall.

## Queue no-login work first

Blink should classify known candidates with `requiresLogin: false`, `true`, or `unknown`, then order runnable `false` tasks first. Treat `unknown` as a normal inspection task until the page proves that authentication is required.

`requiresLogin: true` describes the site; it does not prove that the current Chrome session is signed out. Inspect the actual submission page first. If already signed in, continue immediately. If a login wall appears, Google is the default first choice: try the ordinary Google sign-in path below before any email/password path, deferral, or request for user action.

## Try the existing Google session first

Read the runner's `login-preferences --url SITE_URL` before attempting Google. Reuse an existing saved account choice and matching site-specific registration approval. A changed account or new site does not inherit another site's registration permission.

When the user specifies their existing Google account, preserve Google as the login method. `Continue with email`, `Continue another way`, password reset and other identity providers are not automatic recovery steps for a Google error, a delayed popup or a missing callback. Keep the Google flow visible, inspect the specific failure and use another login method only when the user explicitly requests that change. Do not fill the Google account email into a password-login form as a fallback.

1. Use the user's existing Chrome profile through the established Remote Chrome connection. Do not launch an isolated context, guest/incognito profile, or a new automation profile: those do not preserve the user's Google session. A running Chrome or a signed-in Google account does not prove the directory itself is authenticated.
2. On the queued directory's legitimate login page, inspect and click its visible `Continue with Google`, `Sign in with Google`, or equivalent control. The user's request to use their signed-in Google account authorizes this normal sign-in attempt; do not ask them to click the same button manually. If no Google button exists, follow the site's available session path or the handoff below; do not invent a Google OAuth URL.
3. Re-read tabs and page state after clicking. The flow may navigate the current tab or open a popup. Keep the original submission tab, bind the observed popup in the same Chrome session, and check that a Google account chooser is on `accounts.google.com`. Do not confuse a Google logo on an unrelated domain with the provider's account chooser.
4. Select a previously saved choice or the sole eligible signed-in account. If multiple accounts are ambiguous, close the popup and close the task tab only when it is untouched; otherwise preserve the progressed task tab. Report `ambiguous_accounts`; do not ask during the campaign, infer identity from product-contact email, or select `Use another account`.
5. Continue ordinary sign-in using basic identity/profile/email disclosure to the queued directory when within the user's authorization. Do not add an extra confirmation for this authorized sign-in. Read the actual consent screen: unrelated access (Gmail, Drive, Calendar), separate signup obligations, payment or new contractual terms require their applicable authorization. Never accept arbitrary OAuth permissions merely to get past a screen. Runtime-mandated approvals still apply.
6. If Google asks for a password, OTP, Passkey, security key, CAPTCHA or recovery action before the directory is authenticated, do not inspect or enter credentials, read session stores, or bypass challenges. Close the login popup and close the task tab only when no form progress exists; preserve a progressed task tab. Then report the concrete login blocker so Blink can rotate. Likewise, an explicit provider error such as a disabled/blocked sign-in is a blocker, not permission to loop through login attempts.
7. After the callback or popup closure, re-observe the original directory tab and verify visible authenticated account state before reporting `login_completed`. A click on Google, account selection, or a closed popup is not proof of success.
8. Once authentication is confirmed, automatically navigate that task tab to the browser request's exact `submissionUrl`—the queued external-link URL, with its original path, query, and fragment intact. Do this even when the OAuth callback landed on a homepage, account page, onboarding page, or dashboard. Do not search the callback page for a submit link and do not stop merely because the form is absent there.
9. Wait for the destination page and any embedded form to finish loading, inspect fresh controls, and continue filling, uploading, advancing, and submitting in the original run and mode. If the exact `submissionUrl` now shows another login wall, treat authentication as unconfirmed/expired and follow the failed-login policy; otherwise do not ask the user to say "logged in" when the browser already confirms it.

Try this path once per login wall, with one fresh observation after a stale element. If authentication is still unconfirmed, close the provider popup, close an untouched task tab, preserve a progressed task tab, defer, and continue. Do not interrupt the running batch.

## Close only untouched failed logins and continue

If Google sign-in is unavailable, ambiguous, unsuccessful, or requires a human challenge:

1. Close every popup opened by the login attempt. Close the task tab only when no question was filled, no upload was accepted, and no form step advanced. Do not close unrelated user tabs.
2. Return `login_required` with `formProgress`, the matching `tabDisposition` (`"closed"` for untouched or `"preserved"` for progressed), the platform domain, safe last URL, and the concrete `loginAttempt` outcome. Do not record credentials or session data.
3. Let the controller acknowledge the deferral and rotate to the next task. Do not interrupt the user while the queue still has runnable work.
4. If Blink rejects the deferral, retain the lease but do not reopen the failed login page repeatedly. Follow the returned recovery action or stop with the controller's recovery state.

Do not interrupt the user merely because login tasks exist while runnable no-login tasks remain.

## Preserve every progressed handoff

If any question was filled, an upload was accepted, or a form step advanced before a later user-only step blocks completion:

1. Keep the progressed task tab; close completed provider popups and duplicate tabs.
2. Confirm the visible domain matches the queued task.
3. Preserve the task page as the handoff. In Codex's in-app browser, call the exact tab's `markHandoff()` after the deferral is acknowledged and again before every turn end until work resumes or the task is settled; simply leaving an agent-created tab open is insufficient. Bring each preserved task page to the foreground when reporting it at batch end.
4. Add the site and exact remaining step to the batch-end report; do not interrupt while runnable work remains.
5. Do not ask for credentials in chat. Do not inspect or enter passwords, OTPs, recovery codes, Passkeys, security keys, password-manager contents, cookies, or session storage.
6. Keep the Blink task in the matching user-action state. The controller must acknowledge the deferral before taking another task.

If the user declines to log in, record `blocked_user_action` and continue only when Blink has safely released or completed the current claim.

## Resume after the user returns

After the user asks to continue an authenticated handoff:

1. Call `resume --run-id RUN_ID` when Blink advertises resume support, then rebind to the same browser and exact preserved tab.
2. Verify visible authenticated account state, then navigate the preserved task tab to the run's exact `submissionUrl`, preserving its path, query, and fragment. Wait for the page and embedded form and read fresh controls there; do not remain on or search an OAuth callback/dashboard page.
3. If the authenticated session expired, preserve the task tab when it has form progress; otherwise close it. Report the login blocker and let Blink rotate.
4. Record `login_completed` without recording credentials or session identifiers.
5. Resume the original task from its last safe phase. Apply its original `automatic` or `semi-automatic` mode to form filling and final submission.
6. Return the submission outcome and evidence to Blink before moving to another task.

## Backend expectations

For this workflow to avoid unnecessary interruptions, Blink should expose:

- `requiresLogin` on known tasks;
- the number of runnable no-login and pending-login tasks;
- safe task deferral or release when login is discovered unexpectedly;
- a lease or ownership state that can survive user handoff;
- stable run ID, idempotency key, browser-session alias, and resume phase.

If those controls are absent, fail closed: preserve every tab with form progress and close only untouched failed-login pages. Report the blocker and stop claiming rather than losing entered data.
