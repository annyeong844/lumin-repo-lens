---
name: lumin-repo-lens
description: "Audit TypeScript/JavaScript repos for structural debt with machine evidence: dead exports, cycles, oversized modules, duplicate helpers/types, barrels, naming drift, refactor plans, 'what should I clean up next?', and 'does X exist anywhere?'"
---

# Lumin Repo Lens

## Default Surface

This is the read-only audit and refactor-plan surface of an LLM-facing repo evidence engine. Claude or another coding assistant reads the artifacts, then answers the human in a vibe-coder-friendly voice.
Default chat is kind, plain, short, and action-first. Keep cold evidence behind the answer: mention artifact names only as compact proof.
Expand raw JSON paths, FP ids, tiers, canonical jargon, HCA, or P-phase names only when the user asks for proof, formal handoff, CI output, or maintainer/debug detail.

### Voice Anchor

Operator: the model reading this skill. Reader: a person who may be two months into coding and just wants to know what to do next.
Use everyday words, not insider tool labels. Compress like a headline, not a press release — file/line/count stay visible, padding drops.
Use hedging like "looks like" only when the internal label is `degraded` or `unknown`; strict evidence rules still apply.

## Core Contract

Run the tool, read artifacts, then make the claim. The skill emits
machine evidence; the model turns it into scoped, helpful review language.

```
NO STRUCTURAL CLAIM WITHOUT MACHINE EVIDENCE
NO ABSENCE CLAIM WITHOUT STATED SCAN RANGE
NO STRUCTURAL REVIEW WITHOUT A CHECKLIST GATE
```

If you have not run the relevant script in this session, do not claim a
count. If an artifact is missing or degraded, say so. Tier C means "no
consumer was found in the constructed graph," not "definitely dead."
If terms such as FP23, HCA, P4, Tier C, or SAFE_FIX are unfamiliar, read
`references/glossary.md` before expanding the answer.

### Hand Off Code-Change Requests

Use sibling skills for lifecycle changes: `lumin-repo-lens-write-gate` owns
add/edit/move/rename plus post-write checks; `lumin-repo-lens-canon` owns canon
draft/drift. This surface stays read-only except audit artifacts and
pre-existing or explicitly requested living audit docs.

## Public Surface

Use the recommended orchestrator first. Use `<audit-repo>` for the current context: generated skill package =
`node scripts/audit-repo.mjs`; maintainer checkout = `node audit-repo.mjs`.
Below, `<audit-repo>` means the command path for the current context.

This surface owns `audit`, `welcome`, and `refactor-plan`. The shared
engine still exposes `pre-write`, `post-write`, `canon-draft`, and
`check-canon` through sibling skill surfaces.

When installed as a Claude Code plugin, these same flows are exposed as
namespaced slash commands, including `/lumin-repo-lens:welcome`,
`:audit`, `:full`, `:pre-write`, `:post-write`, `:canon-draft`, `:check-canon`, and `:refactor-plan`.
Those command files are thin delegators. For slash-command entrypoints,
read `references/command-routing.md` first; it is runtime control, not
optional background reading.

The engine preserves cold artifacts on disk, but the chat surface still
starts with plain next steps unless the user asks for maintainer/debug detail.
`refactor-plan` is a coaching mode for human-in-the-loop planning; it has no CLI flag, producer, or JSON artifact of its own.

Generated public wrappers live in `scripts/`; runtime internals live in
`_engine/` and are not a stable user API. The runtime canon spine lives
in `canonical/`; templates live in `templates/`; self-contained
operating guides live in `references/`. Use `canonical/` for
invariant/spec contracts and `references/` for CLI, routing, policy,
and language-support details. Maintainer-only history, tests, corpora, drafts, and
self-audit fact snapshots are not user-facing skill surfaces.

## When To Use

Use this skill for repository-structure questions that need scan-wide
evidence:

- dead exports, over-exported symbols, or safe cleanup candidates
- cyclic dependencies, topology, cross-submodule coupling, barrel fan-out
- god modules, oversized functions, feature envy, duplicate shapes
- questions about existing canonical drift artifacts; use
  `lumin-repo-lens-canon` to draft or check canon
- multi-repo comparison
- structural review against the checklist
- tracked/living audit docs across runs
- any "does X exist anywhere" or "how many X" question where manual
  reading would be unreliable

Do not use it for pure taste questions unless the user provides an
explicit convention to check.

Default to the vibe-coder surface: choose profile by cadence, name at
most three things worth smoothing next, include a copy/paste coding
prompt when useful, and keep raw JSON, FP ids, tiers, and canonical
jargon in reserve unless proof is requested.

## Best Fit And Boundaries

This skill works best on JS/TS workspaces that use npm, pnpm, yarn, or
Bun workspaces; package public surfaces through `exports`, `main`,
`module`, `browser`, `types`, `typings`, or `bin`; and tsconfig or Node
`#imports` aliases. `package.json#exports` subpaths are protected by the
`publicApi_FP23` policy.

For framework conventions, codegen files, Python/Go boundaries, and
marketplace wording gates, read `references/language-support.md`,
`references/false-positive-index.md`, and `references/operational-gates.md`.
The long FP case ledger is maintainer-only, not ordinary skill context.

In `lumin-repo-lens-write-gate`, planned file paths are checked for sibling
domain clusters and shape reuse before code changes. This audit surface
only hands off to that sibling skill; it does not restate the write-gate
protocol here.

## Audit And Review Routing

For audit cadence, checklist gating, output shape, and claim discipline,
read `references/structural-review-workflow.md`. It owns the detailed
rules that keep this SKILL.md small:

- when to run `quick`, `full`, or `ci`
- how to treat `manifest.json` and `audit-summary.latest.md`
- when to use `templates/REVIEW_CHECKLIST_SHORT.md`,
  `templates/REVIEW_CHECKLIST.md`, or `templates/report-template.md`
- how to label `grounded`, `degraded`, and `unknown` claims
- how to screen dead-export tiers, duplicate-helper cues, and language
  precision boundaries before writing prose

For file-selection flags, topology lenses, incremental mode, SARIF, and
drilldowns, read `references/cli-options.md`.

For guidance rather than a full report, use
`references/refactor-plan-policy.md`, then fill
`templates/refactor-plan-template.md`. `refactor-plan` is
model-authored coaching over audit artifacts, not a producer or JSON
artifact.

For normal chat-facing structural reviews, follow
`templates/REVIEW_CHECKLIST_SHORT.md`. For explicit full audit reports,
due diligence, CI-style review, or formal report asks, follow `templates/report-template.md`.
For tracked audit documents, use
`templates/living-audit-template.md`.

## Red Flags

Stop and re-run or relabel if you are about to:

- emit a count without running the relevant script
- claim absence without naming the scan range
- use "looks like", "probably", or "should be" without an internal `degraded` or `unknown` label
- promote degraded evidence to grounded in the final report
- reuse old artifacts without checking scan range and freshness
- treat `SAFE_FIX`, `REVIEW_FIX`, `DEGRADED`, or `MUTED` as generic
  architecture verdicts outside dead-export analysis

## Bottom Line

Run the script. Read the JSON. Name the scan range. Then make the smallest true claim the artifacts support.
