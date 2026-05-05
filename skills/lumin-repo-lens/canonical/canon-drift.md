# canonical/canon-drift.md

> **Scope:** formal drift semantics for the `check-canon.mjs` drift detector — category enum, family tag set, identity contract, parser contract, and JSON artifact shape.
> **Position in spine:** subordinate to `canonical/classification-gates.md` §9/§10.3/§11.4/§12.3 (label sets this parser accepts) and `canonical/identity-and-alias.md` §2 (identity format for type/helper drift). Cross-referenced from `canonical/fact-model.md` §7.

---

## 1. Purpose

Canon drift is step 4 of the stickiness loop: after P3 emits fresh canon drafts and a human/LLM promotes selected drafts to `canonical/*.md`, subsequent audits must answer "does the promoted canon still match the code?". The drift detector **reports** that question; it NEVER writes to `canonical/`. Re-promotion stays human-driven.

## 2. Drift fact kinds

Four drift kinds, one per P3 canon source. Each consumes a promoted `canonical/*.md` file and a fresh in-memory re-run of the same collector that P3 used. `check-canon.mjs` NEVER reads prior `canonical-draft/*.md` output — drafts are auxiliary artifacts, not cached facts.

- `` `type-drift` `` — consumes `canonical/type-ownership.md` + fresh `collectTypeIdentities` (P3-1 producer path).
- `` `helper-drift` `` — consumes `canonical/helper-registry.md` + fresh `collectHelperIdentities` (P3-2).
- `` `topology-drift` `` — consumes `canonical/topology.md` + fresh `collectTopologyStructure` (P3-3, backed by `measure-topology.mjs`).
- `` `naming-drift` `` — consumes `canonical/naming.md` + fresh `collectNamingCohorts` (P3-4).

A drift fact never crosses kinds — `type-drift` cannot claim anything about helpers, topology, or naming. Cross-source correlation is a P5-v2+ concern (non-goal for v1, see §7).

## 3. Drift categories + family tags

Drift records carry three classifying fields: `kind` (one of 4, see §2), `category` (one of 19 source-specific enums below), and `family` (one of 5 generic tags). Category is canonical per kind; family is a cross-kind grouping for aggregation and filtering.

### 3.1 Category enum (source-specific)

```
type-drift:
  identity-added    (family: added)
  identity-removed  (family: removed)
  label-changed     (family: label-changed)
  owner-changed     (family: structural-status-changed)

helper-drift:
  helper-added           (family: added)
  helper-removed         (family: removed)
  label-changed          (family: label-changed)
  contamination-changed  (family: content-shifted)
  fan-in-tier-changed    (family: label-changed)

topology-drift:
  submodule-added     (family: added)
  submodule-removed   (family: removed)
  scc-status-changed  (family: structural-status-changed)
  oversize-changed    (family: content-shifted)
  cross-edge-added    (family: added)
  cross-edge-removed  (family: removed)

naming-drift:
  cohort-added               (family: added)
  cohort-removed             (family: removed)
  cohort-convention-shifted  (family: label-changed)
  new-outlier-introduced     (family: content-shifted)
  outlier-resolved           (family: content-shifted)
```

Total: 4 + 5 + 6 + 5 = 20 categories. Mirrored in `tests/test-classification-gates.mjs` DC-10..DC-13.

### 3.2 Family tag enum

```
added
removed
label-changed
structural-status-changed
content-shifted
```

Exactly 5 values. Every category in §3.1 maps to exactly one family in v1. v2+ may permit array-valued `family` when a category straddles two tags; v1 pins 1:1.

Family semantics:

- **`added`** — canon did not contain this identity/edge/cohort; fresh run does.
- **`removed`** — canon contained it; fresh run does not.
- **`label-changed`** — identity persists; classification-gates label differs.
- **`structural-status-changed`** — identity persists but its ownership or structural role changed (owner moved files, SCC membership flipped, etc.).
- **`content-shifted`** — identity persists and label persists, but a finer-grained metric moved beyond threshold (contamination ratio crossed tier boundary, oversize file crossed extreme cutoff, new outlier appeared in cohort, etc.).

