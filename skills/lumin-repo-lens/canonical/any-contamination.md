# canonical/any-contamination.md

> **Role:** how the skill handles `any` / `as any` / type-escape hatches. Separates `any` (escape) from `unknown` (safe boundary). Defines three tiers of contamination + occurrence-level facts for delta tracking. Enforces "no silent new any".
> **Owner:** this file.

---

## 0. Current Producer Capability

This file is the normative contract for `any` / type-escape facts.
`build-symbol-graph.mjs` emits per-identity annotations for parsed TS/JS
owner identities and advertises
`symbols.meta.supports.anyContamination === true` when that owner-fact
surface is present. Legacy or partial artifacts may still lack that
capability; consumers must then surface `[확인 불가, reason: producer did
not emit anyContamination capability]` for semantic reuse, shape-safety,
or contract-clean claims. They must not silently treat the identity as
clean.

## 1. Why this invariant exists

Vibe-coder repos are heavy on `any` / `as any` because LLM-generated code leans on type-escape hatches as the path of least resistance. Two things must be true simultaneously:

- Structural analysis (names, imports, ownership, fan-in) keeps working on `any`-heavy code. Shape comparison, type contract, and safe-reuse claims do not.
- **New `any` introduced in any session must not be silent.** The skill exists to prevent drift; silently accepting new escapes defeats the purpose.

The worst failure mode this file prevents: Claude recommending reuse of an `any` blob and calling it "grounded".

## 2. Explicit `any` vs `unknown` — NOT the same thing

`any` and `unknown` are not equivalent. This file distinguishes them.

- **`any`** is a type-system escape hatch. Operations on `any` are unchecked. Values flow into `any` silently.
- **`unknown`** is the safe top type. Operations on `unknown` require narrowing via type guards. It's the correct type for "boundary data with unknown shape".

`function parseJson(raw: string): unknown` is GOOD design — it forces callers to narrow before use. Treating it as contamination would punish correct code.

This file tracks both, but:

- Explicit `any` / `as any` / `<any>expr` / true implicit-any produce `any-contaminated` labels.
- `unknown` / `as unknown` / `unknown` in fields / `unknown` return produces `unknown-surface` label — a weaker, different signal that constrains shape comparison only.
- The combination `as unknown as T` is **type laundering** — less obvious than `as any` but functionally similar. It is classified as `any-contaminated`, not `unknown-surface`.

## 3. Contamination definitions

### 3.1 Type identity (interface / type alias / enum)

Let `F` = declared field count (for object-like types) or enum member count. Let `A_any` = count typed explicitly `any`. Let `A_unknown` = count typed `unknown`.

Three `any` tiers and one separate `unknown` signal:

| Label | Condition |
|---|---|
| `has-any` | any explicit `any` occurrence in the declaration: at least one field `any`, or `Record<K, any>`, or `any[]`, or `Array<any>`, or `Promise<any>`, or index signature `[key: _]: any`, or generic default `T = any` |
| `any-contaminated` | direct alias `type X = any`; OR `anyFieldRatio ≥ 0.25`; OR index signature returns `any`; OR (exported AND `A_any ≥ 1`) |
| `severely-any-contaminated` | direct alias `type X = any`; OR `anyFieldRatio ≥ 0.67`; OR `A_any ≥ 3`; OR (index signature `any` AND total meaningful fields ≤ 3) |
| `unknown-surface` | `A_unknown ≥ 1`; OR direct alias `type X = unknown`; OR index signature returns `unknown` |

`anyFieldRatio = A_any / F` (undefined if F == 0).

`has-any` is a superset of `any-contaminated`. An identity may carry both `any-contaminated` and `unknown-surface` — they're independent axes.

`as unknown as T` inside a declaration — treat as `any-contaminated`, not `unknown-surface`.

### 3.2 Helper identity (exported function / method)

Let `P` = parameter count, `Pa` = explicit-any param count, `Pu` = unknown param count. Let `R` = declared return type (NOT inferred — see §3.4). Let `B_any` = `as any` / `<any>` assertion count inside the body. Let `B_launder` = `as unknown as T` count.

| Label | Condition |
|---|---|
| `has-any` | `Pa ≥ 1`; OR `R == 'any'`; OR `B_any ≥ 1`; OR rest param `...args: any[]`; OR `B_launder ≥ 1` |
| `any-contaminated` | exported AND (`Pa ≥ 1` OR `R == 'any'` OR `B_any ≥ 1`) |
| `severely-any-contaminated` | `R == 'any'`; OR (`Pa ≥ 1` AND `R == 'any'`); OR `B_any ≥ 2`; OR `B_launder ≥ 1`; OR rest param `...args: any[]` |
| `unknown-surface` | `Pu ≥ 1`; OR `R == 'unknown'` |

