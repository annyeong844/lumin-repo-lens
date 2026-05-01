# Structural Review Checklist (v1.1)

Six review sections — **A. Size & simplicity**, **B. Duplication & shape**, **C. Cohesion & boundaries**, **D. Types & contracts**, **E. Failure handling**, **F. Abstraction & tests**.

When a user asks for a structural review, walk every section with
grounded evidence first and synthesis last. Closely related prompts may
be answered together when the same artifact value or scan range proves
the same point. If a prompt is not evaluated, label it explicitly as
`[unknown]` with the scan range instead of silently skipping it.

---

## Rules for every answer

### Rule 1 — Label with VALUE, not path

Every answer carries one label. The `[grounded]` variant MUST include the actual value read from the artifact, not just the path. Any reader should be able to open the artifact and see the same value, which makes fabricated citations detectable by mechanical check.

- `[grounded, <artifact>.json.<field-path> = <value>]` — AST-verified, reproducible, value cited.
- `[degraded, confidence: low|medium|high, <short reason>]` — partial evidence + reasoning. State which signal is missing.
- `[unknown, scan range: <what you inspected>]` — no evidence. State what you checked and came up empty. Do NOT fabricate.

Good citations look like:

- `[grounded, topology.json.summary.sccCount = 0]`
- `[grounded, checklist-facts.json.A2_function_size.buckets = {big: 4, medium: 4, small: 491}]`
- `[grounded, fix-plan.json.summary.SAFE_FIX = 2]`

Bad citations:

- `[grounded, source: topology.json]` — no path, no value; unfalsifiable.
- `[grounded, SCC 없음]` — assertion without citation.

If a value is too long to inline, cite the summary metric or a representative element (e.g., `[grounded, symbols.json.deadProdList.length = 37, first 3: [...]]`).

### Rule 2 — Shape depends on the gate

- ✅ `healthy` — one-line answer is permitted and preferred. Do not invent a symptom to fit a three-bullet template. "`[grounded, ...] ✅`" is complete.
- ⚠ `watch` / ❌ `fix` — `증상 → 원인 → 어디부터` (symptom → cause → where-to-start) triple, three bullets max.

### Rule 3 — Primary source vs supplementary

Each item declares **one Primary source** (the binding field for the answer) and optional **Supplementary sources** (judgment inputs, not for gating). Cite only the Primary for the main label; Supplementary goes in the reasoning paragraph if used. Items with a **Do not consult** line must NOT reference those artifacts in the main label — they belong to a different item and mixing them collapses the two-layer system into one.

### Rule 4 — No claim without scan range

"X doesn't exist" is only valid with a stated scan range: "checked `*.mjs` except `node_modules/`, 0 matches for pattern `...`". The `unknown` label carries the scan range as part of its payload.

### Rule 5 — Decision density

Mark each item with one of:

- ✅ `healthy` — no action needed
- ⚠ `watch` — acceptable now, monitor
- ❌ `fix` — action required; specify bucket (SAFE_FIX / REVIEW_FIX / DEGRADED)

### Rule 6 — Gate values are triggers, not verdicts

When `checklist-facts.json` reports `gate: 'fix'` or `'watch'` on a threshold-driven item, do NOT copy the label blindly. Threshold bands (e.g., "cross-submodule ratio > 0.5 = fix") are defaults; context may legitimately override. A layered architecture may cross-couple at 87% without it being a smell. For every pre-computed gate:

1. State the raw number in natural language (✓ Rule 1 already requires this).
2. Assess whether the threshold fits the scanned repo's context (one sentence).
3. Keep, downgrade, or upgrade the gate accordingly — document which.

Rule 6 is what prevents the pre-compute layer from becoming a rubber stamp.

### Rule 7 — `unknown` is a first-class answer

Half the items in a review being `unknown` is NORMAL and acceptable. The checklist is a blind-spot visualizer, not a coverage metric. Confabulating a `[grounded]` answer to avoid looking incomplete is worse than honest unknowns.

### Rule 8 — Walk pre-computed items first, synthesis last

