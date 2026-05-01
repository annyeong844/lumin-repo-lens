# canonical/classification-gates.md

> **Role:** ordering of duplicate / single-identity classification labels. Fixes the two P0 precedence conflicts from `SPEC-canon-generator v0.1`. This file is the source of truth; any conflicting status table in a P-spec is wrong.
> **Owner:** this file.

---

## 1. Purpose

Identity classification (via `canonical/identity-and-alias.md`) produces a set of identities, possibly sharing a name. Classification gates assign a label per group (when duplicates exist) or per identity (when single-owner). Order of evaluation matters — `Result` must not collapse into `LOCAL_COMMON_NAME` just because the name is on a low-info list, if fan-in makes it a genuine shared concept.

This file codifies the corrected order. The v0.1 spec had:

```
defs.length ≥ 2 AND name ∈ LOW_INFO_NAMES → LOCAL_COMMON_NAME
...
```

which made `Result → DUPLICATE_STRONG` impossible. The fix below evaluates `DUPLICATE_STRONG` FIRST, then `LOCAL_COMMON_NAME`, then `DUPLICATE_REVIEW`.

## 2. Duplicate group classification

A **group** is the set of identities sharing an `exportedName`. Fan-in per identity is computed per `canonical/identity-and-alias.md` §3.

Evaluation order — **first match wins**:

| # | Condition | Label | Marker |
|---|---|---|---|
| 0 | `group.size ≥ 2` AND every identity in the group has `anyContamination.label ∈ {any-contaminated, severely-any-contaminated}` | `ANY_COLLISION` | ⚠ (name collision only; shape comparison meaningless per `canonical/any-contamination.md` §7) |
| 1 | `group.size ≥ 2` AND `max(fanIn over identities) ≥ 3` AND `sum(fanIn) ≥ 3` | `DUPLICATE_STRONG` | ❌ |
| 2 | `group.size ≥ 2` AND `name ∈ LOW_INFO_NAMES` AND `max(fanIn) < 3` | `LOCAL_COMMON_NAME` | ⚠ (omit from canon) |
| 3 | `group.size ≥ 2` | `DUPLICATE_REVIEW` | ⚠ |

Rule 0 fires BEFORE Rule 1 because a cluster of two `any-contaminated` blobs is not a meaningful shared concept — flagging it `DUPLICATE_STRONG` would be a confident false positive.

Rule 0 fires ONLY for groups where every member carries `any-contaminated` or `severely-any-contaminated`. Groups where members carry only `has-any` (mild) or only `unknown-surface` do NOT trigger Rule 0 — those identities retain meaningful structural comparability and fall through to Rule 1/2/3 normally. `unknown-surface` is a safe-boundary signal, not contamination; `has-any` alone may be a single passing occurrence (e.g. one `Record<string, any>` field on an otherwise clean type) and does not collapse the whole comparison.

### 2.1 Mixed duplicate groups — contaminated members must not disappear

A mixed group has SOME contaminated identities and some clean ones. It skips Rule 0 and falls through to Rule 1 / 2 / 3 normally — structural naming collision is real regardless of contamination. BUT the group output MUST preserve contamination visibility:

- `anyMembers: [identity list]` — identities with `any-contaminated` or `severely-any-contaminated`.
- `severeAnyMembers: [identity list]` — subset with `severely-any-contaminated`.
- `semanticConfidence: "low"` — fixed when `anyMembers.length > 0`.
- `tags: ["has-any-member"]` or `["has-severe-any-member"]` as applicable.

Invariant: **a contaminated member in a mixed duplicate group must never disappear** just because the group is not all-contaminated. Single-identity Rule 0 in §4 only applies to `group.size == 1`; contaminated members in larger groups are preserved via these annotations, NOT via separate labels (label proliferation is its own smell — see `canonical/any-contamination.md` §8.2).

Rationale:

- Rule 1 captures cases like `Result` in `src/protocol/errors.ts` (fanIn 18) + `src/engine/runner.ts` (fanIn 3). Same name, both heavily used — genuine shared concept, needs resolution.
- Rule 2 catches `Props` defined in 20 component files, each with fanIn 0 or 1 (only the component itself uses it). Local React shapes — not canon-worthy.
- Rule 3 is the fallback: same name, moderate fan-in, uncommon-or-ambiguous — review case.

