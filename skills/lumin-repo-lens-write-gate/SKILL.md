---
name: lumin-repo-lens-write-gate
description: "Use before/after TS/JS code changes: add, edit, move, rename, refactor, make a helper/type/file/function, or ask if something already exists. Infer intent from plain language, run pre-write reuse screening, then post-write delta checks."
---

# Lumin Repo Lens Write Gate

This is the code-change transaction surface for lumin-repo-lens. It owns
`pre-write` and `post-write` together because `post-write` reads the
`pre-write-advisory.<invocationId>.json` produced by the same change.

Keep the human-facing answer short and kind. The assistant reads the
cold artifacts; the human gets the next concrete step.

## Core Contract

```
NO STRUCTURAL CLAIM WITHOUT MACHINE EVIDENCE
NO ABSENCE CLAIM WITHOUT STATED SCAN RANGE
```

Use hedging like "looks like" only when the internal label is `degraded`
or `unknown`.

## Shared Engine

The shared engine lives in the sibling audit skill:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/scripts/audit-repo.mjs
```

In a maintainer checkout, the equivalent command is:

```bash
node audit-repo.mjs
```

Slash commands still read `<SKILL_ROOT>/references/command-routing.md` from the
shared audit skill for exact flag routing.
Below, `<SKILL_ROOT>` means
`${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens` in plugin
installs, or the repo root in a maintainer checkout.

Below, `<audit-repo>` means whichever of the two commands above applies
to the current context.

This surface owns `/lumin-repo-lens:pre-write` and
`/lumin-repo-lens:post-write`.

## References To Load

- Read `<SKILL_ROOT>/references/command-routing.md` first for
  slash-command routing.
- Read `<SKILL_ROOT>/references/pre-write-intent-shape.md` before constructing or
  repairing intent JSON.
- Read `<SKILL_ROOT>/canonical/pre-write-gate.md` for the pre-write protocol,
  domain-cluster hints, exact shape lookup, and advisory language.
- Read `<SKILL_ROOT>/canonical/any-contamination.md` for planned type escapes,
  contaminated reuse demotion, and post-write escape deltas.
- Read `<SKILL_ROOT>/references/lifecycle-modes.md` when exact flags, exit codes, or
  artifact names matter.
- Read `<SKILL_ROOT>/references/glossary.md` and
  `<SKILL_ROOT>/references/false-positive-index.md` when advisory output
  surfaces FP/tier terms that need explanation. The long FP case ledger
  is maintainer-only; do not load it for ordinary pre-write/post-write.

## Pre-Write

Run before adding, implementing, refactoring, moving, renaming, or
extending code when a compact intent can be inferred.

Do not ask normal chat users to hand-write JSON. Infer the smallest
intent you can from the request, stream it via `--intent -` or write a
temporary intent file, then run:

```bash
<audit-repo> --pre-write --root <repo> --output <dir> --intent <file|->
```

Read the invocation-specific advisory path printed by pre-write before
coding during the same uninterrupted change transaction. It is also
recorded as `artifactPaths.invocationSpecific` in the advisory JSON and
as `manifest.preWrite.advisoryPath` when run through the orchestrator.
`pre-write-advisory.latest.json` is only a convenience pointer; use the
explicit `pre-write-advisory.<invocationId>.json` path for post-write
across session or task boundaries.

Planned file paths may be grounded `NEW_FILE` and still carry
`DOMAIN_CLUSTER_DETECTED` when the same directory already has a matching
prefix, suffix, or domain-token family. Treat that as a reuse/review hint
before creating a new owner file.

P4 shape lookup is exact. Prefer `shape.typeLiteral` or `shape.hash` in
the intent when asking for shape reuse. Field-name-only shapes are
reported as `unknown`, not fuzzy matches.

Report existing owners/helpers/types/dependencies in plain language,
with compact proof only when needed.

## Post-Write

Run after the same change when a pre-write advisory exists:

```bash
<audit-repo> --post-write --root <repo> --output <dir> --pre-write-advisory <advisory>
```

Check:

- silent-new type escapes
- planned-but-not-observed escapes
- scan-range parity against the pre-write run
- unexpected new files in the scan range outside `intent.files`
- advisory failures plus baseline, capability, and scan-range confidence

If post-write cannot find the advisory, say that the post-write check is
`unknown` and name the missing file. Do not invent a clean result.
Do not use `pre-write-advisory.latest.json` after another pre-write run
has happened; rerun pre-write or pass the invocation-specific advisory.

## Output

Use four short blocks when reporting to a human:

1. What I checked
2. What already exists / changed
3. What needs attention
4. Next command or coding-agent prompt

Keep raw JSON paths, FP ids, and tier names behind the answer unless the
user asks for proof or maintainer detail.

## Hand Off

If the user shifts to repo-wide structure, dead code, cycles, or a
refactor-plan, hand off to `lumin-repo-lens`. If the user shifts
to canonical draft or drift validation, hand off to `lumin-repo-lens-canon`.
