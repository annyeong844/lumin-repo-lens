# canonical/mode-contract.md

> **Role:** modes the skill operates in, when each is triggered, what each produces. The skill is a dispatcher; this file is the dispatch table.
> **Owner:** this file.

---

## 1. Modes

| Mode | Phase | Purpose | Default state in v1 |
|---|---|---|---|
| **pre-write** | P1 | before Claude writes new code, surface what already exists (owners / types / helpers / topology rules) | **primary** — enters on every "해줘"-class request |
| **post-write** | P2 | after Claude writes, check for regressions (shape duplicate, boundary violation, feature envy) | skeleton until P2 |
| **refresh** | P3 | periodic canon maintenance: observe new owners, generate draft canon, flag drift candidates | skeleton until P3; `generate-canon-draft.mjs` lives here |
| **structural-review** | existing | user asks "this repo 괜찮아?" → walk templates/REVIEW_CHECKLIST.md with grounded citations | existing; already shipped |
| **audit** (ad-hoc) | existing | user asks specific count ("dead export 몇 건") → run targeted scripts | existing; already shipped |

P1's pre-write is the newest, most important addition. The other shipped modes remain. New modes (post-write, refresh) are skeleton until their phase activates.

## 2. Dispatch — when does each mode enter?

### 2.1 pre-write triggers (P1)

Trigger **when all three hold**:

1. User request implies creating or modifying code in a repo context (see §3 vocabulary).
2. The current working directory is a repo (has `package.json` / `tsconfig.json` / `src/` tree).
3. The task may introduce **new symbols, files, helpers, types, or dependencies** — not just comment edits or doc fixes.

All three required. Two-out-of-three does not trigger pre-write.

### 2.2 Non-triggers — do NOT enter pre-write

- Conceptual explanation only ("이 코드 어떻게 동작해요?").
- Spec or doc review without code changes ("이 SPEC 어때요?").
- Prose rewrite ("README 다듬어줘").
- Fix a comment typo.
- Explain an error message without changing code.

If unsure, default to **no trigger**. A missed pre-write is recoverable; a friction-heavy false trigger erodes trust.

### 2.3 post-write triggers (P2, skeleton)

Trigger after Claude writes new exported symbols, moves files, or adds imports. Reads fresh fact model diff vs the pre-write snapshot.

### 2.4 refresh triggers (P3, skeleton)

Manual (`--refresh`) or cadence-based (every N sessions or N LOC added). Never mid-request.

### 2.5 structural-review and audit (existing)

Unchanged. Their contracts live in `SKILL.md` and `templates/REVIEW_CHECKLIST.md`.

## 3. Trigger vocabulary

Korean "해줘"-family triggers pre-write. English equivalents too. List must be aggressive because vibe-coders rarely spell out intent cleanly.

### 3.1 Korean (primary — user population)

```
만들어줘   구현해줘   추가해줘   고쳐줘   리팩터링해줘  리팩토링해줘
바꿔줘     수정해줘   버그 잡아줘   지워줘  빼줘
새로 짜줘   옮겨줘    이름 바꿔줘   분리해줘  통합해줘
연결해줘   연동해줘
```

### 3.2 English

```
add, create, implement, build, write, make, fix, patch,
refactor, rename, extract, inline, move, split, merge,
remove, delete, replace, update, modify
```

### 3.3 Modifier phrases (amplify confidence)

```
"이 기능", "이거", "여기에", "새로", "대신",
"this feature", "here", "instead", "also"
```

### 3.4 Guards (do-not-trigger)

```
"설명해줘"  "보여줘"   "찾아줘"   "찾아서"   "어떻게 해"  "괜찮아"
"explain", "show", "find", "how does", "how do", "is it ok"
```

When these appear **alone**, pre-write does not trigger even if other words do.

### 3.5 Compound requests — guard + verb still triggers

A guard word combined with a §3.1 / §3.2 verb is a write request. The verb wins. Examples that DO trigger pre-write:

```
"기존 helper 찾아서 연결해줘"   → "찾아서" + "연결해줘" — write intent (연결 = modify code). Triggers.
"이거 보여주고 바꿔줘"          → "보여주고" + "바꿔줘" — write intent. Triggers.
"dead code 찾아서 지워줘"       → "찾아서" + "지워줘" — write intent. Triggers.
"find and refactor"             → verb (refactor) wins. Triggers.
```

Examples that DO NOT trigger (guard-only):

```
"기존 helper 찾아줘"            → search intent only. No trigger.
"explain and show"              → pure inspection. No trigger.
"괜찮은지 보여줘"               → inspection. No trigger.
```

Rule: if ANY §3.1 / §3.2 verb appears alongside a guard, pre-write triggers. Guards suppress the trigger only when they appear without a write verb.

## 4. Mode interactions

- pre-write runs **before** Claude writes code. Output (owner hints, existing-helper list) is Claude's context for the write.
- post-write runs **after** Claude writes. Compares new state to pre-write snapshot.
- refresh runs **between** sessions; never during a user request.
- structural-review and audit are **user-initiated** and do not interact with pre-write/post-write.

A single user request typically activates: pre-write → Claude writes → post-write. refresh is orthogonal.

## 5. Deliverable contract per mode

Each mode must emit:

1. **A short summary** Claude uses directly (the "already exists" list, the "watch for" list).
2. **A machine artifact** for audit (JSON under `<output>/`).
3. **A citation trail** — every claim in (1) cites a field in (2) with the value read.

Modes that can't meet (3) are not yet ready to ship.

## 6. Mode failure semantics

If a mode's script fails (parse error, missing dependency, timeout):

- Emit `[확인 불가, mode: <mode>, reason: <text>]`.
- Do NOT silently proceed.
- Claude's follow-up response must include the failure in its narrative, not absorb it.

Failure is a fact; fake success is the worst outcome for this skill.
