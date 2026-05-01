# Lumin Repo Lens

Evidence-backed TS/JS repository structure lens for Claude Code.

> Public beta: usable today, with occasional breaking changes possible before
> the stable `1.0.0` line.

Lumin Repo Lens runs local analysis over a target repository and writes
machine-readable artifacts for structure review, pre-write reuse checks,
post-write delta checks, and maintainer canon checks. It is designed for
grounded answers: raw JSON artifacts remain the citation authority, while
Claude Code uses the plugin surface to produce a short human answer.

## What It Produces

A normal run writes a local `.audit/` directory in the target repo. The exact
files depend on the profile, but the important artifacts are:

```text
.audit/
  manifest.json              scan range, command status, blind zones
  checklist-facts.json       measured structural review facts
  audit-summary.latest.md    short artifact map for the assistant
  topology.mermaid.md        optional topology diagram when topology data exists
```

Claude Code reads those artifacts and turns them into a short answer such as:

```text
Already stable
- No dependency cycles were observed.
- No oversized functions were observed.

Worth smoothing next
- One near-duplicate helper pair needs source review before merging.

Keep as-is for now
- Thin wrapper functions are intentionally separate entrypoints.
```

The JSON remains the citation source. The chat answer is the readable layer.

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

## Why Three Skill Surfaces?

The public command namespace is always `lumin-repo-lens`. Inside the plugin,
the work is split into three sibling skill surfaces so each lifecycle has a
clear contract:

- `lumin-repo-lens` — read-only repo lens, full reviews, and refactor planning.
- `grounded-write-gate` — pre-write reuse checks and matching post-write deltas.
- `grounded-canon` — maintainer-only canon draft and drift checks.

Most users only call the `/lumin-repo-lens:*` slash commands. The sibling names
exist so Claude Code can load the right instructions without mixing lifecycle
rules.

## Artifact Privacy

By default, audit artifacts are written to `<repo>/.audit/`. These files may
include repository structure, file paths, symbol names, and analysis metadata.
Add `.audit/` to the target repository's `.gitignore` unless you intentionally
want to commit those artifacts.

## Language Note

Some internal evidence templates include `[확인 불가]`, Korean for
`unknown / not enough evidence`. It is an explicit evidence label, not a stray
UI string. English-facing answers should translate it as `unknown` unless the
user is writing in Korean.

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