### 3.3 Additive extension policy

The category enum is closed under minor versions. Adding a new category requires:
1. New row in §3.1 with an explicit family mapping.
2. Mirror update in `tests/test-classification-gates.mjs` (DC-10 count + DC-11 per-kind list + DC-13 mapping).
3. Version bump `canon-drift.md` v1 → v1.1 (minor) for purely additive change; v2 if a category is removed or renamed.

## 4. Identity contract

Every drift record carries an `identity` field that keys the fact. The format depends on kind and category:

- **`type-drift` (all categories)** — `ownerFile::exportedName` per `canonical/identity-and-alias.md` §2. Matches P3-1 `renderTypeOwnership` row identity.
- **`helper-drift` (all categories)** — `ownerFile::exportedName` per identity-and-alias §2. Matches P3-2 `renderHelperRegistry` row identity.
- **`topology-drift` submodule-level** (`submodule-added` / `submodule-removed` / `scc-status-changed`) — the submodule path string as emitted by P3-3 (`renderTopology` §1 first column).
- **`topology-drift` cross-edge** (`cross-edge-added` / `cross-edge-removed`) — `<from-submodule> → <to-submodule>` edge label (use a literal ` → ` separator with single spaces).
- **`topology-drift` oversize-changed** — the `ownerFile` path (per `renderTopology` §4 first column).
- **`naming-drift` cohort-level** (`cohort-added` / `cohort-removed` / `cohort-convention-shifted`) — `<submodule>` for file cohorts OR `<submodule>::<kind>` for symbol cohorts, `kind ∈ {type-export, helper-export, constant-export}` per P3-4 `renderNaming` §1/§2 identity column.
- **`naming-drift` outlier** (`new-outlier-introduced` / `outlier-resolved`) — per-item identity: `ownerFile` for file-item outliers, `ownerFile::exportedName` for symbol-item outliers (matches `renderNaming` §3 `Identity` column).

Identity strings are compared byte-for-byte. Whitespace, casing, and Unicode form differences count as separate identities (no normalization).

## 5. Parser contract

The check-canon parser operates in strict mode. It recognizes exactly the four per-source table shapes below, defined by their required column header lists, plus the explicitly documented legacy compatibility variant for `type-ownership.md` in §5.a. Any undocumented deviation (missing column, extra column, renamed column) is a **fatal per-source error**.

Label-column values are validated against the canonical sets in `canonical/classification-gates.md` — §9 (type + helper labels), §11.4 (topology labels), §12.3 (naming labels). Any Status token outside the canonical set for that source is a `canon-parse-error` diagnostic.

### 5.a `type-ownership.md` — from `_engine/lib/canon-draft-types.mjs::renderTypeOwnership`

Current required columns (ordered): `Name` | `Identity` | `Owner` | `Fan-in` | `Fan-in space` | `Status` | `Tags`.

Legacy read-compatible columns (ordered): `Name` | `Identity` | `Owner` | `Fan-in` | `Status` | `Tags`.

- **Identity cell** — strip backticks; expect `ownerFile::exportedName` (see §4 + `canonical/identity-and-alias.md` §2).
- **Status cell** — first whitespace-separated token ∈ canonical §9 type label set.
- **Fan-in cell** — integer count or a canonical placeholder (see P3-1 emit rules); non-strict field for parser purposes.
- **Fan-in space cell** — display-only breakdown of value/type/broad fan-in evidence. The drift parser accepts and ignores this cell for v1.2 semantics; total `Fan-in`, `Identity`, `Owner`, and `Status` remain the drift inputs.

### 5.b `helper-registry.md` — from `renderHelperRegistry`

