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
node scripts/blink-skill-manager.mjs git-update --ref v1.9.3
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

Version tags such as `v1.9.3` are immutable release points; `main` is the latest
published release.