## 3. LOW_INFO_NAMES

The hardcoded list for v1. Phase 2+ may accept a per-repo override config.

```
Props, Options, Config, State, Result, Meta, Item, Data, Context,
Args, Params, Response, Request, Handler, Input, Output
```

Note: `Result` is included — it's a low-info word — but Rule 1 (high fan-in → STRONG) fires before Rule 2 checks the list. A repo where `Result` is genuinely shared still gets `DUPLICATE_STRONG` even though `Result ∈ LOW_INFO_NAMES`.

## 4. Single-identity classification

For groups with `size == 1`. Evaluation order — **first match wins**:

| # | Condition | Label | Marker |
|---|---|---|---|
| 0 | identity carries `anyContamination.label == 'severely-any-contaminated'` | `severely-any-contaminated` | ⚠ (omit from canon; reuse candidates carry warning per `canonical/any-contamination.md` "Pre-write gate interaction" — §6 Stage 1 and §9) |
| 1 | `typeKind == TSTypeAliasDeclaration` AND `len(name) == 1` AND `fanIn < 3` | `low-signal-type-name` | ⚠ (omit from canon unless context override) |
| 2 | `fanIn ≥ 3` | `single-owner-strong` | ✅ |
| 3 | `fanIn ∈ {1, 2}` | `single-owner-weak` | ⚠ |
| 4 | `fanIn == 0` | `zero-internal-fan-in` | ⚠ |

Rule 0 fires FIRST. A severely-contaminated identity is NEVER promoted to `single-owner-strong` or `single-owner-weak` even at high fan-in — fan-in there reflects consumers of an opaque blob, not a meaningful shared contract. Less-than-severe `any-contaminated` identities fall through to normal classification but carry the annotation; downstream consumers (pre-write advisory, canon draft) demote semantic claims per `canonical/any-contamination.md` "Pre-write gate interaction" (§6 Stage 1 and §9), using the per-identity measurements from §3.

Rationale:

- Rule 1 must fire BEFORE Rule 3 / 4. In v0.1 the order placed `low-signal-type-name` after `zero-internal-fan-in`, which meant `export type T = ...` with fanIn 1 hit `single-owner-weak` first and never reached `low-signal`. Fixed here.
- A one-char exported alias with fanIn ≥ 3 is a legitimate shared alias (rare but possible), so Rule 2 can still promote it. Only sub-threshold one-char aliases are downgraded.

## 5. Critical notes (Claude-reader: do not skip)

### 5.1 `zero-internal-fan-in` is NOT "unused"

When a type has `fanIn == 0`:

- The scan only observes **internal** consumers (files within the scope).
- External consumers (library users of a published package, cross-repo imports) are invisible to the scan.
- Therefore `zero-internal-fan-in` means "no internal consumer was observed in the scan range", NOT "this type is unused".

Wording in all emitted artifacts, reports, and canon drafts must use `zero-internal-fan-in` (or the equivalent full phrase), never "unused". Rationale: the v0.1 spec used `unused-export`, which was a claim-level-too-strong. This file forbids that regression.

For public-API types, fanIn 0 is expected and safe. Cross-check with `dead-classify.json` public-API filters before suggesting removal.

### 5.2 `low-signal-type-name` is NOT "remove this"

A one-char exported alias with low fan-in is a **canon-omission** candidate, not a **code-removal** candidate. The type may exist for readability inside the owner file, or as a temporary generic parameter alias. Canon drafts simply skip it; source code is untouched.

### 5.3 `DUPLICATE_STRONG` is NOT a merge command

Flagging `DUPLICATE_STRONG` says "same name, both used, resolve the naming collision". Resolution may be:

- rename one (two distinct concepts, accidental collision),
- merge (same concept, pick owner),
- or adopt one as shared and retire the other (after migrating consumers).

The skill flags; humans / LLMs decide.

## 6. Context override (inherits from REVIEW_CHECKLIST §Rule 6)