Each section declares a **Walk order** that front-loads items with a `checklist-facts.json` binding, then items with direct-artifact grounding, then LLM-synthesis items. Momentum from grounded answers anchors the later judgment calls. Do not walk in numeric order (A1 → A6 etc.) — that puts summary-of-everything (A1) before its inputs (A2–A6), which forces blind synthesis.

### Rule 9 — Section summary

After finishing a section, emit a **1-2 sentence section summary** naming
the highest-severity finding in that section (or "all ✅" if none).
Section summaries break the fatigue curve on long checklists and give
the walker a natural anchor point before moving to the next section. The
summary format:

> **Section A summary**: [severity] — [one-sentence characterization]. [optional: highest-leverage fix].

Skip no section. Empty sections emit `**Section X summary**: all items unknown — artifact set not present.`

### Rule 10 — Classify by stated criteria, then synthesize

Extraction is not interpretation. Before turning a cue into a finding,
state the criterion you are applying and keep the same `file:line` or
symbol under one classification.

Use these baselines unless the repo documents a stricter policy:

- **Probe vs silent fallback**: parsing untrusted input, optional headers,
  best-effort URLs, or lossy display data may be a probe. It becomes a
  silent-fallback violation only when a canonical path, persisted domain
  state, security decision, or required workflow failure is hidden or
  replaced with a misleading default.
- **Duplicate helper extraction**: count compatible signatures and
  behavior first. If signatures diverge, call it a helper family or
  convergence opportunity; do not claim "single helper extraction" until
  the shared parameter shape is proven.
- **String or wire-constant drift**: a repeated literal becomes watch
  when the same wire/protocol value is independently defined across a
  package or app boundary, or when one literal already has an owner and
  another module redefines it.
- **Oversized function responsibility**: name at least two separable
  responsibilities with evidence from the body. If you cannot, classify
  it as a large single-responsibility function or watch item, not a
  multi-responsibility smell.
- **File identity**: if a basename appears in multiple directories, cite
  the full path every time.

When combining multiple assistant walks or sub-agent notes, the final
author reruns targeted checks before publishing: re-count headline
numbers, re-read the highest-impact file:line claims, and resolve
contradictions instead of carrying both sides into the report.

---

If you're running this for a TS/JS monorepo with this skill's artifacts available (`symbols.json`, `topology.json`, `topology.mermaid.md`, `dead-classify.json`, `fix-plan.json`, `discipline.json`, `call-graph.json`, `shape-index.json`, `triage.json`, `level2-methods.json`, `runtime-evidence.json`, `staleness.json`, `barrels.json`, `checklist-facts.json`, `lumin-repo-lens.sarif`), prefer their fields over re-scanning. `checklist-facts.json` pre-computes the automatable half — see its `_citation_hint` per item for the expected label format. `topology.mermaid.md` is a capped visual companion for cross-submodule flow, cycles, and hub files only; cite `topology.json` for grounded topology claims.

This checklist is repo-neutral. It intentionally does not include
dogfood-only checks for `lumin-repo-lens` itself.

The default `quick` profile does not produce every optional artifact.
For a full checklist walk, prefer `--profile full`; it emits
`call-graph.json`, `barrels.json`, and `shape-index.json` in addition
to the quick artifacts, and adds runtime/staleness evidence when those
inputs are available. If an optional artifact is still absent, `[확인
불가]` is the correct answer for the affected prompt.

---

## A. Size & simplicity

**Walk order**: A2 → A6 → A5 → A3 → A4 → A1. Pre-computed grounded items (A2, A6, A5) first; structural items (A3, A4) middle; synthesis (A1) last.

### A1. 크기와 복잡도는 현재 문제에 비해 적절한가?

**Evidence sources:** Aggregate of A2–A6. Also `triage.json.shape.totalFiles`, `shape.totalLoc`, `shape.meanLocPerFile`.
**Answer template:** State repo size class (tiny/small/medium/large by LOC) and whether the module structure is justified at that scale.
**LLM judgment:** Yes — A1 summarizes A2–A6. Start by reading the sub-item outputs, then conclude.

### A2. 한 함수가 지나치게 길거나 여러 책임을 동시에 지고 있지는 않은가?

