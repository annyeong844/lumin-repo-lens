# canonical/pre-write-gate.md

> **Role:** protocol for P1's pre-write mode. When Claude is about to write new code, this mode finds what already exists and surfaces it before the write happens.
> **Owner:** this file.

---

## 1. Purpose

Close the gap between "Claude about to write X" and "Claude knowing whether X exists". This is the skill's top-priority feature per `canonical/invariants.md` §6.

## 2. Entry

- Dispatched from `canonical/mode-contract.md` §2.1 (trigger rules).
- Must return **before** Claude writes source code for the request. If pre-write times out or errors, Claude labels the situation `[확인 불가, pre-write failed]` and proceeds with an elevated caution posture; pre-write does not block.

## 3. Protocol

### Step 1 — Ground state lookup

Read, in order, the first available:

1. `canonical/` directory if present → authoritative declared invariants.
2. Most recent `<output>/<fact-artifact>.json` set if present and not stale (see `canonical/fact-model.md` §4 for confidence-downgrade + staleness rules).
3. Fresh targeted audit otherwise (run the minimum subset of scripts needed — see §4 below).

Absence of canonical/ is NOT absence of evidence. The fact model from the skill's existing scripts already grounds most of the pre-write needs.

### Step 2 — Extract intent

From Claude's own upcoming action (what it is about to create), extract:

- **Names** Claude plans to introduce (e.g., `formatTimestamp`, `UserProfile`).
- **Shapes** Claude plans to introduce (field sets for new interfaces, parameter shapes for new functions).
- **Files** Claude plans to touch or create.
- **Dependencies** Claude plans to add or reuse from package declarations
  (package specifiers such as `date-fns` or `@scope/pkg`; internal modules
  belong in `files` or `names`).
- **Planned type escapes** — any intentional `any`, `as any`, `as unknown as T`, JSDoc `{any}`, `@ts-ignore`, or `no-explicit-any` disable Claude plans to write. Each declared up front with the reason (third-party lib shape unknown, migration scaffold, etc.). Declaration here is the intent-side half of the three-stage defense in `canonical/any-contamination.md` §6 Stage 1; post-write compares planned-vs-observed to catch silently-introduced escapes.
- **Planned files** — repo-relative files Claude expects to add or materially touch when that can be inferred. Post-write compares this list against files that appeared after pre-write and records scanned files outside the list as `fileDelta.unexpectedNew`.

Intent extraction is explicit — Claude states these five items before pre-write proceeds when it can. This forces self-declaration, which is itself a useful artifact. The JSON transport normalizes all five top-level keys: `names`, `shapes`, `files`, `dependencies`, and `plannedTypeEscapes` (see `references/pre-write-intent-shape.md`). Missing top-level arrays are defaulted to `[]` with `intentWarnings`; present-but-wrong types remain schema errors. `names` / `dependencies` may be terse strings or structured self-declarations with `why`; lookups normalize to strings and preserve the declaration metadata in the advisory JSON.

### Step 3 — Lookup per intent item

For each item in the intent list:

| Intent | Lookup | Output shape |
|---|---|---|
| Name candidate | symbol graph by identity (see `identity-and-alias.md`) | "exists at `<owner>::<name>`" / "not observed in scan range" |
| Shape candidate | shape hash index (fact-model.md) + any-contamination check (any-contamination.md §3 "Contamination definitions" + the "Pre-write gate interaction" block in §6 Stage 1 / §9) | "matches shape of `<identity>`" / "matches but candidate is any-contaminated" / "no structural match" |
| File candidate | topology + triage.topDirs | "file exists; N LOC" / "new file; boundary rule `<rule>` applies"; may also emit domain-cluster Watch-for evidence when sibling files share a prefix or repeated basename token |
| Dependency candidate | package.json + existing package-import consumer graph | "already imported from `<file>`" / "declared package with no observed static package imports" / "new package; requires install" |

Every lookup returns a result with a citation in the `[grounded, <artifact>.json.<field>=<value>]` form (invariants.md Iron Law).

**Any-contamination reuse caution rule** (from `canonical/any-contamination.md` §6 Stage 1 "Pre-write" + §9 "Pre-write gate interaction", annotation shape in §4, tier definitions in §3): caution is label-specific, NOT blanket. The `anyContamination` annotation may carry any combination of `has-any`, `any-contaminated`, `severely-any-contaminated`, and `unknown-surface` in its `labels` array. Each tier gets a different advisory rendering.

Epistemic labels are measurement-only here: `[grounded]`, `[degraded]`, and `[확인 불가]` describe whether the tool measured the contamination fact. Semantic reuse caution is separate and uses `recommendation: warn-on-reuse`.

Current capability note: if `symbols.meta.supports.anyContamination !==
true`, pre-write emits a single capability note and renders semantic
contamination state as `[확인 불가, reason: producer did not emit
anyContamination capability]`. It must not call a candidate clean merely
because the annotation is absent.