A label emitted by this gate is a **trigger for review**, not a final verdict. The consuming report (canon draft, structural review, pre-write advisory) MUST:

1. State the raw fan-in number.
2. Assess whether the threshold fits the repo's context.
3. Keep / downgrade / upgrade the label and document which.

Example: a layered monorepo with intentional `Props` duplication across 50 component files will emit 50 `LOCAL_COMMON_NAME` labels. The report summarizes them as "50 component-local Props — expected pattern for this React repo" rather than listing every row.

## 7. Summary counting (group vs identity)

Artifacts that summarize classification must distinguish:

- `Duplicate groups` — count of type names with ≥ 2 identities (one unit per `User`, regardless of how many definitions).
- `Duplicate identities` — total identities that belong to duplicate groups (`User` with 3 definitions contributes 3 to this count).
- `Total type-name groups` — groups including singletons.
- `Total identities` — every identity in the repo.

A canon draft of type-ownership reports both "groups" and "identities" explicitly. Mixing them produces confusing summaries (v0.1 had this ambiguity; fixed here).

## 8. `test-only` tagging

Types defined in files classified as test-like (per `_engine/lib/test-paths.mjs::isTestLikePath`) are NOT excluded from observation — they appear in the registry with a `tags: ["test-only"]` annotation. The finalize step (promotion to canon) typically drops them; the raw observation retains them so reviewers can decide.

Every registry table in a canon draft has a `Tags` column. In v1 the only tag is `test-only`; future tags (`generated`, `public-api`) may follow when their fact types exist.

## 9. Invariants

- No classifier outputs a label outside this file's list.
- Order of evaluation is fixed; implementations that evaluate in a different order are wrong.
- The full type label set (§2 + §4): `zero-internal-fan-in` / `low-signal-type-name` / `DUPLICATE_STRONG` / `DUPLICATE_REVIEW` / `LOCAL_COMMON_NAME` / `single-owner-strong` / `single-owner-weak` / `severely-any-contaminated` / `ANY_COLLISION`. Adding a new one requires revising this file.
- The full helper label set (§10): `HELPER_DUPLICATE_STRONG` / `HELPER_DUPLICATE_REVIEW` / `HELPER_LOCAL_COMMON` / `ANY_COLLISION_HELPER` / `severely-any-contaminated-helper` / `central-helper` / `shared-helper` / `zero-internal-fan-in-helper` / `low-signal-helper-name`. Adding a new one requires revising this file.
- The full topology label set (§11): `cyclic-submodule` / `isolated-submodule` / `shared-submodule` / `leaf-submodule` / `scoped-submodule` / `forbidden-cycle` / `oversize` / `extreme-oversize`. Adding a new one requires revising this file.
- The full naming label set (§12): `camelCase-dominant` / `PascalCase-dominant` / `kebab-case-dominant` / `snake_case-dominant` / `UPPER_SNAKE-dominant` / `mixed-convention` / `insufficient-evidence` / `convention-match` / `convention-outlier` / `low-info-excluded`. Adding a new one requires revising this file.
- `any`-related labels (`severely-any-contaminated`, `ANY_COLLISION`, `severely-any-contaminated-helper`, `ANY_COLLISION_HELPER`) interact with classifications per `canonical/any-contamination.md`. Rule-0 precedence in §2, §4, §10.1, §10.2 must not be reordered.
- Rule 0 in §2 and §10.1 fires ONLY when every member has `any-contaminated` or `severely-any-contaminated`. `has-any`-only or `unknown-surface`-only groups are NOT `ANY_COLLISION` / `ANY_COLLISION_HELPER`. Widening Rule 0 to include mild tiers would collapse legitimate `unknown`-boundary duplicates into a false contamination verdict.
- Mixed duplicate groups (§2.1) must preserve `anyMembers` / `severeAnyMembers` / `semanticConfidence` in their output. Contamination must not disappear into the group. Parallel invariant applies to helper mixed groups per §10.1.
- Topology `cyclic-submodule` (§11.1 Rule 0) fires regardless of fan-in — a submodule with any file in an SCC is cyclic even at high inbound degree. Rule 0 precedence in §11.1 must not be reordered.

## 10. Helper classification

