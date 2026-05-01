# canonical/fact-model.md

> **Role:** the fact types this skill produces and consumes. Every script emits typed facts; every mode consumes typed facts. This file is the schema.
> **Owner:** this file.

---

## 1. Purpose

Modes and phases must not re-invent what a fact looks like. If P1 pre-write and P3 canon-draft both care about "who owns this type", they read the same `type-owner` fact shape. Shape drift between producers breaks the whole system; this file encodes the shared contract that prevents that drift.

## 2. Required metadata (every fact)

Every fact carries these four fields:

| Field | Type | Why |
|---|---|---|
| `source` | string | which script/artifact emitted the fact (`build-symbol-graph.mjs`, `call-graph.json`, `fresh-ast-pass`) |
| `scope` | string | what was scanned (`TS/JS production files`, `TS/JS including tests`, `workspace `packages/foo`` etc.) |
| `confidence` | `'high' \| 'medium' \| 'low'` | downgraded by resolver blindness, parse errors, staleness — see §4 |
| `observedAt` | ISO timestamp | staleness bookkeeping |

If a producer cannot fill all four, it emits the fact with `confidence: 'low'` and an explicit `missingFields: [...]` note. Never omit silently.

## 3. Fact types

### 3.1 `type-owner`

Identity of a type declaration and its owner file. Carries an optional `anyContamination` annotation (see `canonical/any-contamination.md` §3) when the declaration is `any`-heavy. Omitted when clean only if the producer advertises `meta.supports.anyContamination === true`; when support is false, omission means unmeasured.

```json
{
  "kind": "type-owner",
  "identity": "src/protocol/ids.ts::SessionId",
  "exportedName": "SessionId",
  "typeName": "SessionId",
  "ownerFile": "src/protocol/ids.ts",
  "typeKind": "TSTypeAliasDeclaration",
  "line": 14,
  "fanIn": 8,
  "reExportedThrough": ["src/index.ts"],
  "anyContamination": {
    "label": "any-contaminated",
    "labels": ["has-any", "any-contaminated"],
    "measurements": {
      "totalFields": 3,
      "anyFields": 2,
      "unknownFields": 0,
      "anyFieldRatio": 0.67,
      "indexSignatureAny": false
    }
  },
  "source": "fresh-ast-pass",
  "scope": "TS/JS production files",
  "confidence": "high",
  "observedAt": "2026-04-20T10:00:00Z"
}
```

See `canonical/identity-and-alias.md` §2 for why identity is `ownerFile::exportedName`, not `exportedName` alone. **`exportedName` is the canonical identity field** — it is the name under which this declaration is exported from `ownerFile`, and it is what identity matching keys on. `typeName` is the display alias shown to humans; on `type-owner` facts (which describe the OWNER side of a declaration) `typeName` and `exportedName` are always equal. Consumers that do identity matching MUST read `exportedName`. See `canonical/any-contamination.md` §3.1 + §4 for the `anyContamination` schema (`label` is highest-severity tier; `labels` is full applicable set; `measurements` carries raw counts so consumers can show scale, not just label).

### 3.2 `helper-owner`

Identity of an exported function/value and its owner. Also carries optional `anyContamination` annotation — for helpers it measures param types, return type, and body-level `as any` assertions (see `canonical/any-contamination.md` §2.2). As with type owners, absence is clean only when the producer capability is true.

```json
{
  "kind": "helper-owner",
  "identity": "src/utils/json.ts::tryParseJson",
  "exportedName": "tryParseJson",
  "ownerFile": "src/utils/json.ts",
  "signature": "(raw: string) => unknown | undefined",
  "fanIn": 12,
  "reExportedThrough": [],
  "anyContamination": {
    "label": "severely-any-contaminated",
    "labels": ["has-any", "any-contaminated", "severely-any-contaminated"],
    "measurements": {
      "totalParams": 2,
      "anyParams": 1,
      "unknownParams": 0,
      "returnIsAny": false,
      "asAnyCount": 3,
      "launderCount": 0
    }
  },
  "source": "fresh-ast-pass + call-graph",
  "scope": "TS/JS production files",
  "confidence": "high",
  "observedAt": "..."
}
```