- **Primary source**: `checklist-facts.json.A2_function_size` (fields: `gate`, `buckets`, `roleBuckets`, `oversized[]`, `oversizedByRole`, `watch[]`, `watchByRole`, `p95Loc`).
- **Supplementary**: none. Do not cite `topology.json.largestFiles` — that measures FILE LOC, not function LOC, and mixing them for this item confuses the signal.
- **Cite the value**: `[grounded, checklist-facts.json.A2_function_size.buckets = {big: N, medium: N, small: N}, roleBuckets.production.big = N]` + list oversized production names first.
- **Context check (Rule 6)**: split production, test, and script/harness functions before recommending refactors. Large smoke/conformance scripts and single-block tests often stay as watch/context; production oversized functions should be considered first. If any oversized production function is a stable algorithmic core (e.g., `makeResolver`, `parseSpec`) with strong test coverage and no repeated-topic tell, downgrading big→watch is legitimate — state the reason.
- **Multi-responsibility tell** (for the `증상` line): name contains "and" / handles validation+normalization+io at once / has 3+ distinct early-return branches for unrelated concerns.

### A3. helper zoo처럼 보조 함수가 무질서하게 증식해 책임이 흐려지지는 않았는가?

**Evidence sources:** `symbols.json.topSymbolFanIn` (helpers with 0 fan-in outside their file = private — expected; helpers with 1 caller = candidate helper-zoo noise).
**Pattern:** a file exports ≥ 8 named helpers, most with fan-in ≤ 1, and the file is < 200 LOC → `helper zoo` anti-pattern.
**LLM judgment:** yes — verify names are unrelated (zoo) vs a cohesive utility family (fine).

### A4. 과분할, 불필요한 레이어링, 의미 없는 파일 쪼개기가 존재하지 않는가?

**Evidence sources:** `topology.json.nodes[]` where `loc < 50` AND `fanOut = 0` AND `fanIn ≤ 1`. Clusters of such tiny files pointing at one consumer = over-split.
**Counter-evidence:** `_engine/lib/parse-oxc.mjs` (39 LOC, fanOut 0, fanIn 6) is NOT over-split — it's a shared primitive. Small ≠ over-split; small + few consumers + redundant with a sibling = over-split.

### A5. 디커플링이 잘 이루어졌는가?

- **Primary source**: `checklist-facts.json.A5_decoupling_ratio` (fields: `gate`, `ratioLowerBound`, `crossSubmoduleEdgesTop30Sum`, `totalInternalEdges`).
- **Supplementary**: `level2-methods.json.crossPkgMethodEdges` for method-level coupling density, when present.
- **Do not consult**: `fix-plan.json` — A5 is a structural coupling measure, not a dead-code measure.
- **Cite the value**: `[grounded, checklist-facts.json.A5_decoupling_ratio.ratioLowerBound = 0.87]`.
- **Context check (Rule 6)**: **HIGH RATIO CAN BE HEALTHY** when layering is by design (top-level scripts → `_engine/lib/` helpers = intentional cross-submodule by construction). In layered repos, downgrade fix→watch or watch→healthy if the ratio reflects the layering, not disorder. A counter-test: do the cross-submodule edges have direction consistency (leaves → core = healthy; core → leaves = inversion)?

### A6. 순환의존성이 존재하지는 않는가?

- **Primary source**: `checklist-facts.json.A6_circular_deps` (fields: `gate`, `sccCount`, `maxSccSize`, `lens`, `topSccs[]`).
- **Supplementary**: `topology.json.sccs[]` for the full list if `topSccs` truncates.
- **Cite the value**: `[grounded, checklist-facts.json.A6_circular_deps.sccCount = 0, lens = runtime]`.
- **Context check (Rule 6)**: any SCC size ≥ 2 involving production files → ❌ fix. A type-only SCC (static lens) that's absent under runtime lens is not a runtime bug but still a signal worth documenting.

---

**Section A summary** (write after finishing A1–A6): `[severity] — [one-sentence repo sizing characterization]`. If any A-item is ❌ fix, name it.

---

## B. Duplication & shape

**Walk order**: B3 → B2 → B1 → B4. Pre-computed B3 (dead code) first; shape-drift B2 next (repo-specific but artifact-anchored); duplicate detection B1 and pipeline B4 require LLM synthesis.