Parallel to §2 (type group) + §4 (single type identity), adapted for exported helpers (top-level functions / arrows / const-functions). Consumed by the P3-2 canon draft generator (`canonical-draft/helper-registry.md`).

**Identity for helpers** is `ownerFile::exportedName` — same shape as types, per `canonical/identity-and-alias.md` §2. `helperName` alone is NEVER an identity.

### 10.1 Helper group classification

A **group** is the set of helper identities sharing an `exportedName`. Fan-in per identity is **consumer-file-count**: `|distinctConsumerFiles|` — the number of distinct files that import the helper. A single consumer file calling the helper 10 times contributes 1 to fan-in, not 10. This differs from raw call-site count and is pinned by `maintainer history notes` v2 PF-4.

Evaluation order — **first match wins**:

| # | Condition | Label | Marker |
|---|---|---|---|
| 0 | `group.size ≥ 2` AND every identity in the group has `anyContamination.label ∈ {any-contaminated, severely-any-contaminated}` | `ANY_COLLISION_HELPER` | ⚠ (every-helper-contaminated; name collision only, shape comparison meaningless) |
| 1 | `group.size ≥ 2` AND `max(fanIn) ≥ 3` AND `sum(fanIn) ≥ 3` | `HELPER_DUPLICATE_STRONG` | ❌ (needs-resolution) |
| 2 | `group.size ≥ 2` AND `name ∈ LOW_INFO_HELPER_NAMES` (§10.4) AND `max(fanIn) < 3` | `HELPER_LOCAL_COMMON` | ⚠ (context-local; omit from canon) |
| 3 | `group.size ≥ 2` | `HELPER_DUPLICATE_REVIEW` | ⚠ (review-needed) |

Rule 0 fires ONLY for groups where every member carries `any-contaminated` or `severely-any-contaminated`. Groups where members carry only `has-any` (mild) or only `unknown-surface` do NOT trigger Rule 0 — they fall through to Rule 1/2/3 normally. Universal quantifier, not existential — same semantics as type §2 Rule 0.

Mixed helper groups (some contaminated + some clean) skip Rule 0 and fall through. The output preserves contamination visibility via `anyMembers` / `severeAnyMembers` / `semanticConfidence` / `tags` — identical structure to type §2.1.

### 10.2 Helper single-identity classification

For groups with `size == 1`. Evaluation order — **first match wins**:

| # | Condition | Label | Marker |
|---|---|---|---|
| 0 | identity carries `anyContamination.label == 'severely-any-contaminated'` | `severely-any-contaminated-helper` | ⚠ (omit from canon) |
| 1 | `name ∈ LOW_INFO_HELPER_NAMES` (§10.4) AND `fanIn < 3` | `low-signal-helper-name` | ⚠ (context-local) |
| 2 | `fanIn ≥ 3` | `central-helper` | ✅ (canon-candidate) |
| 3 | `fanIn ∈ {1, 2}` | `shared-helper` | ⚠ (weak-fan-in) |
| 4 | `fanIn == 0` | `zero-internal-fan-in-helper` | ⚠ (may-be-public-api or reflection-invoked) |

Rule 0 fires FIRST. A severely-contaminated helper is NEVER promoted to `central-helper` / `shared-helper` even at high fan-in — same logic as §4 Rule 0 for types.

Rule 1 (`low-signal-helper-name`) fires BEFORE Rule 2/3/4 ONLY when fanIn < 3. A helper named `get` with fan-in 3 is `central-helper` — Rule 2 wins over Rule 1 when fan-in crosses the centrality threshold. Parallel to the §2 `Result`+ high-fanIn → `DUPLICATE_STRONG` pattern.

### 10.3 Label set (drift-locked — mirrored in `_engine/lib/canon-draft.mjs`)

```
HELPER_DUPLICATE_STRONG
HELPER_DUPLICATE_REVIEW
HELPER_LOCAL_COMMON
ANY_COLLISION_HELPER
severely-any-contaminated-helper
central-helper
shared-helper
zero-internal-fan-in-helper
low-signal-helper-name
```

