# canonical/invariants.md

> **Role:** the small set of claims that must remain true across every phase, every mode, every session. If an implementation violates an invariant here, the implementation is wrong — not the invariant.
> **Owner:** this file.

---

## 1. Iron Law

```
NO STRUCTURAL CLAIM WITHOUT MACHINE EVIDENCE
NO ABSENCE CLAIM WITHOUT STATED SCAN RANGE
```

- A structural claim is any assertion about count, ownership, direction, presence, or absence of something in the codebase.
- A scan range is the explicit set of files / languages / directories examined. "Checked all `*.mjs` except `node_modules/` and `_engine/lib/vocab.mjs`, 0 hits for pattern `TAINT.*_MATCH`" is a valid scan range. "I looked around and didn't see it" is not.
- Violating the letter of this rule is violating the spirit of this rule. No "probably", "seems", or "대략" without the `[degraded, confidence: ...]` label.

## 2. Role separation

**The skill emits evidence. Claude makes scoped claims from it.**

- Scripts compute grounded facts; they never opine.
- Claude reads facts + optional LLM judgment + canonical context → produces claims at appropriate confidence.
- No script field is a claim by itself. `fix-plan.json.summary.SAFE_FIX = 2` is a fact; "2 symbols are safely removable" is a claim Claude makes after considering runtime / staleness / resolver blindness.

## 3. Tier ≠ claim

A script tier (Tier C, SAFE_FIX, ❌ fix gate) is raw evidence, not a verdict.

- Tier C means "no consumer was found in the constructed graph", not "this symbol is definitely dead".
- SAFE_FIX means "mechanical removal is plausible given the current evidence set", not "remove this now".
- ❌ fix gate means "threshold exceeded", not "this is broken".

When resolver blindness, parse errors, missing coverage, or short staleness windows are elevated, Claude must **downgrade the claim** rather than propagate the raw tier. This is tested by the `finding-local-provenance` layer — the infrastructure exists; the invariant is that Claude actually uses it.

## 4. Four failure modes the skill exists to prevent

Vibe-coders' LLM sessions rot the codebase in four specific ways. Every skill feature must trace back to preventing at least one of these.

1. **LOC explosion with feature stagnation.** Claude invents a new helper because it did not know the existing one. `formatDate`, `formatDateTime`, `dateFormat`, `formatTimestamp` co-exist.
2. **Duplicate blobs.** Same shape, same logic, re-implemented across files. `UserInfo` / `UserData` / `UserProfile` co-exist with near-identical fields. Exact shape evidence requires the P4 shape-index path (`build-shape-index.mjs`, available in `--profile full` and in pre-write when a validated `shape-index.json` exists); the default `quick` profile must not claim this coverage.
3. **Dependency knots.** Import direction drifts across sessions; cycles form that a human would never design.
4. **Boundary collapse.** Layer rules ignored; feature envy; `_engine/lib/` reaching into app code.

## 5. Common cause

All four failure modes have the same root cause:

> **Claude did not know what already existed.**

Context windows overflow at ~20k symbols. A session can't hold the whole symbol graph. So Claude invents what it cannot see. The skill's job is to make the existing state **retrievable on demand, before new code is written**.

## 6. Optimization target (single line)

```
Before writing new code, make Claude aware of what already exists.
```

Every feature this skill ships must serve this line. If a feature doesn't shorten the path from "Claude about to write X" to "Claude knowing whether X exists", it is not a priority.

## 7. What this skill is NOT

- Not a code-writer. It observes; it does not propose edits to source files.
- Not a refactor tool. It flags; it does not rewrite.
- Not a canon author. It drafts from observation; a human or LLM promotes drafts to canon.
- Not a blocker. pre-write gate advises; it does not veto. Claude retains authority to write code that contradicts the gate's advice — but must cite the override reason.
- Not a coverage metric. The structural review checklist and the fact model permit `[확인 불가]` as a first-class answer. Half the items being unknown is normal.

## 8. Honesty over completeness

If two of the above invariants conflict in a specific case, honesty (scan range, degraded label, confidence downgrade) wins. Claims that fit the template but don't reflect the evidence break the skill more than unanswered items do.

## 9. `any` is a canonical blind zone for semantic analysis — but structural analysis survives

Vibe-coder repos are `any` / `as any` heavy. Structural analysis (names, imports, ownership, fan-in) still works on contaminated identities; **semantic analysis (shape comparison, type contracts, safe-reuse claims) does not**. See `canonical/any-contamination.md` for the full rule set.

Three sub-invariants drawn from that file that everything else in this skill inherits:

- **`any` ≠ `unknown`**. `any` is an escape hatch. `unknown` is a safe boundary type requiring narrowing. Never conflate them; punishing `unknown` in the name of type safety teaches the wrong lesson.
- **No silent new `any`**. When post-write detects newly-introduced `any` / `as any` / `as unknown as T` / JSDoc `{any}` / `@ts-ignore` / `@ts-expect-error` / `no-explicit-any` disable, Claude's final response MUST cite each new escape with file + line + reason, or remove them before completing the task. The skill does not veto; it makes the introduction visible. The full enumeration of tracked escape kinds is in `canonical/fact-model.md` §3.9 `type-escape.escapeKind`; this list mirrors that field's value set.
- **Missing return annotation is NOT `any`**. TypeScript inference is a feature, not contamination. `function add(a: number, b: number) { return a + b }` is fine. True implicit-`any` requires a TS semantic pass; without a checker, emit `[확인 불가]`, do not guess.