### B1. 중복 구현, 복붙, 유사 로직의 병렬 유지가 존재하는가?

**Evidence sources:** `checklist-facts.json.B1B2_shape_drift` when `shape-index.json` is present (exact exported type shape plus near-shape review cues), `checklist-facts.json.B1_duplicate_implementation` when `function-clones.json` is present, `shape-index.json` for raw groups, `function-clones.json` for exported top-level function-body clone cues, `call-graph.json.semiDeadList[]` (imports never called) for post-refactor duplicates, and `level2-methods.json.topMethods` with the same signature across multiple files for duplicate API surface.
**LLM judgment:** yes — `shape-index.json` supports exact and near type-shape evidence; `function-clones.json` supports exact-body, same-structure, and near-function candidate cues. These cues are not proof of semantic equivalence. Read the cited source ranges before calling helpers duplicated, and never recommend merge/refactor from clone artifacts alone.

### B2. shared shape가 여러 곳에 흩어져 함께 썩는 구조는 아닌가?

**Evidence sources:** Start with `checklist-facts.json.B1B2_shape_drift` for exact exported type-shape clusters and `nearShapeCandidates[]` when available, then check whether taint kinds, evidence labels, rule IDs, tier strings flow through one documented vocabulary/schema module.
**Scan:** Search for repeated literal tier/rule/evidence labels. A repeated label is a smell only when it duplicates an existing vocabulary owner instead of using or extending it.

### B3. dead code, 더 이상 쓰이지 않는 우회 경로, 과거 마이그레이션 잔재가 남아 있지는 않은가?

- **Primary source**: `checklist-facts.json.B3_dead_code` (mirrors `fix-plan.json.summary`).
- **Supplementary**: `dead-classify.json.proposal_C_remove_symbol[]` for the specific symbols, `runtime-evidence.json` for runtime-zero-hit confirmation.
- **Do not consult**: `symbols.json.deadProdList` directly — that's pre-ranking. Use the ranked/classified numbers from B3 Primary.
- **Cite the value**: `[grounded, checklist-facts.json.B3_dead_code = {safeFix: 2, reviewFix: 5, degraded: 1, muted: 0, total: 8}]`.
- **Context check (Rule 6)**: SAFE_FIX ≥ 10 → ❌ fix unless those are all in an opt-in experimental module. REVIEW_FIX count alone is not a gate; it's a review queue.

### B4. 동일한 멀티스텝 워크플로우/파이프라인이 서로 다른 진입점에서 독립적으로 구현되고 있지는 않은가?

**Evidence sources:** LLM judgment. Cue: multiple scripts with similar file-walk + parse + analyze + emit shapes. Prefer a single recommended orchestrator for user-facing flows; alternate entry points should delegate instead of re-implementing the pipeline.

---

**Section B summary**: `[severity] — [one-sentence duplication/shape characterization]`.

---

## C. Cohesion & boundaries

**Walk order**: C5 → C7 → C6 → C2 → C1 → C3 → C4. Pre-computed (C5 lint, C7 barrel) first; triage-anchored (C6 file hierarchy) next; topology reasoning (C2) before pure-LLM items (C1, C3, C4).

### C1. 모듈, 파일, 함수의 응집도는 충분히 높고 SRP는 잘 지켜지고 있는가?

**Evidence sources:** `call-graph.json.moduleCallCount[]` (feature-envy edges). A file that imports heavily from one sibling and hardly from others = cohesion or feature-envy depending on direction.
**LLM judgment:** yes — verify name vs body alignment.

### C2. 구조 경계는 건강한가? 책임과 의존 방향이 자연스럽고 무리하지 않은가?

**Evidence sources:** `topology.json.subEdges[]` — cross-submodule edge direction. Leaves → core flow is healthy; core → leaves is an inversion (likely feature envy or layering violation).

### C3. 검증, 정규화, 에러 처리 같은 교차 관심사가 병목 지점에서 집중 관리되고 있는가?

**Evidence sources:** `discipline.json` for error-handling density (`try|catch|throw` counts per file). `call-graph.json` for validator-like function fan-in (high fan-in on `validate*`/`normalize*`/`assert*` = cohesive; scattered use = diffuse).
**LLM judgment:** yes — cross-cut identification requires reading names + call sites.