Any classifier output outside this set is a defect. `tests/test-classification-gates.mjs` pins the mirror constant in `_engine/lib/canon-draft.mjs` byte-equal to this enumeration.

### 10.4 LOW_INFO_HELPER_NAMES

Helper-specific list, distinct from type §3 `LOW_INFO_NAMES`. Rationale: `Props` / `Options` / `Result` are type-ish low-info names; `get` / `parse` / `format` are helper-ish low-info names. Mixing them in one list would force the drift-test to carry false positives in each direction.

```
get, set, parse, format, fetch, load, save, build, make,
create, update, handle, run, process, convert
```

Kept small for v1 (15 names). Grow empirically as P3-2 runs on real corpora expose false positives in either direction. Per-repo override config is on the roadmap but lives in this canonical file's evolution, not the spec.

### 10.5 Critical notes

**`zero-internal-fan-in-helper` is NOT "dead code".** Parallel to §5.1 — the scan observes internal consumers only. External package consumers, reflection invocation (`obj[methodName]()`), and dynamic imports are invisible to the import-resolve lens. Cross-check with `dead-classify.json` public-API filters before suggesting removal. Wording must be `zero-internal-fan-in-helper`, never "unused" or "dead".

**`low-signal-helper-name` is NOT "rename this".** A helper named `parse` with low fan-in is a **canon-omission** candidate, not a rename candidate. The helper may exist for readability within a submodule, or as a local convenience. Canon drafts skip it; source code is untouched.

**`HELPER_DUPLICATE_STRONG` is NOT a merge command.** Resolution options (rename / merge / adopt-one) are the same as §5.3 for types. The skill flags; humans / LLMs decide.

### 10.6 Fan-in semantics

`fanIn = |distinctConsumerFiles|`. Computed by a fresh AST pass that walks the scan range, resolves each import via `canonical/identity-and-alias.md §6`, and adds each consumer file to a per-identity Set. Distinct-file counting — duplicates within the same consumer file are collapsed.

This differs from `call-graph.json.topCallees.count`, which aggregates call-site count (10 calls from one consumer → count 10). P3-2 does NOT use `topCallees.count` as fan-in. `call-graph.json` is cross-check only.

Callback-passed helpers (`arr.map(tryParse)`) ARE captured by import-resolve fan-in because the helper is imported even though never directly invoked. This is a win over the direct-call lens of `build-call-graph.mjs`.

### 10.7 Out of scope for §10

- Class methods. Helper classification covers top-level exported functions / arrows / const-functions only. Class methods (static or instance) are not "helpers" in the canon sense and are NOT classified here.
- Non-exported (module-local) helpers. Same scope rule as type classification — exported-only.
- Runtime call-frequency analysis. Static-only via AST import resolution.

## 11. Topology classification

Parallel to §2/§4 (types) and §10 (helpers), adapted for topology. Unlike types/helpers, topology operates at the SUBMODULE level. Consumed by the P3-3 canon draft generator (`canonical-draft/topology.md`).

**Identity for topology** is the **submodule path** (e.g., `_lib`, `apps/web`, `packages/protocol`) — NOT `ownerFile::exportedName`. This is intentional; topology canon operates at the structural granularity, not the symbol granularity. File-level identities (`ownerFile`) appear inside SCC member lists and the oversize-files table but are NOT the primary identity for §11.1 classification.

### 11.1 Submodule classification

Evaluation order — **first match wins**:

| # | Condition | Label | Marker |
|---|---|---|---|
| 0 | submodule has any file in `topology.json.sccs[].members` | `cyclic-submodule` | ❌ (canon invariant violation) |
| 1 | `inDegree == 0` AND `outDegree == 0` AND `crossEdgeSource == "full-list"` | `isolated-submodule` | ℹ (may be dead-weight or entry-points) |
| 2 | `inDegree >= 5` | `shared-submodule` | ✅ (canon-worthy hub) |
| 3 | `outDegree > inDegree` AND `inDegree < 5` | `leaf-submodule` | ⚠ (one-way consumer) |
| 4 | else | `scoped-submodule` | ℹ |

Rule 0 fires FIRST. A cyclic submodule is a canon violation regardless of centrality — label it cyclic even at high fan-in. Cycles are the primary flag; hubs / leaves are secondary structural observations.