Rationale:

- `as any` is explicit escape. Even one occurrence in an exported helper is `any-contaminated`.
- `as unknown as T` is type laundering — treat as severe (one occurrence = severe), because it's deliberately invisible.
- Rest param `...args: any[]` is commonly copy-pasted and spreads contamination; treat as severe.

### 3.3 File aggregate

A file is labeled via:

- `has-any` — `explicitAnyCount ≥ 1` OR `asAnyCount ≥ 1` OR `launderCount ≥ 1`.
- `any-heavy` — `any-contaminated exported identities / total exported identities ≥ 0.2`; OR `explicitAnyCount ≥ 5`; OR `asAnyCount ≥ 3`.
- `severely-any-heavy` — `severely-any-contaminated exported identities ≥ 2`; OR `asAnyCount ≥ 10`; OR `explicitAnyCount ≥ 20`.

File-level labels are derived from per-identity facts + `type-escape` facts (§5) at consumption time.

### 3.4 Missing return annotation is NOT `any`

TypeScript infers return types from function bodies. `function add(a: number, b: number) { return a + b; }` has no return annotation but infers as `number`. Treating "missing return annotation" as `any` would punish normal code.

Rule:

- **Explicit `R == 'any'`** — `any-contaminated` (severe per §3.2).
- **Missing `R`, inferred type unknown to AST-only pass** — NOT counted as contamination. AST alone cannot tell whether `R` was inferred as `any` or as a proper type.
- **True implicit-any** (TypeScript `noImplicitAny` would flag) — counts only when a TypeScript semantic pass confirms. Without a checker available, emit `[확인 불가, reason: implicit-any needs TS semantic pass]` instead of guessing.

Missing annotations may be surfaced as a separate `missing-return-annotation` discipline signal, but NOT as `any` contamination.

### 3.5 What else does NOT count