### C4. 상태 변경은 단일 진입점 또는 예측 가능한 경로를 통하는가?

**Evidence sources:** `call-graph.json` — look for `Map.prototype.set` / `Set.prototype.add` / direct assignment to module-level `let` bindings. Multiple writers to the same global = ❌ fix.
**LLM judgment:** yes — static analysis can find writers but intent (single-writer-by-design) needs review.

### C5. 모듈 경계가 lint, import rule, build rule 등으로 실제 강제되고 있는가?

- **Primary source**: `checklist-facts.json.C5_lint_enforcement` (fields: `gate`, `boundaryRulePresent`, `rulesDetected`, `rules[]`).
- **Supplementary**: `triage.json.boundaries[]` for full rule inventory.
- **Cite the value**: `[grounded, checklist-facts.json.C5_lint_enforcement.boundaryRulePresent = false, rulesDetected = 0]`.
- **Context check (Rule 6)**: absence of a boundary rule is ⚠ watch by default. Upgrade to ❌ fix only if A5/C7 gates are also tripping — lint absence becomes structural risk only when violations are happening.

### C6. 파일이 위계, 의존도에 따라 분류, 정리되어 있는가?

**Evidence sources:** `triage.json.topDirs{}` shape. Healthy: top-dirs with meaningful names (`apps/`, `packages/`, `_engine/lib/`). Anti-pattern: everything at root, no apparent layering.

### C7. 배럴 파일이 import amplification을 일으키고 있지 않은가?

- **Primary source**: `checklist-facts.json.C7_barrel_amplification` (fields: `gate`, `worstCompliance`, `byPackage[]`).
- **Supplementary**: `symbols.json.reExportsByFile` for non-workspace barrel candidates (a file re-exporting ≥ 10 symbols from ≥ 5 siblings, imported by ≥ 3 consumers = barrel-bomb candidate).
- **Cite the value**: `[grounded, checklist-facts.json.C7_barrel_amplification.worstCompliance = 0.32]`.
- **Context check (Rule 6)**: Node ESM has no tree-shake → barrel bombs have a real cold-start cost. Monorepo with single-package mode legitimately returns `gate: ok` (no workspace barrels to discipline). In TypeScript bundled output, barrel cost is sometimes eliminated by downstream bundler — state which.

---

**Section C summary**: `[severity] — [one-sentence boundary health characterization]`.

---

## D. Types & contracts

**Walk order**: D1 → D3 → D2 → D4 → D5. D1 has `discipline.json` counts as a partial anchor; the rest are LLM synthesis with naming D3 coming before sibling-comparing D2.

### D1. 타입 조임과 인터페이스 계약은 안정적인가?

**Evidence sources:** `discipline.json.anyTypes`, `tsIgnoreCount`, `tsExpectErrorCount`. `level2-methods.json.envDiagnostic.epistemicNote` flags missing `@types/*` installs that inflate any-typed counts.
**JS-only repos:** D1 reduces to "do scripts converge on a documented shape across files?" — check for shared vocab / schema modules and JSON/artifact schema parsers.

### D2. 인터페이스, 타입 가드, 제네릭은 필요한 만큼만 사용되고 있는가?

**Evidence sources:** LLM judgment + `symbols.json.deadProdList` filtered to `kind: TSInterfaceDeclaration | TSTypeAliasDeclaration`. Unused type exports = over-spec.
**Related:** see FP-06 (type + predicate partner pattern) — don't flag intentional type/predicate pairs.

### D3. 네이밍, 규칙, 표현 방식은 일관적인가?

**Evidence sources:** LLM judgment — scan exported names across sibling files for consistent conventions (camelCase vs snake_case, prefix patterns, verb-noun order).
**Cue:** siblings that export `getFoo`, `fetch_bar`, `loadBaz` = inconsistent.

### D4. 암묵 계약, 숨겨진 임포트, 초기화 순서 의존성 같은 비가시적 결합이 존재하지 않는가?

**Evidence sources:** `call-graph.json.semiDeadList[]` can surface imports kept for side effects only. `topology.json.sccs[]` at the module-init layer reveals cycles that encode initialization order.
**LLM judgment:** yes — side-effect-only imports are sometimes intentional (polyfills, registrations); need context.