Required columns (ordered): `Name` | `Identity` | `Owner` | `Signature` | `Fan-in` | `Status` | `Tags` | `Any / unknown signal`.

- **Status cell** — first token ∈ canonical §10.3 helper label set.
- **Any / unknown signal cell** — contamination signal token(s); parser validates presence of the column but does not enforce a closed enum on this cell in v1 (P3-2 emit rules evolve).

### 5.c `topology.md` — from `renderTopology` (multi-section)

- **§1 Submodule inventory** — columns `Submodule` | `Files` | `LOC` | `In-edges` | `Out-edges` | `SCC` | `Status` | `Tags`. Status ∈ canonical §11.4 topology label set (subset applicable to submodule-level rows per §11.1). **Authoritative source for submodule-level `sccMember` boolean via the `SCC` column** (non-empty marker = SCC member; the same-submodule `Status` label — e.g. `cyclic-submodule` — is a classification consequence of that boolean, not an independent signal). The `SCC` column and §3 cycle listing MUST agree: if they disagree the parser emits `canon-parse-error` per the §5.e strictness policy (added v1.1).
- **§2 Cross-submodule edges (display — top-30 by count descending)** (present when cross-edges exist; absent when the graph is cross-edge-free) — columns `From` | `To` | `Count`. Identity for `cross-edge-added` / `cross-edge-removed` drift records is the literal `<From> → <To>` edge label (matching §4 identity contract, single spaces around the ` → `). `From` and `To` hold submodule path strings; `Count` is a non-negative integer. **Display-scope semantics:** this table is a top-30 snapshot by edge count (descending). Drift detection compares canon's §2 rows against fresh top-30 from `topology.json.crossSubmoduleTop` (or top-30 of `crossSubmoduleEdges` sorted by count descending when `crossSubmoduleTop` is absent). Edges outside the top-30 window on either side can drift without being surfaced; absolute-graph cross-edge detection is a future (v2+) canonical extension and is not claimed by v1.1.
- **§3 Cycle listing** (present when cycles exist) — header pattern `### Cycle <N> (size <M>) — forbidden-cycle ❌` followed by a bulleted member list. Parser extracts cycle size + member submodules. The set of submodules appearing in §3 cycle member lists MUST equal exactly the set of submodules whose §1 `SCC` column is marked — neither direction may contain the other strictly. Any disagreement → `canon-parse-error` (same v1.1 pin as §1).
- **§4 Oversize files** (present when any oversize) — columns `File` | `LOC` | `Status`. Status ∈ `{oversize, extreme-oversize}` per §11.3.
- **§5 Workspace boundaries** (monorepo only — may be absent) — columns `Package` | `Path` | `Files` | `LOC`. v1 treats boundaries as informational; no drift categories reference them.

### 5.d `naming.md` — from `renderNaming` (multi-section)

- **§1 File cohorts** — columns `Cohort (submodule)` | `Files` | `DominantConvention` | `ConsistencyRate` | `OutliersCount` | `Status`. Status ∈ canonical §12.3 naming label set.
- **§2 Symbol cohorts** — columns `Cohort (submodule::kind)` | `Items` | `DominantConvention` | `ConsistencyRate` | `OutliersCount` | `Status`. Same Status domain as §1.
- **§3 Outliers** (optional — omitted when zero) — columns `Identity` | `Cohort` | `Name` | `ObservedConvention` | `DominantConvention` | `Status`.

### 5.e Strictness policy

- **Unknown / missing / renamed column in a recognized schema** → source-level `canon-parse-error` with `perSource[source].status = "parse-error"`. Drift detection for that source is aborted; no partial rows are emitted.
- **Unrecognized first-row shape** (header row does not match any §5.a–§5.d contract) → source-level skip with `perSource[source].status = "skipped-unrecognized-schema"`. The source is neither clean nor drifted; the diagnostic records which header was seen.
- **Missing canonical file** (e.g. no `canonical/topology.md` yet) → source-level skip with `perSource[source].status = "skipped-missing-canon"`. Not an error.
- **Unknown Status token in a recognized schema** → `canon-parse-error` diagnostic per-row; whole source is flagged `parse-error`.
- **Lenient partial parse is explicitly forbidden.** A detector that reads half the rows and reports "no drift" is the worst failure mode for this phase.

