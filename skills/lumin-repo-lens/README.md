# Lumin Repo Lens

> 🇰🇷 **한국어로 읽으시려면 → [README.ko.md](./README.ko.md)** &nbsp;·&nbsp; 🇬🇧 English continues below.

> **The kind little buddy that says *"this already exists"* before you write it again.**
> *Your repo's companion for vibe-coding sessions.*

![Node](https://img.shields.io/badge/node-%E2%89%A520.19-green)
![Type](https://img.shields.io/badge/TS%2FJS-monorepo--friendly-blue)
![Tone](https://img.shields.io/badge/tone-kind-ff69b4)

---

## Sound familiar? 😅

You ask AI:

> *"Make me a card-news service"*

AI happily spins up a new file → `lib/cardNewsService.js` ✨
But your repo already had three similar files in `lib/cardNews/`. 😱

With `lumin-repo-lens` riding along, Claude can say first:

> 🛑 *"Wait — there are already 3 similar files under `lib/cardNews*`. Want to look before making a new one?"*

Real evidence from your actual repo, not guesses.

---

## First useful run

**1. Add the marketplace and install the plugin in Claude Code**

```
/plugin marketplace add annyeong844/lumin-repo-lens
/plugin install lumin-repo-lens@annyeong844-marketplace
/reload-plugins
```

**2. Run the full first checkup**

```
/lumin-repo-lens:full
```

→ This turns on the parts that make Lumin more than a dead-export sorter:
shape index, function-clone cues, call graph, barrel discipline, topology,
public-surface policies, and the grounded review profile.

**3. Use the write gate when you are about to change code**

```
/lumin-repo-lens:pre-write
# code the change
/lumin-repo-lens:post-write
```

Claude Code infers the compact intent internally. You do not need to write
the intent JSON by hand.

> 💡 First run installs parser dependencies once (~30 seconds). After that, fast.
> For tiny follow-up checks after a fresh baseline, `/lumin-repo-lens` uses the quick path.

For very large repos, do not auto-trigger full profile on every edit. Run
`:full` once per branch, first checkup, or major refactor review, then use
pre-write/post-write and quick follow-ups during the agent loop.

---

## Who is this for?

### ✅ Great fit if you

- code alongside AI and **your repo is getting messy**
- watch AI **rewrite functions that already exist**
- want to **verify what changed after a refactor**
- work in TypeScript / JavaScript, including monorepos

### ❌ Not a fit (yet) if you

- mainly write Python / Rust / etc. *(Go is partially supported)*
- don't use AI coding tools *(this exists to give your AI evidence)*
- have a 1–2 file mini project *(the audit value won't show up)*

---

## Core commands

| Command | When to use |
|---|---|
| `/lumin-repo-lens:full` | Full evidence profile — first checkup, post-refactor review, shape/function-clone/call/topology evidence |
| `/lumin-repo-lens:pre-write` | Check *before* coding. Ask naturally; the assistant infers the compact intent internally. |
| `/lumin-repo-lens:post-write` | Verify *after* coding — *"did my change ripple anywhere else?"* |
| `/lumin-repo-lens` | Quick baseline-aware repo lens pass for small follow-up checks over fresh artifacts |
| `/lumin-repo-lens:refactor-plan` | Turn evidence into a cautious cleanup plan |
| `/lumin-repo-lens:welcome` | Get a gentle first-use menu |

Maintainers can also use `/lumin-repo-lens:canon-draft` and
`/lumin-repo-lens:check-canon` for canon lifecycle work.

First pass, stale or missing artifacts, explicit review, due diligence,
large refactor planning, and post-refactor review should run `--profile full`.
Small follow-up checks over a fresh baseline can use the quick path.

---

<details>
<summary><b>📦 Other install options</b></summary>

### Run the packaged CLI from a clone

In the generated skill package, use the public wrapper:

```bash
git clone https://github.com/annyeong844/lumin-repo-lens.git
cd lumin-repo-lens
node skills/lumin-repo-lens/scripts/audit-repo.mjs --root <repo>
```

### Skip auto-install of parser deps

```bash
LUMIN_REPO_LENS_NO_AUTO_INSTALL=1 node skills/lumin-repo-lens/scripts/audit-repo.mjs --root <repo>
```

With this set, the tool prints the exact install command instead of running it for you.

The automatic setup command is `npm ci --omit=dev --ignore-scripts --no-audit --fund=false`.

Stable validation modes are `audit`, `pre-write`, `post-write`, `canon-draft`,
and `check-canon`.

### Codex-native install

Codex users can use the `$lumin-repo-lens-codex` wrapper, which points at the shared engine.

```bash
git clone https://github.com/annyeong844/lumin-repo-lens.git ~/.codex/lumin-repo-lens
```

**macOS / Linux**

```bash
mkdir -p ~/.codex/skills
ln -sfn ~/.codex/lumin-repo-lens/skills/lumin-repo-lens-codex ~/.codex/skills/lumin-repo-lens-codex
ln -sfn ~/.codex/lumin-repo-lens/skills/lumin-repo-lens ~/.codex/skills/lumin-repo-lens
ln -sfn ~/.codex/lumin-repo-lens/skills/lumin-repo-lens-write-gate ~/.codex/skills/lumin-repo-lens-write-gate
ln -sfn ~/.codex/lumin-repo-lens/skills/lumin-repo-lens-canon ~/.codex/skills/lumin-repo-lens-canon
```

**Windows PowerShell**

```powershell
git clone https://github.com/annyeong844/lumin-repo-lens.git "$env:USERPROFILE\.codex\lumin-repo-lens"
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.codex\skills" | Out-Null
cmd /c mklink /J "%USERPROFILE%\.codex\skills\lumin-repo-lens-codex" "%USERPROFILE%\.codex\lumin-repo-lens\skills\lumin-repo-lens-codex"
cmd /c mklink /J "%USERPROFILE%\.codex\skills\lumin-repo-lens" "%USERPROFILE%\.codex\lumin-repo-lens\skills\lumin-repo-lens"
cmd /c mklink /J "%USERPROFILE%\.codex\skills\lumin-repo-lens-write-gate" "%USERPROFILE%\.codex\lumin-repo-lens\skills\lumin-repo-lens-write-gate"
cmd /c mklink /J "%USERPROFILE%\.codex\skills\lumin-repo-lens-canon" "%USERPROFILE%\.codex\lumin-repo-lens\skills\lumin-repo-lens-canon"
```

Restart Codex after installing. In Codex, start with `$lumin-repo-lens-codex`.

</details>

<details>
<summary><b>⚙️ How does the buddy work?</b></summary>

The tool **scans your repo and collects facts (evidence) only.**
*Judgment* is what your AI does after *reading* those facts.

```
Your repo  →  lumin-repo-lens (cold evidence)  →  AI buddy explains kindly
                       ↑                                  ↑
                    machine                             human
```

The two-stage split is on purpose:

- AI **doesn't answer with guesses** — it cites the evidence
- You **don't have to read JSON yourself** — the buddy translates it
- You can **inspect the evidence directly** when you want — it lives in `<repo>/.audit/`

</details>

<details>
<summary><b>❓ FAQ</b></summary>

**Q. Can I use it without AI, just as a CLI?**
Yes — from a clone, run `node skills/lumin-repo-lens/scripts/audit-repo.mjs --root <repo>`. It writes JSON evidence files, a summary markdown, and a Mermaid topology diagram (when topology data exists). The Mermaid file is a compact human visual companion for cross-submodule flows, cycles, and hub files; precise citations still go through `topology.json`.

**Q. Why does it install npm packages on first run?**
To analyze your repo, it needs parser libraries. They're auto-installed once and cached. Disable with `LUMIN_REPO_LENS_NO_AUTO_INSTALL=1`.

**Q. What gets created in my repo?**
JSON evidence files, a summary markdown, and topology Mermaid (when applicable) under `<repo>/.audit/`. Add `.audit/` to `.gitignore` if you don't want them committed.

These artifacts may include repository structure, file paths, symbol names, and
analysis metadata.

**Q. My repo is large — is it slow?**
For 200–300 files: *quick* profile takes ~10–20 seconds; *full* profile takes 30 seconds to a minute. Start with quick.

**Q. What are the main evidence limits?**
Function-clone cues are review cues, not semantic-equivalence claims. They include exact body, same-structure, same-signature, and near-function evidence when the full profile has `function-clones.json`. Shape index is exact: nullable or widened types such as `email: string` versus `email: string | null` intentionally land in different groups. Start from `audit-summary.latest.md`, `manifest.json`, and `checklist-facts.json`, then open raw JSON artifacts only for the claim being cited.

**Q. Does pre-write understand semantic duplicates?**
No. Pre-write does not claim semantic equivalence from names alone. It surfaces grounded facts such as exact symbol/file matches, exact shape hashes, and exact function signature hashes, then separates weaker agent-review cues from muted token noise.

Exact normalized body-hash cueing is deferred until a body-hash lane exists in the lookup artifacts. When two helpers only share a common verb such as `create`, the default chat surface stays quiet and the muted cue remains in JSON diagnostics.

**Q. Why can post-write feel as expensive as a quick scan?**
Post-write refreshes the after-snapshot before comparing it to the matching pre-write advisory, so small edits can still pay the repository walk cost. Reusing the same `--output` keeps artifacts together; an incremental post-write cache is planned, but the current default favors a fresh comparison over a stale clean result.

**Q. Does it call a model or subagent by itself?**
No. Full and CI profiles may write `audit-review-pack.latest.md`, but that file does not call any model or API by itself. In Claude Code, the main assistant can turn a lane into a focused codebase-reading assignment. Subagents should inspect repository files directly and report file:line evidence.

</details>

<details>
<summary><b>🔧 Maintainer / build / contributing</b></summary>

This section is for maintainer checkouts. If you installed the plugin or use the published package, you don't need anything here.

### Build the deployable packages

```bash
npm run build:plugin     # writes dist/lumin-repo-lens-plugin/ (Claude Code plugin root)
npm run build:skill      # writes the skill-only directory shape
```

### Maintainer checks

The skill-triggering harness is maintainer-only.

```bash
npm run ci                       # full check pass
npm run check:skill-triggering   # offline prompt/expectation lint
npm run check:behavior           # offline answer-level regression check
./test-harness/run-all.sh        # live trigger sweeps (requires Claude CLI; opt-in)
```

### Maintainer repo map

- `docs/README.md` — entrypoint
- `docs/product-surface.md` — what's user-visible
- `docs/internal-engine.md` — how the engine is shaped internally
- `maintainer history notes`, `maintainer spec notes`, `docs/lab/README.md` — phase history, specs, labs

Lab outputs (`canonical-draft/`, `output/`, `review-output*/`, `p6-corpus/`, `audit-artifacts/`, `.audit/`, `.claude/`) are maintainer-only and not part of the deployable skill package.

Root sibling scripts are internal engine entrypoints. They are intentionally
not the preferred user-facing interface; start from the plugin commands or
`skills/lumin-repo-lens/scripts/audit-repo.mjs` instead.

### Conservative evidence boundaries

Function-clone cues are review cues, not semantic-equivalence proofs; same-signature groups mean "same exported function type contract", not "same behavior". Shape-index matching is exact (a `string` and a `string | null` field intentionally land in different groups). For the operational gates that keep dead-code, shape, and barrel claims grounded, see `references/false-positive-index.md` and `references/operational-gates.md`.

### Public beta

The Claude Code marketplace package is in public beta before a stable `1.0.0` line. Expect occasional cleanup commits. The engine and plugin surfaces are usable today.

</details>

---

## Repo / License

- Repo: [github.com/annyeong844/lumin-repo-lens](https://github.com/annyeong844/lumin-repo-lens)
- License: [MIT](./LICENSE)
- Bugs / suggestions: [Issues](https://github.com/annyeong844/lumin-repo-lens/issues)

---

> 💌 *This buddy doesn't scold. It knocks gently and says "could you take a look at this?"*
