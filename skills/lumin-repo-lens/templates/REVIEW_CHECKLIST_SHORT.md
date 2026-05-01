# Structural Review Checklist Short (v1.1)

Use this for normal chat-facing structural reviews. It keeps cold audit
facts available internally, but returns a humane, high-signal summary
instead of walking every checklist item.

This template is output density, not analysis depth. Before filling it,
do an internal checklist triage pass across all review lenses below and
mark missing lanes as `[확인 불가]` internally. Use the long `templates/REVIEW_CHECKLIST.md` only
when the user asks to see the full checklist walk, due diligence, or
CI-style validation.

If the answer combines multiple code walks, sub-agent notes, or separate
review passes, do a synthesis gate before writing: re-count headline
numbers, re-read the highest-impact file:line claims, and resolve any
same-site contradiction. Sub-agent `watch` notes are cues until the final
author verifies them.

Review lenses: C boundaries -> D contracts -> E failures -> A size ->
B drift -> F tests. Use this order when choosing what is worth
smoothing next.

## Default Density — News Topic Style

Compress the answer like a news headline, not a press release: short
sentences carrying the headline-grade facts, nothing padded around
them. Reducing volume must not erase the data — vague is host-y in
disguise.

Necessary information stays visible:

- file paths (with `:line` when useful)
- counts (159 hits, 177 LOC, 9 candidates, 216 files)
- scan range when claiming absence ("0 cycles in 216 files" beats
  bare "no cycles")
- one-line qualitative read

Trim the padding:

- "Why it matters", "Why now", "Check after", "Ask the coding agent"
  sub-bullets — drop unless the user asked for handoff
- JSON dot-paths like `checklist-facts.json.A6_circular_deps.sccCount`
- internal labels: FP ids, SAFE_FIX/REVIEW_FIX tiers, P-phase names
- long preamble or closing host lines

Expand into the full sub-bullet shape under Output Shape only on
proof/handoff/CI/maintainer asks. Otherwise: three short Strengths,
three short Smoothing candidates with file/line/count, one or two
leave-alone notes, one line of confidence.

When a full profile was run but the user did not ask for a full report,
add exactly one required feature-discovery tail at the end. It should
make clear that the short answer is intentional, not that the evidence
was thin, and that the same evidence can be expanded. This is not
decoration; include copyable phrases the user can type next. Do not omit
it after full-profile short answers. Do not add this after small quick
follow-ups.

## Truth Before Warmth

Kindness means actionable clarity, not forced optimism. If the scan has
only thin grounded strengths or the strongest signals are severe
problems, do not pad "Already Stable" with weak praise. Keep that
section to one factual line, or rename it to "Current State" and state
what the scan can and cannot support.

## Output Shape

```markdown
# Gentle Structural Review

## Already Stable

- {grounded strength}
  Why I think this: {short proof, usually artifact name only}

## Worth Smoothing Next

1. {small next improvement}
   - Why it matters: {what this makes easier next}
   - Why now: {structural reason, not blame}
   - Start here: `{file/module}`
   - Check after: `{command or artifact field}`
   - Ask the coding agent: "{one-sentence prompt for the smallest safe code slice}"
   - Why I think this: {short proof, usually artifact name only}

## Keep As-Is For Now

- `{file/module}` — {reason, especially known FP family or low-confidence
  dead-export signal}

## Confidence

- Scan range: {from manifest}
- Unknowns: {missing optional artifacts / blind zones}
- Next pass: {quick / full / refactor-plan}
- If full-profile evidence was collected but this answer stays short:
  {one required feature-discovery tail, e.g. "I kept this short; I can expand the
  same evidence into a full checklist walk, formal report, or
  due-diligence handoff. You can say: 'full checklist로 펼쳐줘',
  'formal report로 써줘', or 'due-diligence handoff로 정리해줘'."}
```

## Selection Rules

Pick at most three smoothing candidates. Prefer issues that:

1. affect future change cost
2. have a concrete starting file
3. are backed by artifact evidence
4. can be verified after a small change

For each smoothing candidate that may lead to a code change, include a
single copy/paste "Ask the coding agent" prompt. Keep it narrow: one
slice, one starting file or owner chain, pre-write first when useful,
unrelated cleanup out, and one verification command or artifact check.

Do not include a finding just because a raw gate says `fix`. Gate values
are triggers. The model still checks context and can downgrade to
`watch`.

Do not turn raw cues into recommendations without a named criterion. A
silent catch needs a probe-vs-fallback criterion, duplicate helper advice
needs signature compatibility plus source review of any
`function-clones.json` cue, and oversized-function advice needs named
separable responsibilities. If that criterion is missing, keep the item
as watch/context or leave it out of the top three.

Before turning `fix-plan.reviewFixes` into smoothing candidates, screen
for known FP families with `references/false-positive-index.md`. Use the
long ledger only for a targeted FP id, exact proof, or a new entry. If
entries cluster under dynamic-import command/plugin dirs, public package
surfaces, config conventions, codegen files, framework sentinels, or
test-only consumers, put the cluster in "Keep As-Is For Now" unless
additional evidence proves it is actionable.

## Evidence Rules

Every concrete claim still needs one of these internal evidence labels:

- `[grounded, <artifact>.json.<field-path> = <value>]`
- `[degraded, confidence: low|medium|high, <reason>]`
- `[확인 불가 / unknown, scan range: <range>]`

Do not paste the full label by default. In ordinary chat, translate it
to a short proof line such as `cycles: 0 (topology.json)` or
`not enough evidence yet; full profile not run`. Expand raw field paths,
FP ids, and tier names only when the user asks for proof, exact counts,
or reviewer handoff.

For absence claims, name the scan range. For optional artifacts such as
`call-graph.json`, `barrels.json`, `runtime-evidence.json`, or
`staleness.json`, say when the artifact is absent instead of filling the
gap with prose.

## Tone

Say:

- "already stable"
- "worth smoothing next"
- "start here"
- "check after"
- "keep as-is for now"
- "not enough evidence yet"
- "protected surface; leave it alone for now"

Do not say:

- "bad architecture"
- "trash"
- "failed"
- "you should have known"
- "Tier C means dead"
- "FP23" unless the user asks for the evidence trail
