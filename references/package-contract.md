# Blink website package contract

Use this reference only for installation diagnostics or for implementing the Blink website exporter.

## Distribution model

Blink generates one user/account-specific Skill package for download. The user gives that package to the Skill installer in Codex, Claude Code, or WorkBuddy. The user is not expected to copy internal files or know a platform's hidden Skill directory.

The package must remain self-contained and relocatable. Runtime code must resolve files from the installed Skill directory, never from the original browser download path or the current working directory.

Blink should use a versioned download filename and write the same current client version into `connection.json`. This lets users distinguish a newly downloaded package from an older local copy without exposing its credential.

## Export layout

The installable unit is named `backlink-submit`. It contains:

```text
backlink-submit/
|-- .gitignore
|-- SKILL.md
|-- README.md
|-- connection.json
|-- connection.example.json
|-- skill-release.json
|-- agents/
|   `-- openai.yaml
|-- scripts/
|   |-- blink-audit.mjs
|   |-- blink-browser.py
|   |-- blink_session.py
|   |-- blink-form-plan.mjs
|   |-- blink-sequential-runner.mjs
|   |-- blink-runner-transport.mjs
|   |-- blink-skill-manager.mjs
|   `-- blink-automation.mjs
`-- references/
    |-- api.md
    |-- automatic-browser.md
    |-- browser-execution.md
    |-- integrity-and-recovery.md
    |-- login-handoff.md
    |-- package-contract.md
    |-- platform-adapters.md
    |-- python-runner.md
    `-- result-contract.md
```

Do not add a redundant wrapper such as `blink-backlink-submit-skill/backlink-submit/` inside the downloadable install unit. Development-only `tests/`, mock servers, sample result data, repository metadata, and unrelated backlink-list assets should not be included in the production download.

If a target installer requires a different archive-root convention, Blink may change only the outer archive envelope. The relative paths inside `backlink-submit` must stay unchanged.

## Generated connection

Blink writes `connection.json` at download time with:

```json
{
  "schemaVersion": 1,
  "appUrl": "https://blink.example",
  "apiKey": "<scoped-install-token>",
  "clientVersion": "1.9.2"
}
```

Release files other than `connection.json` are stored server-side as immutable
version records. The package's default-version pointer may move to any retained
version without rewriting its content. Installed clients fetch that pointer
with their existing credential and verify the release hash before switching.

The same runtime files are published at
`https://github.com/era4d/blinklib-submit-skill`. `skill-release.json` identifies
the version and `.gitignore` excludes account-specific credentials. The manager
can atomically switch an API installation to GitHub, or a clean Git checkout
can use `git pull --ff-only`. Release tags are preferred for version pinning;
`main` tracks the newest published release.

The token should be scoped to the authenticated Blink account and authorized backlink queue, independently revocable, and preferably expiring. Every download receives its own token; a later download must not revoke an installed client or interrupt its leases. Users revoke obsolete or exposed installation keys explicitly in Blink. The token must not grant general account administration. Never render or recursively dump `connection.json` or its token in installation logs, agent output, screenshots, evidence, prompts, or browser fields.

The API must remain the authority for task count, queue membership, execution mode, product data, authorization, leases, and accepted results. Possessing the package does not authorize submissions outside the returned queue.

## Installer and runtime checks

After import, a platform should discover `SKILL.md` and preserve all relative resources. During explicit installation diagnosis, the Skill should:

1. resolve `scripts/blink-automation.mjs` relative to the installed `SKILL.md`;
2. call the read-only `queue` command to validate connectivity without claiming;
3. avoid printing the connection contents;
4. report a clear installation/configuration blocker if Node.js, the script, the connection, the API, or a compatible browser adapter is unavailable.

Do not claim installation success merely because `SKILL.md` is visible; the read-only queue check is the installation validation. A normal campaign follows `SKILL.md`: initialize the browser first and let the persistent controller perform queue reads and claims.