### 3.3 `shape-hash`

Structural signature of a type — used by P2 post-write and P4 shape-duplication to detect "same fields, different name".

```json
{
  "kind": "shape-hash",
  "hash": "sha256:ab12...",
  "identities": [
    "src/views/User.ts::UserProfile",
    "src/admin/User.ts::UserInfo"
  ],
  "fields": [
    { "name": "id", "type": "string" },
    { "name": "email", "type": "string" }
  ],
  "source": "fresh-ast-pass",
  "scope": "TS/JS production files, exported types only",
  "confidence": "medium",
  "observedAt": "..."
}
```

Field-order is normalized before hashing so `{a, b}` and `{b, a}` match.

### 3.4 `topology-edge`

Directed import/call edge with submodule context.

```json
{
  "kind": "topology-edge",
  "from": "apps/web/routes/user.ts",
  "to": "packages/protocol/ids.ts",
  "fromSubmodule": "apps/web",
  "toSubmodule": "packages/protocol",
  "edgeType": "import",
  "typeOnly": false,
  "source": "measure-topology.mjs",
  "scope": "...",
  "confidence": "high",
  "observedAt": "..."
}
```

### 3.5 `boundary-rule`

Declared rule about allowed/forbidden edge directions.

```json
{
  "kind": "boundary-rule",
  "from": "apps/*",
  "to": "_engine/lib/*",
  "direction": "allowed",
  "declaredIn": "eslint.config.mjs",
  "source": "triage-repo.mjs",
  "scope": "...",
  "confidence": "high",
  "observedAt": "..."
}
```

### 3.6 `watchpoint`

A fact intentionally retained even when no violation is present — "watch this area because last session it was trending".

```json
{
  "kind": "watchpoint",
  "target": "_engine/lib/resolver-core.mjs::makeResolver",
  "reason": "204 LOC single function; previous session discussed splitting",
  "severity": "watch",
  "source": "checklist-facts.json.A2_function_size + session-log",
  "scope": "...",
  "confidence": "medium",
  "observedAt": "..."
}
```

### 3.7 `blind-zone`

An explicit acknowledgment of what was NOT scannable. Feeds `[확인 불가]` labels.

```json
{
  "kind": "blind-zone",
  "area": "Python method resolution",
  "severity": "precision-gap",
  "effect": "method-level dead claims are degraded",
  "source": "blind-zones.mjs",
  "scope": "repo-wide",
  "confidence": "high",
  "observedAt": "..."
}
```

### 3.8 `resolver-confidence`

Global signal downgrading every identity fact in a given scope.

```json
{
  "kind": "resolver-confidence",
  "unresolvedInternalRatio": 0.22,
  "topUnresolvedPrefixes": ["@/", "~/"],
  "gate": "tripped",
  "effect": "identity fan-in claims below threshold should be demoted",
  "source": "symbols.json.uses",
  "scope": "...",
  "confidence": "high",
  "observedAt": "..."
}
```

### 3.9 `type-escape`

Occurrence-level fact: a single type-system escape hatch at a specific file + line. Complements the per-identity `anyContamination` annotation on `type-owner` / `helper-owner` — annotation says "this identity looks contaminated", `type-escape` says "this escape occurred at this exact location". Both are needed: post-write delta detection operates on escape occurrences (including escapes in local / non-exported positions), while contamination annotations answer "is this identity safe to reuse".

```json
{
  "kind": "type-escape",
  "file": "src/api/client.ts",
  "line": 42,
  "escapeKind": "as-any",
  "codeShape": "response as any",
  "normalizedCodeShape": "response as any",
  "insideExportedIdentity": "src/api/client.ts::fetchUser",
  "occurrenceKey": "sha256:ab12...",
  "source": "fresh-ast-pass",
  "scope": "TS/JS production files",
  "confidence": "high",
  "observedAt": "..."
}
```