### D5. 상태에 따라 존재 여부가 달라지는 필드가 optional로 뭉뚱그려져 있지는 않은가? (discriminated union으로 좁힐 수 있는가?)

**Evidence sources:** LLM judgment, JS side has limited type info. Look for objects where optional field groups imply variants (`runtime`, `staleness`, `resolver`, `policy`, etc.) but no explicit discriminator records which variant is active.

---

**Section D summary**: `[severity] — [one-sentence type/contract characterization]`.

---

## E. Failure handling

**Walk order**: E2 → E1 → E3 → E4 → E5 → E6. Pre-computed E2 (silent catch) first; defensive-code density E1 builds on it; semantic items E3/E4/E5 and async E6 later.

### E1. 방어 코드는 필요한 경계에만 최소한으로 존재하는가? 호출부마다 중복 방어가 반복되고 있지는 않은가?

**Evidence sources:** AST scan for `try/catch` + `??`/`||` fallback chains. Repeated `a ?? defaultA; b ?? defaultB; ...` across call sites = defensive noise.
**Gate:** `grep -c "try {" *.mjs` vs genuine external boundaries → if inside-file try/catch outnumbers boundary-facing ones 2:1, ❌ fix.

### E2. catch는 에러를 삼키지 않고 적절히 전파, 기록, 표면화하고 있는가?

- **Primary source**: `checklist-facts.json.E2_silent_catch` (fields: `gate`, `analysis`, `count`, `sites[]`, `nonEmptyAnonymousCount`, `nonEmptyAnonymousSites[]`, `unusedParamCount`, `unusedParamSites[]`).
- **Supplementary**: open each site to judge probe-vs-logic (see Context check below).
- **Cite the value**: `[grounded, checklist-facts.json.E2_silent_catch.count = 11, nonEmptyAnonymousCount = 2, unusedParamCount = 1, analysis = oxc-ast-catch-clause, sites = [ ... first 3 ... ]]`.
- **Context check (Rule 6)**: the raw count includes intentional fs / JSON-parse probes (e.g., `try { statSync(p) } catch {}` in `_engine/lib/paths.mjs`-style helpers). Count probe catches separately before deciding the gate — "11 total, 9 are probes + 2 real logic catches" usually stays ⚠ watch, not ❌ fix. Non-empty `catch { ... }` sites do not inflate the empty silent count, but they are still watch evidence because they discard the error identity. Upgrade to fix only when >3 catches sit in non-probe positions.

### E3. fallback, graceful degradation, silent recovery가 버그 은닉 장치로 작동하고 있지는 않은가?

**Evidence sources:** LLM judgment + `discipline.json` `catch` density. A catch block that `return null` / `return []` without logging is a candidate hider.
**Cue:** the fallback path has no telemetry — error is just lost.

### E4. catch가 에러의 실제 원인과 다른 코드/메시지로 재분류하고 있지는 않은가? (권한 오류를 '파일 없음'으로 보고 등)

**Evidence sources:** AST scan for `catch` bodies that `throw new X(...)` without including the original error as cause. Node 18+ supports `{ cause: e }` — absence of it in rethrow = re-classify risk.
**LLM judgment:** yes — inspect the rethrown type vs original to confirm semantic match.

### E5. 리소스 정리(cleanup)가 finally/dispose 패턴으로 보장되는가?

**Evidence sources:** AST scan — `try` blocks that allocate (fs.open / new Worker / execFile) without matching `finally` or `Symbol.dispose`/`Symbol.asyncDispose` usage.
**For CLI tools:** process exit cleans up most resources; for long-running code (LSP, workers), cleanup matters more.

### E6. 비동기 흐름에서 에러가 삼켜지지 않는가? (fire-and-forget Promise, unhandled rejection)

**Evidence sources:** AST scan for `CallExpression` that returns a Promise, NOT inside `await` / `.then(...)` / `.catch(...)` / `return`. Typical finder: grep for standalone `.foo()` calls where `foo` is async.
**Related:** `process.on('unhandledRejection')` present? If not, Node will warn at runtime; if yes, is it doing more than logging?

