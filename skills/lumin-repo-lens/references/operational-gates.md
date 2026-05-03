# Operational Gates

Use this reference when deciding how strongly to word audit results,
marketplace claims, or cleanup automation.

## Product Claim Boundary

This skill can be described as a grounded structural-audit and
review-assistance tool before it can be described as an automatic
cleanup tool.

Never claim:

- zero false positives
- perfect TypeScript semantic analysis
- autonomous safe cleanup from raw Tier C
- "definitely dead" when only static no-consumer evidence exists

Allowed before Green readiness:

- grounded structural audit
- evidence-backed cleanup candidates
- canonical drift detection
- review-assisted triage

## FP Denominators

Primary FP population:

- review-visible cleanup candidates shown to a user as removable or
  demotable
- usually `fix-plan.safeFixes + fix-plan.reviewFixes`

Separate populations:

- `SAFE_FIX` precision
- raw Tier C
- `DEGRADED`
- `MUTED`
- canon-drift candidates

Formula:

```text
false_positives / (true_positives + false_positives)
```

`inconclusive` and `not_applicable` are excluded from numerator and
denominator and reported separately as sampling-quality signals.

## Readiness Gates

This section is maintainer-facing measurement guidance. Use it for
release and marketplace wording decisions; ordinary repo-review chat
should quote the Product Claim Boundary and SAFE_FIX Bar instead of
dumping these gates at the user.

Red:

- FP unknown
- candidate counts unavailable
- schema round-trip not attempted
- unresolved HIGH finding
- no immutable corpus identity

Yellow:

- advisory audit is usable, but cleanup wording is limited
- `SAFE_FIX` population may be empty
- review-visible FP is measured but not Green

Green requires all of:

- `SAFE_FIX` FP < 5%
- review-visible cleanup FP < 10%
- at least two non-trivial TypeScript repos
- at least 50 adjudicated candidates per repo, or all if fewer
- candidate counts available; missing artifacts are not zero
- immutable corpus commit or snapshot id
- clean worktree, or dirty-state `snapshotId` / `contentHash`
- P3/P5 schema round-trip attempted
- zero known P3/P5 schema-drift bugs
- no unresolved HIGH findings in the FP ledger

If the measured `SAFE_FIX` population is zero, do not mark the run Red
solely for missing SAFE_FIX adjudication. Mark Yellow with
`safe-fix-population-empty`; autonomous cleanup wording remains blocked.

## SAFE_FIX Bar

Tier C alone never means "definitely dead." SAFE_FIX means the
candidate is static-graph-clean under the recorded scan range and has a
mechanical action. It does not require runtime coverage or git history;
those are supporting evidence when present, not prerequisites.

SAFE_FIX requires:

- static no-consumer or export-demotion evidence for this symbol
- no resolver blindness or parse taint blocking this finding
- no matching FP ledger or framework policy exclusion
- no exported-declaration dependency
- no runtime evidence contradicting the static graph

Recent code can still be SAFE_FIX when the static graph is clean; report
freshness as context rather than hiding the candidate.

## Throughput Notes

Full audit can be slow on large TS repositories. While iterating, prefer:

- `--production`
- repeated `--exclude` flags
- source-specific canon commands
- `check-canon --source all`
- focused producer repros

Shared AST cache, resolver cache, and broader scan reuse are P6 work,
not current guaranteed capability.

Do not publish fixed "1M LOC in N seconds" claims until P6 measurement
artifacts prove them on pinned corpora. Safer wording:

- first scan may be slow on very large repositories
- keep artifacts and use warm/incremental pre-write flows for iteration
- report measured runtime from the local `manifest.json`