`escapeKind` is one of:

- `explicit-any` — `: any` annotation or `any` in a type position.
- `as-any` — `expr as any`.
- `angle-any` — `<any>expr` (legacy cast syntax).
- `as-unknown-as-T` — type-laundering two-step cast. Treated as `any`-class severity.
- `rest-any-args` — `...args: any[]`.
- `index-sig-any` — `{ [k: _]: any }`.
- `generic-default-any` — `T = any` in a generic parameter default.
- `ts-ignore` — `// @ts-ignore` comment.
- `ts-expect-error` — `// @ts-expect-error` comment.
- `no-explicit-any-disable` — `// eslint-disable-next-line no-explicit-any` or equivalent.
- `jsdoc-any` — JSDoc `@type {any}` / `@param {any}` / `@returns {any}` style annotation in JS files.

`insideExportedIdentity` is `null` when the escape occurs in a non-exported position (local helper, module-scope assignment, etc.).

**`normalizedCodeShape`** (P2-0 amendment, 2026-04-20) — whitespace-normalized form of `codeShape` for matching purposes. Inner whitespace runs collapsed to a single space; trailing `;` dropped. NEVER used for display — `codeShape` carries the original source slice verbatim. Normalization MUST be token-aware or AST-slice-aware so whitespace inside string / template literals is preserved (e.g. `foo as "a   b" as any` normalizes to `foo as "a   b" as any`, not `foo as "a b" as any`).

**`occurrenceKey`** (P2-0 amendment, 2026-04-20; multiset clarification 2026-04-28) — stable `sha256` hash over `file + '|' + escapeKind + '|' + normalizedCodeShape + '|' + (insideExportedIdentity ?? '<top-level>')`. Stored as `"sha256:<64-hex>"` for forward-compatibility with future hash schemes. Enables P2 post-write delta to match occurrences across formatter reruns without line-number volatility: a prettier pass that shifts lines but leaves code shape intact does NOT flip an occurrence from `pre-existing` to `silent-new`. This key is a stable occurrence **bucket**, not a globally unique instance id: two identical escapes in the same exported identity may share the same key. Consumers comparing before/after inventories MUST use multiset/count semantics, not `Map<occurrenceKey, single occurrence>` presence checks.

**Precedence for escapeKind assignment** — an AST occurrence that would match multiple `escapeKind` patterns is classified to the MOST SPECIFIC kind. Producers MUST emit exactly one fact per source occurrence:

- `rest-any-args` wins over `explicit-any` (for `...args: any[]`).
- `index-sig-any` wins over `explicit-any` (for `{ [k: _]: any }`).
- `generic-default-any` wins over `explicit-any` (for `T = any`).
- `angle-any` wins over `explicit-any` (for `<any>expr`).
- `as-unknown-as-T` wins over `as-any` (for `expr as unknown as T`).

Two facts from a single source occurrence is a producer defect, structurally pinned by the extractor's unit tests.

### 3.10 `dependency-import-consumer`

Observed static package import used by P1 pre-write dependency lookup.
This is intentionally package-scoped evidence, not internal module/API
evidence. Relative imports, path aliases, and internal API surfaces belong
to name/file/topology facts instead.

```json
{
  "kind": "dependency-import-consumer",
  "file": "src/features/time/use-date.ts",
  "fromSpec": "date-fns/format",
  "depRoot": "date-fns",
  "importKind": "import",
  "source": "symbols.json.dependencyImportConsumers",
  "scope": "TS/JS/MDX scanned files",
  "confidence": "high",
  "observedAt": "..."
}
```

Producers advertise this lane with
`symbols.meta.supports.dependencyImportConsumers === true`. If the
capability is absent or false, pre-write MUST report dependency import
consumer counts as unavailable rather than `0 observed consumers`.

## 4. Confidence downgrade rules

A producer may emit `confidence: 'high'` only when all of these hold:

- No parse error in the owner file.
- Resolver blindness (unresolvedInternalRatio) < 0.15 for the scope.
- Staleness (time since `observedAt`) < 1 day OR the source artifact is from this run.

Any one condition failing demotes to `medium`. Two failing → `low`. Three → the producer emits `[확인 불가]` instead of a fact.

## 5. Producers

| Producer | Facts it emits |
|---|---|
| `build-symbol-graph.mjs` | type-owner, helper-owner (both optionally annotated with `anyContamination`), dependency-import-consumer, blind-zone, resolver-confidence |
| `any-inventory.mjs` | type-escape |
| `measure-topology.mjs` | topology-edge |
| `classify-dead-exports.mjs` | (annotates facts via provenance; does not produce new facts) |
| `rank-fixes.mjs` | (annotates via tiers; does not produce new facts) |
| `triage-repo.mjs` | boundary-rule |
| `checklist-facts.mjs` | watchpoint (via threshold gates), blind-zone (via `_context_check_required`) |
| `build-shape-index.mjs` | shape-hash |
| `pre-write.mjs` | consumes facts and writes advisory artifacts; produces no canonical facts |
| `generate-canon-draft.mjs` | emits drafts derived from facts; not a fact producer |

Current capability note: `build-symbol-graph.mjs` emits
`symbols.meta.supports.anyContamination === true` together with
`helperOwnersByIdentity` / `typeOwnersByIdentity` for parsed TS/JS owner
identities. Legacy, malformed, or partial artifacts may still omit that
capability; in that state consumers MUST NOT infer "clean" and instead
emit `[확인 불가]` for semantic-axis contamination claims. The
`anyContamination` annotation schema below is normative whenever the
producer advertises support.

## 6. Consumers

| Consumer | Facts it consumes |
|---|---|
| P1 pre-write | type-owner, helper-owner, dependency-import-consumer, topology-edge, boundary-rule, resolver-confidence (downgrade), blind-zone, type-escape (for planned-vs-observed delta hint) |
| P2 post-write | same as P1 + type-escape (delta is the core output — see any-contamination.md §6 Stage 2); may also consume shape-hash when present |
| P3 refresh / canon-draft | type-owner, helper-owner, topology-edge (for draft emission) |
| P4 shape-duplication | shape-hash, helper-owner |
| structural-review mode | all |
| audit mode | narrow subset depending on question |

## 7. Drift (skeleton — promoted when P5 activates)

Drift is defined as: a canonical declaration exists (promoted to `canonical/*.md`) that disagrees with a current fact of the same kind. Formal drift semantics live in `canonical/canon-drift.md`. Pre-write continues to emit one-line drift warnings as described in `pre-write-gate.md` §8; the formal drift detector (`check-canon.mjs`) is built out across P5-1..P5-4.

## 8. Invariants

- No fact without `source`, `scope`, `confidence`, `observedAt`.
- No new fact kind without listing it here.
- No producer adds a kind silently.
- No consumer reads a fact kind this file doesn't list.
- `anyContamination` is an ANNOTATION on `type-owner` / `helper-owner` facts, not a top-level kind. It is omitted when absent only under an advertised producer capability. When present, it must carry the full shape defined in `canonical/any-contamination.md` §4: `{ label, labels, measurements }`. A flat schema (e.g. `{ label, anyFieldRatio, totalFields, ... }`) is non-conforming and WILL break consumers that read `measurements.anyFieldRatio` / `measurements.asAnyCount`.
- `type-escape` is a TOP-LEVEL occurrence fact, distinct from `anyContamination`. Every `as any`, `<any>expr`, `as unknown as T`, `@ts-ignore`, JSDoc `{any}` annotation, and `no-explicit-any` disable emits one `type-escape` per occurrence. Annotations summarize state; occurrences enable delta. Both are required.
- `type-owner` facts MUST carry `exportedName` as the canonical identity field. `typeName` may be present as a display alias but MUST NOT be relied on for identity matching. A producer that emits only `typeName` without `exportedName` is non-conforming.