## 6. JSON artifact shape

`<output>/canon-drift.json` — minimal schema. P5-1+ producers MUST emit this shape. Additive field additions are allowed within v1.x; removals and renames require a canonical edit (v2).

```json
{
  "meta": {
    "tool": "check-canon.mjs",
    "generated": "ISO-8601",
    "root": "/abs/path",
    "canonDir": "/abs/path/canonical",
    "scope": "TS/JS production files | including tests",
    "strict": false
  },
  "summary": {
    "sourcesRequested": 4,
    "sourcesChecked": 2,
    "sourcesSkipped": 2,
    "driftCount": 3
  },
  "perSource": {
    "type-ownership": {
      "status": "drift",
      "driftCount": 2,
      "reportPath": "<output>/canon-drift.type-ownership.md",
      "diagnostics": []
    },
    "helper-registry": {
      "status": "clean",
      "driftCount": 0,
      "reportPath": "<output>/canon-drift.helper-registry.md",
      "diagnostics": []
    },
    "topology": {
      "status": "skipped-missing-canon",
      "driftCount": 0,
      "diagnostics": [{ "reason": "canonical/topology.md absent" }]
    },
    "naming": {
      "status": "skipped-unrecognized-schema",
      "driftCount": 0,
      "diagnostics": [{ "reason": "first-row header not in parser contract" }]
    }
  },
  "drifts": [
    {
      "kind": "type-drift",
      "category": "owner-changed",
      "family": "structural-status-changed",
      "identity": "src/foo.ts::User",
      "canon": {
        "file": "canonical/type-ownership.md",
        "line": 42,
        "label": "single-owner-strong",
        "owner": "src/foo.ts:14"
      },
      "fresh": {
        "label": "single-owner-strong",
        "owner": "src/types/user.ts:8"
      },
      "confidence": "high"
    }
  ]
}
```

### 6.1 `perSource[source].status` domain

Exactly five values: `` `drift` `` | `` `clean` `` | `` `skipped-missing-canon` `` | `` `skipped-unrecognized-schema` `` | `` `parse-error` ``. A producer MUST NOT emit any other status; a consumer MUST treat an unrecognized status as a fatal schema error.

### 6.2 Per-source Markdown reports

Each checked source also emits a Markdown report at `<output>/canon-drift.<source>.md` — human-readable rendering of the same drift records. Rendering format is producer-specific in v1 (P5-1 locks the shape per-source); the JSON is the machine contract.

## 7. Non-goals

- **No auto-promotion** from draft to canon. Canon promotion stays human-driven.
- **No LLM or fuzzy rename inference.** Type-owner move detection is limited to deterministic evidence: same-name 1:1 add/remove pairs, plus same-name ambiguous groups only when a validated `shape-index.json` yields exactly one added identity and one removed identity for the same shape hash. Remaining ambiguous add/remove records stay manual review.
- **No cross-source drift correlation.** `type-drift` cannot imply `topology-drift`; each kind is independent.
- **No historical git-history drift.** The detector compares the CURRENT working tree against the CURRENT canonical files.
- **No drift severity tiering beyond binary detection.** v1 reports drift/clean; ranking waits for v2+.
- **No editing of `canonical/*.md` files.** The detector is a reporter.
- **No writing to `canonical-draft/*.md`.** That is P3's responsibility. `check-canon` re-runs collectors in-memory.
- **No per-workspace canon in monorepos.** Skill-level canon only in v1 (workspace-scoped canon is Phase 6+).