Rule 1 (`isolated-submodule`) requires `crossEdgeSource == "full-list"` — i.e., the consumer read from `topology.json.crossSubmoduleEdges` (full list), not `crossSubmoduleTop` (top-30 display). This is the degraded-mode guard: a zero in/out reading from top-30-only evidence is NOT strong enough to claim isolation. In top-30-only mode, the condition falls through to Rule 4 (`scoped-submodule`) — the conservative default.

Thresholds (`5` for Rule 2) are v1 empirical. Per-repo override lives in this canonical file's evolution.

`inDegree` / `outDegree` are CROSS-SUBMODULE edge counts — internal-to-submodule edges don't count. Derived from `topology.json.crossSubmoduleEdges[]` (full list, required for high-confidence classification).

### 11.2 SCC classification

Every SCC returned by `topology.json.sccs[]` is labeled `forbidden-cycle`. v1 has no sub-tiering (cycle-of-2 vs cycle-of-10 are equally forbidden). Future extensions may add `critical-cycle` / `tolerable-cycle` — out of v1.

| # | Condition | Label | Marker |
|---|---|---|---|
| 0 | any SCC | `forbidden-cycle` | ❌ |

### 11.3 Oversize file classification

File-level observation (NOT submodule-level). A file's LOC count, not its submodule, determines the label.

| # | Condition | Label | Marker |
|---|---|---|---|
| 0 | `loc >= 1000` | `extreme-oversize` | ❌ |
| 1 | `loc >= 400` | `oversize` | ⚠ |

Files below 400 LOC are not classified (no label). Thresholds match `topology.json.summary.bigFiles` (≥400) and `oneThousandPlusFiles` (≥1000) already defined in the producer.

### 11.4 Label set (drift-locked — mirrored in `_engine/lib/canon-draft.mjs`)

```
cyclic-submodule
isolated-submodule
shared-submodule
leaf-submodule
scoped-submodule
forbidden-cycle
oversize
extreme-oversize
```

**8 labels total.** `tests/test-classification-gates.mjs` Step 0 extension pins both the mirror constant and the emitted set.

### 11.5 Critical notes

**`isolated-submodule` is NOT "dead".** A submodule with zero cross-submodule in-edges and zero out-edges may be an entry point (e.g., `bin/`, `tests/`), a config-only directory (`configs/`), or a genuinely orphaned area. Cross-check with `triage.json.shape.testFiles` and `boundaries` before suggesting removal. Wording must be `isolated-submodule`, never "dead" or "unused".

**`forbidden-cycle` is a canon-invariant violation, not a code-removal command.** Resolution options mirror §5.3 for types: rename one module, merge two modules, or introduce an abstraction to break the cycle. The skill flags; humans / LLMs decide.

**`oversize` is NOT "split this".** A 500-LOC test file that exists because the suite is exhaustive is legitimate; a 500-LOC production file that grew by accretion is a refactor signal. Canon draft surfaces the observation; reviewer classifies.

### 11.6 Identity semantics

