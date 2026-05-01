# Lumin Repo Lens

Evidence-backed TS/JS repository structure lens for Claude Code.

Lumin Repo Lens runs local analysis over a target repository and writes
machine-readable artifacts for structure review, pre-write reuse checks,
post-write delta checks, and maintainer canon checks. It is designed for
grounded answers: raw JSON artifacts remain the citation authority, while
Claude Code uses the plugin surface to produce a short human answer.

## Install

Add this repository as a Claude Code plugin marketplace:

```bash
claude plugin marketplace add annyeong844/lumin-repo-lens
claude plugin install lumin-repo-lens@annyeong844-marketplace
```

Then restart or reload Claude Code plugins.

## Commands

- `/lumin-repo-lens` — run the default repo structure lens.
- `/lumin-repo-lens:full` — run the full profile for deeper review.
- `/lumin-repo-lens:pre-write` — check existing helpers/types/files before code changes.
- `/lumin-repo-lens:post-write` — compare a change against a matching pre-write advisory.
- `/lumin-repo-lens:refactor-plan` — turn artifacts into a cautious cleanup plan.
- `/lumin-repo-lens:welcome` — show a short first-use menu.

Maintainer-only commands are also included for canon lifecycle work:
`/lumin-repo-lens:canon-draft` and `/lumin-repo-lens:check-canon`.

## Artifact Privacy

By default, audit artifacts are written to `<repo>/.audit/`. These files may
include repository structure, file paths, symbol names, and analysis metadata.
Add `.audit/` to the target repository's `.gitignore` unless you intentionally
want to commit those artifacts.

## Runtime Setup

The generated skill package may install parser dependencies locally on first
use with script execution disabled. Set `LUMIN_REPO_LENS_NO_AUTO_INSTALL=1` to
disable that setup.

## Included Surfaces

- `skills/lumin-repo-lens/`
- `skills/grounded-write-gate/`
- `skills/grounded-canon/`

The Codex wrapper is not shipped in this Claude Code marketplace package to
avoid implicit-invocation overlap.
