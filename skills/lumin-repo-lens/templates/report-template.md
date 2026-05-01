# Report Template

The final audit report follows this exact structure. Do not invent alternative sections — predictable layout protects the user's reading pattern.

---

```markdown
# {REPO} Grounded Structural Audit ({YYYY-MM-DD})

> Target: {REPO}
> Scope: {scope}
> Artifacts: `{artifact_dir}/`

## HCA-1 30-second summary

- [Target] {one sentence}
- [Key metrics] {metric 1} [grounded], {metric 2} [grounded], {metric 3}
- [Conclusion] {one sentence, no hedging}
- [Suggested action] {1-2 concrete actions}
- [Reading guide] Main body takes {N} minutes. Details in section {X}.

## HCA-2 결정 필요

Only items requiring user judgment. Auto-progressable actions go in section 6, not here.

When `fix-plan.json` is available (run `rank-fixes.mjs`), the 4-tier
ranking maps cleanly:

- **SAFE_FIX** → section 6 (auto-progressable; no decision needed)
- **REVIEW_FIX** → HCA-2 (human decision on specific items)
- **DEGRADED** → evidence improvement first (fix `tsconfig`/add
  coverage/clarify namespace use before deciding)
- **MUTED** → not a finding (classifier-excluded)

| Decision | Options | Impact | Recommendation |
|---|---|---|---|
| ... | ... | ... | ... |

If no decisions needed: "No user decision is needed for this audit."

## HCA-3 Evidence Trail Index

Top 10 findings with artifact pointers. Prefer `fix-plan.json`
entries since they carry tier + reason inline.
State the selection rule before listing items, for example: "Selected
because these findings are linked to HCA-2 decisions, carry a fix/watch
rating, and have both artifact and file-level evidence." Do not let the
top-10 list look arbitrary.

- `f-{module}-{seq}` "{claim excerpt}" — {artifact.json, tier: X}
- ...

---

## HCA-4 Classification Criteria

Before interpreting the evidence, write the criteria used for ambiguous
families in this report. Keep this short, but make the thresholds
auditable.

- **Probe vs silent fallback**: {when a catch/fallback is a harmless
  untrusted-input probe vs when it hides a canonical path or domain state
  failure}
- **Duplicate/helper extraction**: {what signature/body compatibility is
  required before recommending one shared helper}
- **String or wire-constant drift**: {what repetition threshold makes a
  literal a watch item}
- **Oversized function responsibility**: {what separable responsibilities
  were named; if none, classify as large-single-responsibility/watch}
- **Evidence-trail selection**: {why the indexed findings were selected}

## 1. Overview
{context + scope, 1-2 paragraphs}

## 2. Executive Summary

### 2.1 Grounded findings
{concrete numbers, no hedging}

### 2.2 Degraded findings
{labeled estimates with confidence}

### 2.3 Blind / unknown
{what could not be verified, scan range named}

## 3. Methodology and limits
{tools used, FP patterns checked for}

## 4. Detailed analysis
{prose with grounding labels inline: `claim [grounded]` or `claim [degraded, confidence: X]`}

## 5. Comparison (if M6 ran)
{matrix + "A in state X, B in state Y" — no ranking}

## 6. Action recommendations
{by timeframe: short term / medium term / long term / decision}
{each with risk + automation + estimated_change}

## 7. Methodology reflection (AST vs LLM)
{what AST did well, what LLM would be needed for}

## 8. Correction log (mandatory, even if empty)
### 8.1 Numeric differences from previous audits
### 8.2 Estimates corrected during this session
### 8.3 New FP patterns

## 9. Remaining work / out of scope
{what wasn't done, scope-limited items}

## 10. Appendix
### A. Analysis script list
### B. JSON artifact paths
### C. Environment
### D. FP ledger references

---

**Audit completed**: {ISO 8601 timestamp}
**Session ID**: {session-id}
```

## Rules

### HCA sections first

HCA-1/2/3/4 before section 1. This is the user's entry point. They must fit in the first screen.

### Classification before synthesis

Separate three layers:

1. **Observation** — what artifacts or files say.
2. **Classification** — what category the observation belongs to.
3. **Recommendation** — what, if anything, to do next.

Do not move from observation to recommendation without naming the
classification criterion. If the criterion is not clear, downgrade the
item to `watch`, `degraded`, or `[확인 불가]` rather than inventing a
verdict.

### Sub-agent / multi-pass synthesis gate

When the report combines multiple assistant walks, sub-agent notes, or
separate review passes, the final author must verify before publishing:

- Re-count all headline numbers and any surprising counts.
- Re-read 5-10 highest-impact file:line claims directly.
- Build a small ledger keyed by `file:line` or `symbol`; one key must
  not appear as both "intentional/probe" and "violation/fix".
- Treat sub-agent `watch` findings as review cues, not grounded
  conclusions, until the final author verifies the full path.
- If two passes disagree, resolve the disagreement in the report instead
  of carrying both claims forward.

### Prose-first

Sections 1-9 use narrative prose. Tables only for comparison. Avoid:
- Over-bulleting (turning everything into lists)
- Hierarchical bullet trees
- Redundant section duplication

### Grounding labels inline

In prose, every count or assertion gets a label:
- "541 files [grounded], SCC cycles 0 [grounded]"
- "Estimated cleanup 700-800 LOC [degraded, confidence: medium]"
- "Intent of pattern X is unknown [blind]"

### Correction log is mandatory

Even if nothing to correct, include section 8 with "No corrections in this session." Forms the audit trail.

### Final author closeout

Before final answer or handoff, re-read the report yourself. Manually
verify headline counts, same-site classifications, broad conclusions, and
chat-persona leakage against the cited artifacts or source. Do not
replace this with string-lint heuristics.

### Grounded Encouragement

Do not use empty praise or empty blame. Praise is allowed when it is
grounded in artifact evidence; criticism must be phrased as an
actionable improvement.

Avoid:

- "완벽합니다" without evidence
- "이 코드는 나쁩니다"
- "왜 이렇게 했나요"
- "쓰레기 / terrible / failed"

Prefer:

- "Cycle SCC count is 0 [grounded], so dependency direction looks stable."
- "The next refactor candidate is A2 function size: one function is 427 LOC, which can raise change cost."
- "Evidence is incomplete; first confirm with `--profile full`."

Numeric description still wins over vague praise, but the report should
help the reader keep moving.

### Finding referencing

Every claim in narrative that isn't trivial links to a finding ID. Format: `f-{module-number}-{sequence}`. Claims without finding IDs are summaries of multiple findings.

Use full paths when a basename appears more than once in the repository.
If the audit artifacts and current working tree disagree on file count,
LOC, or timestamp, mention that freshness gap in the correction log
before making current-state claims.

### Recommendation wording

Avoid cost shortcuts such as "one change" or "simple" unless the touched
files, count of call sites, and verification path are clear. Prefer
"small PR", "one starting file", or "four-step PR" when that is the
truth.

Formal reports do not include chat persona markers such as signatures,
emoticons, or role names. Keep warmth in the wording, not in markers.

### Report locale

- Body (narrative): user's language
- Section titles: translate to the user's language when producing the final report
- Code blocks, artifact names: unchanged