Submodule identity is a path string. No `ownerFile::exportedName` format. No alias resolution (submodule paths don't alias the way type/helper names do). No LOW_INFO_* list (path-based, not name-based).

SCC member identities ARE file paths (used in the §3 cycle listing). These files belong to a submodule whose classification is `cyclic-submodule`; the per-file identity is report-level, not classification-level.

### 11.7 Fan-in evidence source (honest-degradation per maintainer history notes v3 PF-6)

Classification in §11.1 uses `inDegree` / `outDegree` computed from `topology.json.crossSubmoduleEdges` (the full untruncated cross-submodule edge list, producer field landed in P3-3-pre). This is the only honest source for "zero in/out" claims (Rule 1 `isolated-submodule`).

Consumers reading a pre-P3-3-pre `topology.json` that lacks `crossSubmoduleEdges` degrade to `crossSubmoduleTop` (top 30). In that mode:
- The draft meta records `crossEdgeSource: "top-30-only"` + `classificationConfidence: "medium"`.
- The draft renders a prominent degradation header.
- Rule 1 (`isolated-submodule`) is STRUCTURALLY suppressed (§11.1 guard).
- Rules 0 (SCC), 2 (`shared-submodule`), 3 (`leaf-submodule`), 4 (`scoped-submodule`) still fire but with medium confidence.

Classification confidence is part of the draft's honest record — the reviewer / LLM consuming the draft knows what the labels are riding on.

### 11.8 Out of scope for §11

- Edge-level classification. Cross-submodule edges are REPORTED (§2 of the draft) but not individually classified.
- Boundary-rule enforcement — `canonical/fact-model.md §3.5` declares rules; checking observed edges against rules is Post-P3 (`check-canon.mjs`).
- Workspace-level classification. Monorepo workspaces are LISTED (§5 of the draft) but not individually classified in v1.
- Per-file SCC labeling. Files inside SCCs inherit `cyclic-submodule` at the submodule level; there is no per-file cycle label in v1.

## 12. Naming classification

Parallel to §2/§4 (types), §10 (helpers), §11 (topology), adapted for naming conventions. Consumed by the P3-4 canon draft generator (`canonical-draft/naming.md`).

**Identity for naming** is **cohort-keyed** — NOT `ownerFile::exportedName` (per-item) and NOT submodule path (that's topology).
- **File-naming cohort identity**: `<submodule>` (e.g., `_lib`).
- **Symbol-naming cohort identity**: `<submodule>::<kind>` where `kind ∈ {type-export, helper-export, constant-export}`.

Per-item identities (`<ownerFile>` for file items, `<ownerFile>::<exportedName>` for symbol items) appear inside §3 outlier listings but are NOT primary for §12.1 classification — see §12.8.

### 12.1 Cohort classification

A **cohort** is a set of items (files or exported symbols) sharing a submodule (+ kind). Cohort membership computation uses EFFECTIVE size — raw members minus low-info names (`LOW_INFO_NAMES` §3 + `LOW_INFO_HELPER_NAMES` §10.4).

Evaluation — **compute dominance on effective members, then match**:

1. For each raw member, compute the observed convention:
   - **File cohort member**: apply basename normalization first (see §12.6), then `detectConvention(normalizedBasename)`.
   - **Symbol cohort member**: `detectConvention(exportedName)` directly.
2. Strip low-info names from dominance computation. `effectiveMembers = members.filter(m => !lowInfoExclusions.has(m.name))`.
3. If `effectiveMembers.length < 3` → `insufficient-evidence` (outlier detection suppressed).
4. Else: `dominance = max(count per convention) / effectiveMembers.length`.
5. If `dominance >= 0.6` (60% majority threshold) → `<convention>-dominant`.
6. Else → `mixed-convention`.

| # | Condition | Label | Marker |
|---|---|---|---|
| 0 | `effectiveMembers.length < 3` | `insufficient-evidence` | ℹ |
| 1 | dominance ≥ 0.6 AND convention = camelCase | `camelCase-dominant` | ✅ |
| 1 | dominance ≥ 0.6 AND convention = PascalCase | `PascalCase-dominant` | ✅ |
| 1 | dominance ≥ 0.6 AND convention = kebab-case | `kebab-case-dominant` | ✅ |
| 1 | dominance ≥ 0.6 AND convention = snake_case | `snake_case-dominant` | ✅ |
| 1 | dominance ≥ 0.6 AND convention = UPPER_SNAKE | `UPPER_SNAKE-dominant` | ✅ |
| 2 | dominance < 0.6 | `mixed-convention` | ⚠ |

### 12.2 Per-item classification

For each item in a cohort, apply rules in order — **first match wins**. `low-info-excluded` has item-level priority:

| # | Condition | Label | Marker |
|---|---|---|---|
| 0 | name ∈ LOW_INFO_NAMES ∪ LOW_INFO_HELPER_NAMES | `low-info-excluded` | ℹ |
| 1 | cohort is `insufficient-evidence` OR `mixed-convention` | `convention-match` | ✅ (no dominant to deviate from) |
| 2 | item convention === cohort dominant convention | `convention-match` | ✅ |
| 3 | item convention ≠ cohort dominant convention | `convention-outlier` | ⚠ |

Rule 0 fires FIRST regardless of cohort state. A low-info member of a `mixed-convention` cohort is STILL `low-info-excluded` — the item's own characterization is "this name shouldn't count" independently of cohort classification.

### 12.3 Label set (drift-locked — mirrored in `_engine/lib/canon-draft.mjs`)

```
camelCase-dominant
PascalCase-dominant
kebab-case-dominant
snake_case-dominant
UPPER_SNAKE-dominant
mixed-convention
insufficient-evidence
convention-match
convention-outlier
low-info-excluded
```

**10 labels total** (7 cohort + 3 per-item). `tests/test-classification-gates.mjs` Step 0 extension pins both mirror and emitted set.

### 12.4 Critical notes

**`mixed-convention` is NOT "inconsistent".** A mixed cohort may reflect a deliberate split — observation, not verdict.

**`convention-outlier` is NOT "rename this".** Outliers may be intentional (legacy compat, external API mirroring). Canon drafts surface observations; reviewer decides.

**`insufficient-evidence` is the honest-small-cohort label.** A single-file submodule cannot sustain a convention claim. Not a defect.

**`low-info-excluded` is semantic design, not an oversight.** `get` / `parse` / `Result` carry convention meaning poorly because they're universal.

### 12.5 Conventions enum (NAMING_CONVENTIONS constant)

Mirrored in `_engine/lib/canon-draft.mjs`. Used by `detectConvention(name)` return values.

```
camelCase       — starts lowercase, later segments capitalize: fooBar, getUser
PascalCase      — starts uppercase: FooBar, User
kebab-case      — hyphen-separated lowercase: foo-bar, user-service
snake_case      — underscore-separated lowercase: foo_bar, user_service
UPPER_SNAKE     — underscore-separated uppercase: FOO_BAR, MAX_RETRY
mixed           — doesn't match any single pattern above (e.g., `foo_Bar`, `Foo-bar`)
```

### 12.6 File basename normalization

File cohort members are file-basenames, not full paths. Before `detectConvention(name)` runs on a file cohort member, the name MUST be normalized:

1. Strip the final language extension: `.mjs` / `.ts` / `.tsx` / `.js` / `.jsx` / `.cjs` / `.mts` / `.cts` / `.d.ts`.
2. Strip common multi-part suffixes that appear BEFORE the final extension: `.test` / `.spec` / `.stories` / `.d`.

Reference examples:

| File path | Normalized basename | detectConvention result |
|-----------|---------------------|-------------------------|
| `_engine/lib/canon-draft.mjs` | `canon-draft` | `kebab-case` |
| `src/components/UserCard.tsx` | `UserCard` | `PascalCase` |
| `tests/user-profile.test.tsx` | `user-profile` | `kebab-case` |
| `src/api.d.ts` | `api` | `camelCase` |
| `src/legacy_module.js` | `legacy_module` | `snake_case` |

Normalization applies to basename only — the submodule path (cohort identity) is never normalized.

### 12.7 Dominance threshold

60% majority threshold is v1 empirical. Per-repo override lives in this canonical file's evolution.

### 12.8 Per-item identity shape

The §3 Outliers table surfaces per-item rows. The Identity column uses a structurally distinct shape depending on whether the item is a file or a symbol, so a reader can tell at a glance which cohort kind the row belongs to:

| Cohort kind | Per-item identity shape | Example |
|-------------|------------------------|---------|
| File cohort | `<ownerFile>` | `_engine/lib/legacy_helper.mjs` |
| Symbol cohort | `<ownerFile>::<exportedName>` | `_engine/lib/oldStyle.mjs::OLD_API` |

The cohort identity (the §1/§2 key) is always `<submodule>` or `<submodule>::<kind>`. Item identities are never used for §12.1 dominance computation.

### 12.9 Out of scope for §12

- Variable naming inside function bodies (scope = exported identifiers + file basenames).
- JSX component naming sub-cohort (v1 treats .tsx exports as ordinary helpers/types).
- Cross-workspace / cross-repo federation.
- File-renaming prescription (observation only).
- Auto-promotion from draft to canon.
