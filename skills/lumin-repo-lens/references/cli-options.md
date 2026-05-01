# CLI Options And Advanced Flows

Use this reference for scan-scope flags, topology lenses, incremental
mode, SARIF output, focused drilldowns, and internal step-by-step
debugging.

## Scan Scope Flags

Every scanner that walks the repository uses the shared CLI parser and
honors the same selection flags:

| Flag | Effect |
|---|---|
| `--include-tests` | include test files; default |
| `--no-include-tests` | exclude test files |
| `--no-tests` | alias for `--no-include-tests` |
| `--exclude-tests` | alias for `--no-include-tests` |
| `--production` | same as `--no-include-tests` |
| `--include-tests=false` | accepted and coerced |
| `--exclude <pattern>` | repeatable directory-segment or explicit file-path exclusion |

Test-file detection is language-aware for JS/TS, Python, and Go. It
also recognizes directory segments such as `test/`, `tests/`,
`__tests__/`, `e2e/`, `integration/`, `fixtures/`, and `mocks/`.

Exclude patterns are conservative by default: `--exclude build` prunes a
`build/` directory segment but does not remove `build-index.ts`. Use an
explicit path or basename such as `--exclude src/a.ts` or
`--exclude skip-me.js` to exclude files.

## Topology Lenses

`measure-topology.mjs` defaults to the runtime lens: type-only imports
are excluded from SCC calculation because they are erased at compile
time.

Use `--include-type-edges` for the broader static graph:

```bash
node scripts/audit-repo.mjs --root <repo> --output <dir>
node _engine/producers/measure-topology.mjs --root <repo> --output <dir> --include-type-edges
```

Dynamic imports are included in both lenses when the target is
statically resolvable. Always label cycle claims with the lens:
`[grounded, lens: runtime]` or `[grounded, lens: static]`.

## Incremental Mode

`measure-topology.mjs` and `build-symbol-graph.mjs` accept
`--incremental`. File-hash caches skip unchanged files after the first
run.

Artifacts:

- `topology.cache.json`
- `symbols.cache.json`

Caches are not git-dependent and are safe to delete.

## SARIF

`emit-sarif.mjs` emits `lumin-repo-lens.sarif` in SARIF 2.1.0 format.
Prefer the orchestrator with `--sarif` or the `ci` profile.

For dead-export rule `GA001`, run `rank-fixes.mjs` first. When
`fix-plan.json` is present:

- `SAFE_FIX` becomes SARIF warning
- `REVIEW_FIX` and `DEGRADED` become SARIF note
- `MUTED` is not emitted

Without `fix-plan.json`, SARIF falls back to older ad-hoc severity and
may overstate warnings.

## Dead-Export Proposal Buckets

`dead-classify.json` has four proposal buckets:

| Bucket | Kind covered | Action |
|---|---|---|
| `proposal_C_remove_symbol` | real definitions with 0 in-file uses | remove definition |
| `proposal_A_demote_to_internal` | real definitions with 1-2 in-file uses | drop `export` |
| `proposal_B_review` | real definitions with 3+ in-file uses | design review |
| `proposal_remove_export_specifier` | aliased export specifiers | remove export line |

Aliased re-exports carry `localName`, `localInternalUses`, and
`localAlsoDead` so callers do not delete an unrelated local definition.

## Focused Drilldown

`resolve-method-calls.mjs` accepts `--focus-class <Name>` for a
per-class method usage table:

```bash
node _engine/producers/resolve-method-calls.mjs --root <repo> --output <dir> --focus-class MyService
```

Without the flag, class-specific output is omitted.

## Internal Step-By-Step Flow

Use this only for engine development or narrow repros. Ordinary users
should use `scripts/audit-repo.mjs`.

1. `triage-repo.mjs`
2. `measure-topology.mjs`
3. `measure-discipline.mjs`
4. `build-call-graph.mjs` when helper/call evidence is needed
5. `build-symbol-graph.mjs`
6. `classify-dead-exports.mjs`
7. `merge-runtime-evidence.mjs` when coverage exists
8. `measure-staleness.mjs` when the target is in git
9. `rank-fixes.mjs`
10. `emit-sarif.mjs` when SARIF is requested

The orchestrator exists to avoid accidentally skipping ordering-critical
steps such as `rank-fixes.mjs`.
