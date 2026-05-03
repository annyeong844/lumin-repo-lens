# Structural Review Workflow

Use this reference after `SKILL.md` when producing repository audit,
structural review, or formal-report answers. It owns cadence, checklist
gates, output density, and claim discipline.

## Command

Prefer the orchestrator:

```bash
<audit-repo> --root <repo> --output <dir>
```

For slash commands, read `references/command-routing.md` first; it owns
Claude Code command behavior.

## Audit Cadence

Audit cadence:

- `quick`: fast default CLI profile.
- `full`: quick plus call graph, barrel discipline, shape index,
  exported function-clone cues, optional runtime/staleness.
- `ci`: full plus SARIF.

First pass on a repo, stale artifacts, explicit audit/review, due
diligence, large refactor planning, or post-refactor review -> run
`--profile full` unless the user asks for fast. Small localized
follow-up -> `--profile quick` is usually enough. Short chat output is still allowed after a full run; profile is evidence depth, not answer length.

The orchestrator writes `manifest.json` with scan range, confidence,
blind zones, skipped steps, produced artifacts, and per-step status. It
also writes `audit-summary.latest.md`; treat it as an artifact map, not
the final review. Read raw artifacts before choosing what matters.

Living audit docs are agent-authored, not engine-ranked. If one already
exists, read/update it before the final answer; create one only on
tracking/living-doc requests. Use `templates/living-audit-template.md`.

For file-selection flags, topology lenses, incremental mode, SARIF, and
drilldowns, read `references/cli-options.md`.

## Checklist Gate

For structural/code-quality review, run the pipeline first. Default to
`templates/REVIEW_CHECKLIST_SHORT.md`: strengths, at most three things
worth smoothing next, confidence, and next pass. Use
`templates/REVIEW_CHECKLIST.md` only for explicit full checklist walks,
due diligence, or CI-style validation. Any unevaluated prompt still
needs `unknown` plus scan range.

Checklist gate and output density are separate. The Core Contract makes
the checklist a required review step, not merely a template. Before any
structural answer, triage C/D/E/A/B/F using `checklist-facts.json` plus
relevant raw artifacts. Short output only controls what you show; it
does not permit skipping the checklist pass. For full, due-diligence,
exhaustive, or formal review, open `templates/REVIEW_CHECKLIST.md` and
walk it before drafting.

When synthesizing multiple review passes or sub-agent code walks, verify
headline counts and high-impact file:line claims yourself; resolve
same-site contradictions and name criteria before recommendations.

If stable evidence is thin, do not manufacture praise; use "Current
State" and lead with the next safe action.

## Output Contract

For normal chat-facing structural reviews, follow
`templates/REVIEW_CHECKLIST_SHORT.md`. For explicit full audit reports,
due diligence, CI-style review, or formal report asks, follow
`templates/report-template.md`. For tracked audit documents, use
`templates/living-audit-template.md`; the controller verifies and edits
the document.

Before finalizing any saved formal report, the final author must re-read
the report and manually check headline counts, same-site
classifications, broad conclusions, and chat-persona leakage against
the cited artifacts or source. Do not delegate this closeout to a string heuristic.

Every answer must be internally backed by `grounded`, `degraded`, or
`unknown` evidence. In normal chat, surface a short proof
parenthetical instead of the full label; expand the label only for
exact-count, formal-report, reviewer-handoff, or "show me the evidence"
requests.

For each `watch` or `fix`, use: symptom, cause, where to start.

Do not conflate dead-export tiers with structural verdicts.
`fix-plan.json` tiers are dead-export-specific; checklist
`healthy/watch/fix` is broader judgment.

## Evidence Discipline

Every claim must be internally labeled:

- `grounded`: directly reproducible
- `degraded`: partial evidence plus confidence
- `blind` / `unknown`: no direct evidence plus named scan range

Translate labels into clear prose plus compact proof unless the user
asks for the full trail.

Downgrade dead-export claims when resolver blindness, parse errors,
dynamic import opacity, framework conventions, codegen files, or public
API uncertainty could hide real consumers. Start with
`references/false-positive-index.md`. In a maintainer checkout, consult
`docs/maintainer/false-positive-patterns-ledger.md` only when changing
FP policy, debugging a specific family, or adding a verified case.

For duplicate-helper or similar-logic claims, `function-clones.json` is
a candidate lens, not a semantic-equivalence detector: exact body
matches are strong review cues; same-structure matches are weaker review
cues; near-function candidates are degraded review cues for structurally
different helpers that share important calls and size/name signals. Read
listed source ranges first; never merge/refactor from this artifact
alone.

For marketplace or automation claims, read
`references/operational-gates.md`. Do not market automatic cleanup from
raw Tier C. SAFE_FIX is static-graph-clean under the recorded scan range;
automation claims still require measured FP budgets.

For language precision boundaries, read `references/language-support.md`.
TypeScript is the primary target, but checker-grade binding, full
symbol-level public API precision, and shared AST caching still have
known limits.

## Refactor Plan Bridge

For guidance rather than a full report, use
`references/refactor-plan-policy.md`, then fill
`templates/refactor-plan-template.md`: keep cold gates internal and use
the short four-section chat plan by default: what works, next slice,
verification, and what waits.

Loop: `audit evidence -> LLM plan -> pre-write -> implementation ->
post-write -> scoped quick audit -> closeout`.

Do not hardcode semantic phases from raw tiers, prefix matches, or
fan-in; the tool supplies facts and the model authors the plan. Because
`refactor-plan` has no producer or JSON artifact, the model-authored
plan is the output; verify it later with pre-write, post-write, and
scoped audits.