---

**Section E summary**: `[severity] — [one-sentence failure-handling characterization]`.

---

## F. Abstraction & tests

**Walk order**: F2 → F4 → F3 → F1. F2 has runtime-evidence as a partial anchor; F4 (mock boundary) uses test-file inventory; F3/F1 are pure judgment.

### F1. 추상화 수준은 적절한가? 과도하게 일반화되어 있거나, 반대로 반복을 견디지 못할 만큼 부족하지는 않은가?

**Evidence sources:** LLM judgment. Cue: a generic helper with 1 caller = over-abstract. A 5-line block repeated 4× = under-abstract.
**Related:** C7 barrel amplification and A3 helper zoo often interact.

### F2. 테스트는 happy path뿐 아니라 엣지 케이스, 실패 케이스, 계약 위반 상황까지 포함하고 있는가?

**Evidence sources:** `runtime-evidence.json` if coverage is available — branch coverage < 70% on critical modules → ❌ fix. Test file inventory: `tests/README.md` (generated) lists suites + per-suite description.
**Cue:** per-module test suite with < 5 assertions → likely happy-path-only.

### F3. 테스트가 구현 세부사항이 아니라 동작/계약을 검증하고 있는가? (내부 리팩터링 시 테스트가 같이 깨지면 구현에 결합된 것)

**Evidence sources:** LLM judgment — read test assertions. Cue: asserting on private function return shape = coupled; asserting on pipeline output JSON shape = contract-level.

### F4. mock 경계가 적절한가? (너무 깊이 mock하면 테스트가 통과해도 실제로는 안 되는 상황)

**Evidence sources:** LLM judgment — scan test files for `mock` / `stub` / `vi.mock` usage depth. Prefer real fixtures and public entrypoints for contract tests; reserve mocks for slow or external boundaries.

**Section F summary**: `[severity] — [one-sentence abstraction/test characterization]`.

---

## Anti-pattern one-liners

Quick scan — if any of these ring true, cite it at the top of the report before the per-item answers.

| Pattern | Detection |
|---|---|
| God object / mega interface | single file > 800 LOC with > 6 top-level concerns |
| Helper zoo | see A3 |
| Hidden shared state | module-level mutable `let` written from ≥ 2 call sites |
| Catch 후 무시 | see E2 |
| Fallback으로 상태 덮음 | see E3 |
| Shared shape drift | see B2 |
| 과분할 | see A4 |
| Boundary-없는 util 남용 | util/* with fan-in from every layer |
| Temporal coupling | functions must be called in order, no guard |
| Feature envy | `call-graph.json.moduleCallCount` asymmetry |
| Stringly-typed | see B2 |
| Barrel bomb | see C7 |

---

## Quick-decision helpers

Answer these five before the full walk when time is short:

1. **지금 당장 손댈 1순위는?** — pick the highest-severity `fix` item from sections C → E → A → B (in that order — boundary > failure > size > duplication).
2. **전체 구조를 망가뜨리는 중심 병목?** — usually one of: SCC > 2 nodes, or god-file with cross-cutting concerns, or barrel bomb on a hot path.
3. **수정 반경 대비 효과가 가장 큰 지점?** — pick the `fix` item with lowest touched-file count per severity.
4. **지금 고치지 않으면 이후 모든 변경 비용을 키우는 부분?** — boundary/contract drift items (C2 / D1 / B2).
5. **요구사항이 살짝 바뀌면 어떤 모듈이 먼저 깨지는가?** — the one with highest cross-submodule method edges (`level2-methods.json.crossSubmoduleMethod`).

---

## Output contract

The final report MUST contain:

- **HCA-1 — 30-second summary** (5 bullets, top anti-patterns if any)
- **HCA-2 — Decision points table** (only `fix` items with bucket + 근거)
- **HCA-3 — Evidence trail index** (artifact paths used)
- **Body: A / B / C / D / E / F sections** in order, every item answered or labeled `unknown`
- **Correction log** — if the scan revealed a claim from a prior audit that no longer holds.

Do not skip the unlabeled/unknown items. The purpose of the checklist is to make blind spots visible, not to cherry-pick.