- Generic type parameters (`type Box<T> = { value: T }` — the `T` is an unknown parameter, not `any`).
- `any` in third-party `*.d.ts` under `node_modules/` (not the project's choice).
- Ambient module declarations (`declare module '*.css'`).
- `unknown` alone, without combination with `as T` laundering.
- Conditional types / inferred types that collapse to `any` only under specific instantiations (too noisy for static analysis).

## 4. Effect on existing fact types

`anyContamination` remains a per-identity ANNOTATION on `type-owner` and `helper-owner` facts (see `canonical/fact-model.md` §3.1–3.2). Shape of the annotation:

```json
{
  "label": "severely-any-contaminated",
  "labels": ["has-any", "severely-any-contaminated", "unknown-surface"],
  "measurements": {
    "totalFields": 7,
    "anyFields": 6,
    "unknownFields": 0,
    "anyFieldRatio": 0.85,
    "indexSignatureAny": false
  }
}
```

`label` is the HIGHEST-severity applicable tier. `labels` lists every applicable tier for completeness. `measurements` carries the raw counts so consumers can show scale, not just label.

Omit the annotation entirely for identities with NO `any` / `unknown` signal. A `has-any`-only identity still gets the annotation (label `has-any`, no elevation).

## 5. `type-escape` — occurrence-level fact (complements annotation)

`anyContamination` describes WHAT an identity looks like. `type-escape` describes WHERE an escape occurs. Both are needed — post-write delta cannot work from annotations alone because escapes outside exported identities (helpers, inline function bodies, test utilities) matter too.

Shape in `canonical/fact-model.md` §3.9:

```json
{
  "kind": "type-escape",
  "file": "src/api/client.ts",
  "line": 42,
  "escapeKind": "as-any" | "explicit-any" | "angle-any" |
                "as-unknown-as-T" | "ts-ignore" | "ts-expect-error" |
                "no-explicit-any-disable" | "rest-any-args" |
                "index-sig-any" | "generic-default-any" | "jsdoc-any",
  "codeShape": "response as any",
  "insideExportedIdentity": "src/api/client.ts::fetchUser" | null,
  "source": "fresh-ast-pass",
  "scope": "...",
  "confidence": "high",
  "observedAt": "..."
}
```

Producers emit one `type-escape` per occurrence. A helper with three `as any` sites produces three `type-escape` facts plus the `anyContamination` annotation on the helper itself.

## 6. Three-stage defense

### Stage 1 — Pre-write (prevent reuse of `any` blobs)

`canonical/pre-write-gate.md` §3 demotes reuse-candidate lookups whose target is `any-contaminated`. Already in spec v1.

Extension (this file adds): `pre-write-gate.md` Step 2 intent extraction now includes a **planned type escapes** line. Claude declares up front what escapes it expects to introduce, with reasons. Empty list is the default and is stated explicitly.

```
Planned type escapes:
- `payload: any` in fetchUser, reason: third-party response not yet typed
```

This forces intent to be visible before code lands, not discovered after.

### Stage 2 — Post-write (delta on new escapes)

P2 post-write mode compares `type-escape` facts before vs after Claude's edits. Emits the delta:

```
Any delta:
- explicit any:        +2  (new)
- as any:              +1  (new)
- as unknown as T:     +0
- ts-ignore / expect-error: +0

New escape sites:
1. src/api/client.ts:42  `response as any`
   insideExportedIdentity: src/api/client.ts::fetchUser
   planned? no — reason missing

2. src/types.ts:8  `payload: any`
   insideExportedIdentity: src/types.ts::RequestPayload
   planned? yes — third-party response untyped
```

The comparison is multiset-based. `occurrenceKey` is stable across
formatting, but it is not guaranteed unique when the same escape shape
appears more than once in the same exported identity. If before has one
`explicit-any` occurrence for a key and after has two, post-write MUST
emit exactly one `silent-new` entry for the excess occurrence.

### Stage 3 — Response-time (No silent new any)

**Invariant: no new `any` ships without the final response acknowledging it.**

When post-write observes a non-empty delta, Claude's final response to the user MUST include one of:

- Removal of the escape before completing the task.
- A line-cited acknowledgment of each new escape with its reason.
- An explicit override statement: "`as any` at src/x.ts:N retained intentionally because ..." — citing the reason and (optionally) a canonical location that permits the escape.

The skill does not block the edit. It makes the introduction visible. A vibe-coder who sees Claude's response still learns there is new `any` even if they don't read the diff.

## 7. Effect on shape-hash comparison (P4)

Same as v1 spec:

- Shape hashes still computed for contaminated identities.
- Contaminated identities EXCLUDED from duplicate-detection clustering on shape alone.
- All-contaminated clusters collapse to `ANY_COLLISION`, not `SHAPE_DUPLICATE`.
- Mixed clusters skip all-contaminated-only rule; the contaminated members are still reported separately (see §8 below — mixed group behavior).

## 8. Effect on classification gates

`canonical/classification-gates.md` §2 (duplicate groups) and §4 (single-identity) carry the full rule set. This file records the ADDITIONAL rule for mixed groups that the spine-v1 version missed:

### 8.1 Mixed duplicate groups

A duplicate group where SOME identities are contaminated and some are clean still goes through the normal Rule 1 / 2 / 3 classification (DUPLICATE_STRONG / LOCAL_COMMON_NAME / DUPLICATE_REVIEW) — structural naming collision is real regardless of contamination. BUT the group output MUST include:

- `anyMembers: [identity list]` — identities in the group with `any-contaminated` or `severely-any-contaminated`.
- `severeAnyMembers: [identity list]` — subset with `severely-any-contaminated`.
- `semanticConfidence: "low"` — fixed when `anyMembers.length > 0`.
- `tags: ["has-any-member"]` or `["has-severe-any-member"]` as applicable.

A contaminated member in a mixed duplicate group MUST NOT disappear just because the group is not all-contaminated. The classification gate test harness verifies this invariant by construction.

### 8.2 Why tags, not new labels

New label (`DUPLICATE_STRONG_WITH_ANY`) would proliferate without upper bound. `tags` + `semanticConfidence` scales better and keeps the core label set small. Preserved invariant from classification-gates.md §9.

## 9. Pre-write gate interaction (extended from spec v1)

(Extending `canonical/pre-write-gate.md`.)

Step 2 intent extraction now enumerates **planned type escapes** (§6 Stage 1 above).

Step 3 lookup demotion for `any-contaminated` candidates unchanged from spine v1.

Step 5 output format gets a new section when planned escapes exist:

```
### Planned type escapes (declared by Claude)

- `payload: any` in fetchUser, reason: third-party response not yet typed.
  Alternative considered: decode + narrow via `unknown` — rejected because (...).
```

Empty list case:

```
### Planned type escapes: none.
```

## 10. Producer responsibilities

- **Per-identity annotation** — extend `_engine/lib/extract-ts.mjs` (or sibling `_engine/lib/extract-ts-contamination.mjs`) to annotate each extracted `def` with the `anyContamination` object defined in §4. Omit when clean.
- **Per-occurrence `type-escape` fact** — fresh AST walk emits exactly one `type-escape` fact per occurrence, covering every `escapeKind` enumerated in `canonical/fact-model.md` §3.9. The producer MUST cover all 11 kinds, not just the common three:

  | escapeKind | AST / source shape |
  |---|---|
  | `explicit-any` | `TSAnyKeyword` in a type annotation position (field, param, return, variable) |
  | `as-any` | `TSAsExpression` whose `typeAnnotation` is `TSAnyKeyword` |
  | `angle-any` | `TSTypeAssertion` (`<any>expr`, legacy cast syntax) whose `typeAnnotation` is `TSAnyKeyword` |
  | `as-unknown-as-T` | chained `TSAsExpression` where the inner is `as unknown` and the outer is `as T` for non-unknown `T` |
  | `rest-any-args` | rest parameter `RestElement` with type `any[]` / `Array<any>` / tuple of any |
  | `index-sig-any` | `TSIndexSignature` whose `typeAnnotation` is `TSAnyKeyword` |
  | `generic-default-any` | `TSTypeParameter.default == TSAnyKeyword` |
  | `ts-ignore` | `// @ts-ignore` line-comment or leading comment attached to a statement |
  | `ts-expect-error` | `// @ts-expect-error` line-comment or leading comment attached to a statement |
  | `no-explicit-any-disable` | `// eslint-disable-next-line no-explicit-any` or `/* eslint-disable no-explicit-any */` |
  | `jsdoc-any` | JSDoc comment with exact `{any}` such as `/** @type {any} */`, `@param {any}`, or `@returns {any}` |

  Missing any of these 11 kinds is a producer defect, not a scope choice. "No silent new any" (invariants.md §9) depends on the occurrence set being complete — a missing kind is a silent escape hatch.

- `build-symbol-graph.mjs` propagates the annotation into `symbols.json`.
- A new artifact `any-inventory.json` holds the full `type-escape` fact list. Pre-write and post-write modes consume it.
- `measure-discipline.mjs` stays as a global aggregate; it does not replace the per-occurrence detail.

If the producer cannot emit this measurement in a given run, it must set the
capability flag false and consumers must downgrade as described in §0.

## 11. Honesty requirements

- Every advisory / canon draft / classification output surfacing a contaminated identity MUST show raw measurements (ratio, count), not just the label. Scale is the signal.
- The word `any` appears literally in all user-facing text. Euphemisms forbidden.
- `[확인 불가]` is required when measurement cannot be taken (parse error, chain too deep, implicit-any without TS checker). See §3.4.
- `unknown-surface` output does NOT use the word "contaminated". It says "unknown-surface" or "bounded unknown". Using "contaminated" for `unknown` teaches the wrong type-system lesson.

## 12. What this invariant is NOT

- NOT a lint rule. The skill observes; it does not propose specific `any`-to-type conversions.
- NOT a blocker. Claude may write `any` / `as any` if deliberate. The skill warns and records; it does not veto.
- NOT a severity escalation for other findings. A `zero-internal-fan-in` identity that is also `any-contaminated` is still `zero-internal-fan-in` — the contamination label rides alongside, not overwrites.
- NOT a confidence downgrade for structural facts. Fan-in, ownership, import direction remain at whatever confidence the structural analysis warrants. Only semantic-axis claims (shape match, contract, reuse safety) are demoted.

## 13. Invariants

- No semantic claim about an `any-contaminated` identity without an explicit `warn-on-reuse` recommendation caution. Measurement evidence can still be `[grounded]`.
- No duplicate-flag on a cluster of all-`any-contaminated` identities; use `ANY_COLLISION`.
- No silent omission of `anyContamination` when it applies; producer either emits the full measurement payload or advertises capability false so consumers emit `[확인 불가]`.
- No conflation of `any` with `unknown`. `unknown-surface` is a separate, weaker signal.
- No silent new `any` in the final response. Post-write delta is mandatory when it detects new escapes.
- No treatment of missing return annotation as `any`. Missing = inferred, not escape.
- No euphemism. The word `any` is literal.
- `anyContamination` is an ANNOTATION on owner facts; `type-escape` is an OCCURRENCE fact. They are orthogonal and both required.
