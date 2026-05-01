# canonical/index.md

> **Role:** table of contents for the canonical spine. This file is the entry point when a new session needs to learn what is invariant in this skill.
> **Owner:** this file.

---

## 1. What this set is

The canonical spine defines **what must remain true** about this skill. Implementation (scripts, modes, phases) can change freely; canonical invariants cannot without a spec revision.


## 2. Files

| File | Topic | Read when |
|---|---|---|
| `index.md` | this file | session boot |
| `invariants.md` | Iron Law, failure modes, optimization target | every session |
| `mode-contract.md` | modes, trigger dispatch, trigger vocabulary, guards | every session touching user intent |
| `pre-write-gate.md` | P1 protocol — "before writing code, find what exists" | any P1 work or new-code session |
| `fact-model.md` | fact types (owner, identity, shape, topology, watchpoint) + required metadata | P1–P4 |
| `identity-and-alias.md` | import/re-export alias preservation, identity keying, barrel ≠ owner | P1 (pre-write lookup), P3 (canon draft) |
| `classification-gates.md` | duplicate / single-identity classification ordering with fixed precedence | P3 (canon draft), P4 (shape duplication) |
| `any-contamination.md` | how the skill handles `any`/`as any`/implicit-any; semantic vs structural analysis boundary | P1 (pre-write shape lookup), P3 (canon draft), P4 (shape duplication) |
| `canon-drift.md` | formal drift categories, parser contract, `canon-drift.json` shape | P5 (check-canon drift detector) |

## 3. Reading order by goal

- **"I am implementing P1 (v1 — label-free advisory)"**: `invariants.md` → `mode-contract.md` → `pre-write-gate.md` → `fact-model.md` → `identity-and-alias.md` → `any-contamination.md`. Classification labels (`single-owner-strong`, `DUPLICATE_STRONG`, `severely-any-contaminated`, etc.) are NOT surfaced in P1 v1 output; raw fan-in + contamination measurements are shown instead. `classification-gates.md` not required.
- **"I am implementing P1 (v2 — label-surfaced advisory)"**: add `classification-gates.md` to the P1 v1 list. Required as soon as P1 advisory emits any label from `classification-gates.md` §9.
- **"I am implementing P3 canon draft"**: `invariants.md` → `fact-model.md` → `identity-and-alias.md` → `classification-gates.md` → `any-contamination.md`.
- **"I am implementing P4 shape duplication"**: `invariants.md` → `fact-model.md` → `classification-gates.md` → `any-contamination.md` (critical — shape hash must exclude contaminated identities).
- **"I am implementing P5 check-canon drift detector"**: `invariants.md` → `fact-model.md` §7 → `canon-drift.md` (category enum + parser contract + JSON shape) → `classification-gates.md` §9/§10.3/§11.4/§12.3 (label sets the parser validates against) → `identity-and-alias.md` §2 (identity format for type/helper drift).
- **"I am reviewing a spec"**: all of the above; they are each short by design.


## 4. How to change the spine

1. Propose the change with a reason: new invariant, renamed invariant, or skeleton promotion.
2. Show which phase depends on the change.
3. Update the affected phase's `Boot:` line.
4. Amend `index.md` file list.

No canonical file is edited silently.
