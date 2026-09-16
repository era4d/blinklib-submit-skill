# AdsPower assisted browser adapter

Use this adapter only when the user explicitly asks to run the authorized Blink queue in an existing AdsPower desktop profile. It is a visible browser/session host, not a CAPTCHA solver, proxy rotator, fingerprint-evasion layer, or source of submission targets.

## Preconditions

- AdsPower Local API is already enabled and reachable on a loopback HTTP origin.
- The user supplies the exact existing desktop profile ID through `ADSPOWER_PROFILE_ID` or `--profile-id`.
- Put the optional Local API key in `ADSPOWER_API_KEY`; never pass it on the command line, print it, or store it in Blink evidence.
- Keep the profile's current proxy, locale, fingerprint, extensions, cookies, and account settings unchanged. Do not create profiles, update profiles, install extensions, or write proxy settings.
- Use one profile serially. Do not stop an already-active profile or share it with concurrent workers.

The bundled adapter follows AdsPower Local API v2 and accepts only `http://127.0.0.1`, `http://localhost`, or loopback IPv6. It starts a visible profile with tab restore and the proxy-detection page disabled, password filling/saving disabled, and CDP masking disabled. It returns only the loopback Chrome debugging origin, an opaque profile alias, and local ownership state.

## Start and connect

Run:

```text
node "<SKILL_DIR>/scripts/adspower-session.mjs" start
```

If the profile is already active, the adapter reuses it without claiming ownership. If it is inactive, the adapter starts it and records a user-local ownership file. Use the returned `browserUrl` with the packaged browser runner:

```text
python "<SKILL_DIR>/scripts/blink-browser.py" --browser-url http://127.0.0.1:PORT session-status
python "<SKILL_DIR>/scripts/blink-browser.py" --browser-url http://127.0.0.1:PORT doctor
```

Then use the same `--browser-url` for that campaign's packaged browser commands. Never send AdsPower profile IDs, API keys, WebSocket URLs, cookies, extension state, or raw session data to Blink logs or page fields.

## CAPTCHA and verification

Do not configure, inspect, click, or script 2Captcha or any other solving extension. Do not read or inject challenge tokens. When CAPTCHA, Turnstile, hCaptcha, CleanTalk, OTP, Passkey, email verification, or a security warning appears:

1. Return the matching blocker with observed form progress.
2. Preserve the exact visible task tab when any field was filled, upload accepted, form step advanced, or a final action may have occurred.
3. Continue other runnable queue items.
4. At batch end, bring preserved tabs forward and report the exact remaining user action.

After the user completes a challenge, reinspect the same tab and continue only if the task remains leased/resumable and no ambiguous final submission occurred. Never create a second tab or switch profile to bypass the challenge.

## Shutdown

Disconnect the packaged browser broker first. Stop AdsPower only after the campaign reaches a terminal state and no tab needs handoff or reconciliation:

```text
python "<SKILL_DIR>/scripts/blink-browser.py" --browser-url http://127.0.0.1:PORT session-stop
node "<SKILL_DIR>/scripts/adspower-session.mjs" stop
```

`stop` closes only a profile started and recorded by this adapter. A pre-existing profile returns `not_owned` and remains open. The stop call waits for AdsPower to report the profile inactive; it never kills browser processes or clears profile data.

## Recovery

- If `status` reports an owned active session, reconnect to its returned `browserUrl`; do not start another profile.
- If the Local API or debugging endpoint fails after form progress, preserve the AdsPower window, return `browser_failure`, and continue the queue. Do not restart the profile or repeat a possible final action.
- If the ownership file is invalid, preserve it for inspection. Do not delete it merely to force a stop.
- If the user closes the profile manually, settle any in-progress task conservatively and let `status`/`stop` clear the stale ownership state only after AdsPower reports it inactive.

AdsPower's official Local API documentation defines the v2 start endpoint (`POST /api/v2/browser-profile/start`), status endpoint (`GET /api/v2/browser-profile/active`), stop endpoint (`POST /api/v2/browser-profile/stop`), Bearer authentication, and request-rate limits. Recheck those documents before changing this adapter's protocol.