| `labels` includes | Lookup rendering |
|---|---|
| none (annotation omitted, capability true) | `[grounded, ...]` — clean reuse candidate. |
| `unknown-surface` only | `[grounded structural, semantic caution: unknown-surface]` — `unknown` is a safe boundary type, NOT contamination. Advisory notes that reuse requires narrowing via type guards; candidate is fine. |
| `has-any` only (no `any-contaminated` escalation) | `[grounded structural, any signal present, semantic caution: mild `any` occurrence]` — single passing occurrence (e.g. one `Record<string, any>` field). Reuse is viable but the advisory surfaces the measurement so Claude can weigh it. |
| `any-contaminated` or `severely-any-contaminated` | `[grounded, anyContamination.label = ..., measurements = ...]` plus `[recommendation: warn-on-reuse, confidence: low, reason: <label> semantic reuse caution]` — measurement remains grounded; reuse carries real type-safety loss. |

The advisory text MUST surface the raw measurements from `anyContamination.measurements` (ratio, counts) for every non-clean tier, not just the label — scale is the signal Claude needs (see any-contamination.md §11 "Honesty requirements").

**Never call `unknown-surface` "contaminated"** and **never apply `warn-on-reuse` to a `has-any`-only or `unknown-surface`-only candidate**. Doing so teaches the wrong type-system lesson (`unknown` is GOOD boundary design) and inflates the caution signal past the point Claude can act on it.

### Step 4 — Emit pre-write advisory

Output the advisory to Claude before it writes. Format in §5.

### Step 5 — Claude writes (or doesn't)

Claude may:

- Adopt a pre-existing item (quotes the citation in its own message).
- Proceed with a new item (cites override reason).
- Ask the user for clarification when an existing item is near-but-not-quite.

The gate is advisory; Claude retains authorial authority.

## 4. Minimum script subset for fresh audit

When `<output>/` lacks recent artifacts, run only what the intent items require:

- Name lookup → `build-symbol-graph.mjs` (alone; fastest ground state).
- Shape lookup → `build-shape-index.mjs` when the intent includes shape entries. Grounded matches still require an exact `shape.hash` or supported `shape.typeLiteral`. If the intent has only loose field names, or if no validated `shape-index.json` is available, emit `[확인 불가]` rather than a fuzzy match.
- File/boundary lookup → `build-symbol-graph.mjs` + `triage-repo.mjs` + `measure-topology.mjs` (if not cached). Symbols are included for parse-error honesty and file-local definition facts.
- Dependency lookup → package.json direct read + `build-symbol-graph.mjs`
  for observed static package-import consumer counts. This lane is for
  package specifiers, not relative/internal module paths. If the symbol
  graph is unavailable or lacks `meta.supports.dependencyImportConsumers`,
  report the import count as unavailable; never render it as `0 observed
  consumers`.

Never run the full pipeline for a pre-write. Latency budget: < 5 seconds total in warm-cache case, < 30 seconds in cold-cache.

## 5. Output format

Pre-write output is consumed by Claude, not by the user. Structured for Claude to cite directly.

