# Refactor Plan Policy

Use this reference before producing a `refactor-plan`. It owns behavior,
tone, slice selection, lifecycle integration, and evidence discipline.
Use `templates/refactor-plan-template.md` only for the output shape.

`refactor-plan` has one public voice: a kind, practical coaching voice
for users who want to know what to do next. It may rely on maintainer
artifacts internally, but it should not sound like an artifact dump.

The planning model is:

```text
audit evidence -> LLM-authored plan -> implementation by user/agent -> scoped quick audit -> closeout
```

The tool provides facts, templates, and verification. The model chooses
semantic phases from the evidence and the repo's own docs/specs. Do not
turn prefix, tier, fan-in, or cluster signals into automatic phase
ownership. They are prompts for judgment, not phase generators.

`refactor-plan` is not a sixth validation mode. It has no CLI flag, no
producer, and no JSON artifact of its own. It is a slash-command
interpretation surface over existing audit artifacts. If the user needs
cold validation, route back to `audit`, `pre-write`, `post-write`,
`canon-draft`, or `check-canon`.

## Tone Contract

The report must help the user keep going without weakening the truth.

Do:

- begin with grounded strengths when they are meaningful
- if grounded strengths are thin, say so briefly and lead with current
  state plus the next safe slice instead of manufacturing praise
- describe change as incremental improvement
- use "next refactor slice", "worth smoothing", "review together"
- name the smallest useful change
- include how to verify success
- keep cold audit labels in the evidence trail unless they help action
- phrase criticism as actionable improvement
- keep the default chat answer short enough to read in one sitting
- give the user a copy/paste prompt for the next coding agent when code
  should change

Avoid:

- empty praise or empty blame
- paste a long fix list as if it were a judgment
- expose every raw gate when it does not help the user act
- paste JSON scope blocks into chat unless the user asks for machine-readable output
- shame or blame the user for existing code shape
- pretend a script tier is a semantic phase decision
- make the user translate artifact jargon into the next implementation
  request

Internal audit words may be translated:

| Internal signal | User-facing wording |
|---|---|
| `healthy` | working well / already stable |
| `watch` | worth watching / smooth later |
| `fix` | next refactor candidate |
| `SAFE_FIX` | low-risk cleanup candidate |
| `REVIEW_FIX` | review-assisted cleanup candidate |
| `DEGRADED` | collect evidence first |
| `[확인 불가]` | not enough evidence yet |

## Phase Scope Rules

Every Phase 1 plan needs a scope contract. Keep it small enough to
finish, but broad enough to include consumers and side effects.

Required:

- at least one file, directory, or domain cluster
- an explicit non-goal list
- one representative owner chain or reason no chain applies
- quick-audit scope with transitive consumers or an explanation that the
  scope cannot be narrowed safely
- verification commands
- whether the next implementation should start with `pre-write`

Forbidden:

- "fix all dead code" as a phase
- "clean the architecture" without files/directories/domains
- "run quick audit" without a scan range or exclusion rationale
- claiming a phase was computed by the tool
- making the user read a JSON scope block when prose would do

## Lifecycle Integration

The ideal loop is:

```text
audit evidence -> refactor-plan SHORT -> pre-write intent for Phase 1
-> implementation by user/agent -> post-write delta -> scoped quick audit
-> closeout notes -> next slice
```

For any plan that will touch code, include a one-line pre-write handoff:
which `files`, `names`, `dependencies`, `shapes`, and
`plannedTypeEscapes` should go into `references/pre-write-intent-shape.md`
format. If the refactor is read-only or documentation-only, say why
pre-write is unnecessary.

Also include a one-line "Ask the coding agent" prompt that the user can
paste into a coding agent without rewriting the plan. It should name the
single slice, the starting file or owner chain, the main leave-alone
boundary, and the verification command. Do not ask the user to translate
raw artifact language into an implementation request.

## Ripple-Aware Changes

Small does not always mean one file. Some safe slices must update
consumers, tests, docs, generated package mirrors, or canonical facts in
the same change. When that is true:

- name the owner file and the expected ripple files separately
- explain why splitting them would leave the repo inconsistent
- keep unrelated cleanup out of the slice
- verify both the owner behavior and the ripple surface

Do not choose a slice merely because it has the fewest files if the
result would strand callers or leave generated truth stale.

## Selection Rules

Pick at most one Phase 1 slice unless the user asks for a larger
roadmap. Prefer the slice that:

1. reduces future change cost
2. has a small touched-file set
3. is backed by grounded artifact evidence
4. can be verified with existing tests or a focused audit rerun
5. teaches the next phase something useful

When the top raw gate would produce a discouraging plan, reframe it:

- "This is a good place to smooth next" instead of "this is bad."
- "The evidence suggests one safer first slice" instead of "must fix."
- "Let's verify before changing it" instead of "unknown/problem."

## Evidence Discipline

The kind tone does not weaken evidence requirements. Every concrete
claim still needs evidence, but the chat answer should not drown the
user in labels. Keep full labels, FP ids, and raw field paths internal
unless the user asks for them. Prefer short parentheticals such as:

- `cycles: 0 (topology.json, runtime lens)`
- `parse errors: 0 (manifest.json)`
- `dead-export confidence: low because tests were excluded (fix-plan.json)`

Semantic phase grouping is allowed because it is LLM judgment over
grounded evidence. Describe it as judgment, not as a computed audit
fact.

## Proof Requests

If the user asks for exact evidence, reviewer handoff, CI detail, or
"show me the proof", add a compact evidence trail after the coaching
answer. Do not replace the coaching answer with raw artifacts. The order
is always: next action first, evidence trail second.

Before sending a plan, self-check:

- Did I start with what already works?
- Did I pick one next slice by default?
- Did I mark semantic grouping as LLM judgment?
- Did I give the user a copy/paste prompt for the next coding agent?
- Did I include verification?
- Did I avoid making the user read raw JSON unless requested?
