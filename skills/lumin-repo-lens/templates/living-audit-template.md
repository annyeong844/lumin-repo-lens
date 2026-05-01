# Living Structural Audit Document

Use this when the repo already has a living audit document, or when the
user asks to keep audit results tracked over time. This is not an engine
summary and not a ranked recommendation list. The main controller model
authors and updates it after reading raw artifacts and checking the
highest-impact code claims directly.

Preferred path for new docs:

```text
docs/current/audit/lumin-structural-audit.md
```

Also support existing repo conventions such as `LUMIN_REPO_LENS.md`,
`LUMIN_AUDIT.md`, or `TECH_DEBT_AUDIT.md` when they are already present.

## Update Rules

- Read the previous document before writing the final chat answer.
- Run or reuse the relevant lumin-repo-lens profile, then read
  `manifest.json` first.
- Compare only evidence lanes that were actually produced in both runs.
- Mark `RESOLVED` only when the current scan range and evidence lane are
  comparable to the previous claim. If not comparable, use
  `NOT_RECHECKED`.
- Treat subagent notes as cues. Before updating a tracked item, the main
  controller verifies headline counts, same-site contradictions, and
  high-impact file:line claims.
- Do not add a priority just because an artifact gate says `watch` or
  `fix`. State the criterion that makes the item worth tracking.
- Keep user-facing prose plain. Keep raw artifact paths in the evidence
  line, not in every sentence.

## Status Labels

- `NEW`: appears in the current evidence and was not tracked before.
- `ACTIVE`: still appears with comparable evidence.
- `CHANGED`: same item, but location, evidence, or scope changed.
- `RESOLVED`: no longer appears under a comparable scan/evidence lane.
- `NOT_RECHECKED`: could not be confirmed because scan range, profile,
  artifacts, or confidence changed.
- `DEFERRED`: intentionally left for later; keep the reason short.

## Template

```markdown
# Living Structural Audit

## Contract

This document tracks structural audit items over time. It is maintained
by the coding assistant from lumin-repo-lens artifacts plus direct code
checks. It is not generated solely from `audit-summary.latest.md`.

## Last Update

- Date:
- Command/profile:
- Scan range:
- Produced artifacts:
- Missing or degraded evidence:
- Previous document read:

## Current State

- Stable facts:
- Main limits:

## Tracked Items

### NEW

#### {short item title}

- Status: `NEW`
- Evidence:
- Code checked:
- Why tracked:
- Smallest next action:
- Verification:

### ACTIVE

#### {short item title}

- Status: `ACTIVE`
- Evidence:
- Code checked:
- What changed since last update:
- Next action or reason to keep:

### CHANGED

#### {short item title}

- Status: `CHANGED`
- Previous evidence:
- Current evidence:
- What changed:
- Next action:

### RESOLVED

#### {short item title}

- Status: `RESOLVED`
- Previous evidence:
- Current comparable scan:
- Resolution evidence:
- Follow-up needed:

### NOT_RECHECKED

#### {short item title}

- Status: `NOT_RECHECKED`
- Previous evidence:
- Why not rechecked:
- What would recheck it:

## Decisions And Criteria

- Criterion:
- Decision:

## Do Not Do

-

## Next Verification

-
```