```
## pre-write advisory (canonical/pre-write-gate §5)

### Already exists (reuse candidates)

- `formatTimestamp` — not observed in scan range.
  [확인 불가, scan range: TS/JS production files ex tests, symbols.json absent → fresh build-symbol-graph pass, no `formatTimestamp` identity found]

- `formatDate` — EXISTS at `src/utils/date.ts::formatDate`.
  [grounded, symbols.json.defIndex['src/utils/date.ts']['formatDate'] present, fan-in = 8]
  Reuse candidate. Shape: `(Date) => string`.

### Already exists — but any-contaminated (reuse with warning)

- `UserData` — EXISTS at `src/types/User.ts::UserData`.
  [recommendation: warn-on-reuse, confidence: low, reason: severely-any-contaminated semantic reuse caution; measurement remains grounded]
  [grounded, type-owner.anyContamination = {label: "severely-any-contaminated", labels: ["has-any", "severely-any-contaminated"], measurements: {totalFields: 7, anyFields: 6, unknownFields: 0, anyFieldRatio: 0.85, indexSignatureAny: false}}]
  ⚠ Candidate is severely any-contaminated (85% any fields). Reusing it will not transfer type safety; consider writing a typed version or tightening the candidate first.

### New code candidates

- New file `src/utils/time.ts` — would be new.
  [grounded, topology.json.nodes does not contain 'src/utils/time.ts'; topology.meta.complete = true]
  Boundary rule: `src/utils/*` has zero cross-submodule inbound; safe to add.

### Watch-for

- Shape `{ year, month, day, hour }` — exact shape lookup unavailable from field names alone.
  [확인 불가, reason: shape intent lacks exact sha256 shape hash or supported typeLiteral; field names alone are not structural equality evidence]
  P4 shape lookup can emit grounded matches only from a validated `shape-index.json` and an exact hash or supported `typeLiteral` normalized by the P4 shape-hash producer.

- DOMAIN_CLUSTER_DETECTED — planned `lib/cardNewsService.js` shares prefix `lib/cardNews*` with 9 existing files.
  [grounded, topology.json.nodes matched 9 files with prefix 'lib/cardNews*']
  Recommendation: inspect the existing domain cluster before creating a parallel owner file.
- DOMAIN_CLUSTER_DETECTED — planned `_engine/lib/artifact-loader.mjs` shares domain token `artifact` with existing `*-artifact.mjs` siblings.
  [grounded, topology.json.nodes matched N files with domain key 'artifact' in '_lib']
  Recommendation: inspect the existing domain cluster before creating a parallel owner file.

### Planned type escapes (from Step 2 intent)

- 1 escape planned: `as unknown as ThirdPartyShape` at `src/vendor/wrapper.ts::adaptResponse`.
  Reason declared: upstream SDK lacks type exports; wrapper narrows at the boundary.
  [grounded, intent extracted at pre-write Step 2; will be checked against observed escapes in post-write per any-contamination.md §6 Stage 2]

Or, when none are planned:

- 0 escapes planned. Post-write will treat any observed `type-escape` (every `escapeKind` enumerated in `canonical/fact-model.md` §3.9 — `explicit-any`, `as-any`, `angle-any`, `as-unknown-as-T`, `rest-any-args`, `index-sig-any`, `generic-default-any`, `ts-ignore`, `ts-expect-error`, `no-explicit-any-disable`, `jsdoc-any`) as a silent introduction per any-contamination.md §6 Stage 2.
```

Sections:

- **Already exists** — each intent item looked up. `EXISTS` entries carry reuse hints. `not observed` entries carry `[확인 불가]` with scan range.
- **New code candidates** — intent items that would legitimately be new (`NEW_FILE` with `topology.meta.complete: true`, or `NEW_PACKAGE`). Heading is neutral — a `FORBIDDEN` boundary sub-line here is a legitimate warning, not a self-contradiction. P1-2 cannot emit `ALLOWED` / `FORBIDDEN` boundaries without planned `from → to` edges, so most P1-2 rows show `boundary: not evaluated` with `[확인 불가]`.
- **Watch-for / search hints** — shape-matches, domain clusters, boundary-adjacent cases, feature envy risks, and intent-token name hints. Advisory, not blocking. Intent-token hints are degraded search cues, not grounded reuse claims.
- **Planned type escapes** — the Step 2 declared-escape list, echoed so post-write has an anchor for the planned-vs-observed delta. Empty-list form is the default; any non-empty entry must carry a declared reason.

## 6. What pre-write does NOT do

- Does not block Claude from writing. Advisory only.
- Does not rewrite Claude's plan. Claude reads the advisory and decides.
- Does not verify the user's intent matches the advisory. That's user's judgment.
- Does not run every script. Only the minimum subset for the intent.
- Does not emit a "fix this" message to the user. The user sees Claude's final output; the advisory is internal.

## 7. Confidence and scan-range rules (inheriting from invariants.md)

Every `EXISTS` / `not observed` line MUST carry a citation.

For `EXISTS`:

- Cite the artifact field and the identity (`symbols.json.defIndex[file][name]`, shape hash, etc.).
- If confidence < high (resolver blindness > 15%, parse errors present, staleness > N days), demote the line:
  - `EXISTS` → `LIKELY EXISTS [degraded, confidence: medium]`.
  - Caller notes the degradation.

For `not observed`:

- ALWAYS `[확인 불가, scan range: ...]`.
- Never say "does not exist" — the scan is bounded, external use is not ruled out.

## 8. How pre-write interacts with canonical/ when present

If the repo has a `canonical/` directory (user or LLM-maintained):

- Read owner claims from `canonical/helper-registry.md`, `canonical/type-ownership.md`, etc.
- Use them as the **first** source of truth for "already exists".
- If canonical and current AST disagree, emit a drift warning in the advisory (not a block):
  - `CANONICAL DRIFT: canonical/type-ownership.md:L42 lists owner as X; current AST observes Y.`
- Full drift analysis is P5 (`check-canon.mjs`, separate spec); pre-write only flags obvious name/owner mismatches.

## 9. Why pre-write, and not post-write alone

Post-write catches mistakes after the fact. Pre-write prevents them. For vibe-coder repos, the cost of post-write-only is that every session leaves residue even when the error is found — Claude wrote it, got told, now has to undo. Pre-write shortens the loop.

Both are needed (P2 exists for what pre-write missed). But pre-write is the primary defense.
