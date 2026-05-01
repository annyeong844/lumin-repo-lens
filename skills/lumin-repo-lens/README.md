# Lumin Repo Lens

Evidence-backed TS/JS repo structure lens for coding assistants.

Current public plugin status: `0.9.0-beta.1`. The engine and plugin
surfaces are usable, but the Claude Code marketplace package is still in
public beta before a stable `1.0.0` line.

Lumin Repo Lens is an LLM-facing repo evidence engine for kind,
vibe-coder-friendly answers. The engine writes machine evidence; Claude
or another coding assistant reads it and explains what to do next
without making the user learn the internal engine vocabulary.

The deployable skill package exposes one shared engine, three shared
Claude Code skill surfaces, and one thin Codex wrapper:

- `skills/lumin-repo-lens/` — read-only audit, welcome, and
  refactor-plan coaching
- `skills/grounded-write-gate/` — pre-write plus post-write as one
  code-change transaction
- `skills/grounded-canon/` — canon-draft plus check-canon for maintainer
  validation
- `skills/lumin-repo-lens-codex/` — Codex-native wording over the same
  shared engine, with no Claude Code slash-command assumptions

Lumin Repo Lens is the public Claude Code plugin name, slash command
namespace, generated skill directory, and primary CLI name. The
`lumin-audit` and `grounded-audit` bins remain compatibility aliases for
older installs.

The shared runtime lives under `skills/lumin-repo-lens/`:

- `SKILL.md` — model-facing contract
- `scripts/audit-repo.mjs` — recommended public CLI wrapper
- `canonical/` — runtime canon spine used by the skill
- `templates/` — report and review templates
- `references/` — optional operating references
- `_engine/` — runtime internals used by the wrappers, not a public API

## Claude Code Plugin Install

Claude Code users should install the plugin-root package, not a loose
bundle of skill folders. From a maintainer checkout, build the package:

```bash
npm run build:plugin
```

That writes `dist/lumin-repo-lens-plugin/`. Use that directory, or a zip of
that directory, as the Claude Code plugin root. The package root
contains `.claude-plugin/`, `commands/`, and the generated
`skills/lumin-repo-lens/`, `skills/grounded-write-gate/`, and
`skills/grounded-canon/` surfaces. The Codex wrapper is excluded by default
to avoid Claude Code implicit-invocation overlap.

After the plugin is loaded, start with `/lumin-repo-lens:welcome` or run
the default `/lumin-repo-lens` slash command in a repository. The
package exposes these slash commands: `/lumin-repo-lens:audit`,
`/lumin-repo-lens:full`, `/lumin-repo-lens:pre-write`,
`/lumin-repo-lens:post-write`, `/lumin-repo-lens:canon-draft`,
`/lumin-repo-lens:check-canon`, and
`/lumin-repo-lens:refactor-plan`.

## Codex Native Skill Install

Codex can use the generated `skills/` surfaces directly. Prefer the
thin `$lumin-repo-lens-codex` wrapper as the Codex entrypoint; it points at
the shared `skills/lumin-repo-lens/` engine. Install by linking the generated
skill directories into Codex's skill discovery folder; do not copy the
folders by hand, because copies drift from the shared engine after
`git pull`.

Prerequisites:

- Git
- Node.js `^20.19.0 || >=22.12.0`

Runtime parser dependencies install automatically on first use. To turn
that off, set `LUMIN_REPO_LENS_NO_AUTO_INSTALL=1`.

Clone the repository:

```bash
git clone https://github.com/annyeong844/lumin-repo-lens.git ~/.codex/lumin-repo-lens
```

macOS / Linux:

```bash
mkdir -p ~/.codex/skills
ln -sfn ~/.codex/lumin-repo-lens/skills/lumin-repo-lens-codex ~/.codex/skills/lumin-repo-lens-codex
ln -sfn ~/.codex/lumin-repo-lens/skills/lumin-repo-lens ~/.codex/skills/lumin-repo-lens
ln -sfn ~/.codex/lumin-repo-lens/skills/grounded-write-gate ~/.codex/skills/grounded-write-gate
ln -sfn ~/.codex/lumin-repo-lens/skills/grounded-canon ~/.codex/skills/grounded-canon
```

Windows PowerShell:

```powershell
git clone https://github.com/annyeong844/lumin-repo-lens.git "$env:USERPROFILE\.codex\lumin-repo-lens"
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.codex\skills" | Out-Null
cmd /c mklink /J "%USERPROFILE%\.codex\skills\lumin-repo-lens-codex" "%USERPROFILE%\.codex\lumin-repo-lens\skills\lumin-repo-lens-codex"
cmd /c mklink /J "%USERPROFILE%\.codex\skills\lumin-repo-lens" "%USERPROFILE%\.codex\lumin-repo-lens\skills\lumin-repo-lens"
cmd /c mklink /J "%USERPROFILE%\.codex\skills\grounded-write-gate" "%USERPROFILE%\.codex\lumin-repo-lens\skills\grounded-write-gate"
cmd /c mklink /J "%USERPROFILE%\.codex\skills\grounded-canon" "%USERPROFILE%\.codex\lumin-repo-lens\skills\grounded-canon"
```

Restart Codex after installing. The skills should appear as
`$lumin-repo-lens-codex`, `$lumin-repo-lens`, `$grounded-write-gate`, and
`$grounded-canon`. In Codex, start with `$lumin-repo-lens-codex`.

## Quick Start

In the generated skill package, use the public wrapper:

```bash
node scripts/audit-repo.mjs --root <repo> --output <dir>
```

## Conservative Evidence Boundaries

Function clone cues are review cues, not semantic-equivalence claims.
The producer favors low false positives: it groups exported top-level
functions and helpers by exact or same-structure evidence, then adds
near-function review candidates when structurally different helpers share
important call tokens and similar size/name signals. Treat every clone
cue as "not proven until source review," not as proof that functions are
safe to merge.

Shape index is exact. It groups structural shapes only when normalized
field names and normalized type text match; nullable or widened types
such as `email: string` versus `email: string | null` intentionally land
in different groups. Use shape evidence as a grounded consolidation
signal, not as a semantic subtype or compatibility proof.

Audit output is intentionally artifact-rich. Start from `audit-summary.latest.md`, `manifest.json`, and `checklist-facts.json`,
then open raw JSON artifacts only for the claim being cited. The summary
is an artifact map; the assistant still curates the final answer instead
of pasting every generated file back to the user. When `topology.json`
is present, `<output>/topology.mermaid.md` is also written as a compact
human visual companion for cross-submodule edges, runtime cycles, and hub
files. It is capped for readability and remains secondary to `topology.json`
for exact citations.

## Artifact Privacy

By default, Lumin Repo Lens writes artifacts to `<repo>/.audit/`. These
files may include repository structure, file paths, symbol names, and
analysis metadata. Add `.audit/` to `.gitignore` unless you intentionally
want to commit audit artifacts, or pass `--output <dir>` to write them
outside the repository.

On first use, the wrapper checks the supported Node range and runtime
packages. If `node_modules/` is missing in the generated skill package,
it attempts one local setup pass with `npm ci --omit=dev --ignore-scripts --no-audit --fund=false`
and then continues. If that cannot run, it prints the exact setup command
instead of failing later with a parser import error.
Set `LUMIN_REPO_LENS_NO_AUTO_INSTALL=1` to disable automatic setup and run
the printed command manually. The older `GROUNDED_AUDIT_SKIP_AUTO_INSTALL=1`
alias is still accepted for compatibility but is deprecated.

If installed through the package bin, the same path is:

```bash
lumin-repo-lens --root <repo> --output <dir>
```

The older `lumin-audit` and `grounded-audit` bins remain available as
compatibility aliases.

The CLI's technical default audit profile is `quick`. For Claude Code
chat use, the intended cadence is richer: first pass, stale/missing
artifacts, explicit audit/review, due diligence, large refactor planning,
or post-refactor review should run `--profile full`; small follow-up
checks over an existing fresh baseline can use `--profile quick`. Full
adds call graph, barrel discipline, shape-index evidence, exported
function-clone cues, and optional runtime/staleness signals.

For vibe-coding sessions, keep the human-facing answer light even when
the first pass uses full evidence. The assistant reads the summary plus
relevant raw artifacts, walks the checklist internally, and keeps
detailed JSON behind the scenes until a claim needs proof. The intended
human surface is friendly and low-friction; the senior-grade evidence is
there for the model or reviewer to cite when needed.

Maintainer checkouts may also run the root orchestrator directly:

```bash
node audit-repo.mjs --root <repo> --output <dir>
```

Audit profiles write `<output>/audit-summary.latest.md` next to the JSON
artifacts, plus `<output>/topology.mermaid.md` when topology data exists.
Treat the summary as an artifact map and the Mermaid file as a visual
aid, not ranked recommendation or citation authority. For chat-facing
summaries, the assistant should read `manifest.json` plus the relevant
raw artifacts directly, then choose what matters for the user's question.

Full and CI profiles also write `<output>/audit-review-pack.latest.md`.
That file is a main-controller artifact brief for deep reviews. It does
not call any model or API by itself. In Claude Code, the main assistant
reads the lanes; if it uses built-in reviewer subagents, it should turn a
lane into a focused codebase-reading assignment with concrete files,
symbols, or hypotheses. Subagents should inspect repository files
directly and report file:line evidence, not trust checklist or artifact
summaries.

## Capabilities

All stable user-facing flows go through the orchestrator:

```bash
# audit
node scripts/audit-repo.mjs --root <repo> --output <dir>

# pre-write gate
node scripts/audit-repo.mjs --root <repo> --output <dir> --pre-write --intent intent.json
# or stream the same JSON through stdin:
# node scripts/audit-repo.mjs --root <repo> --output <dir> --pre-write --intent -

# post-write delta
node scripts/audit-repo.mjs --root <repo> --output <dir> --post-write --pre-write-advisory advisory.json

# canon draft
node scripts/audit-repo.mjs --root <repo> --output <dir> --canon-draft --sources type-ownership,naming

# canon drift
node scripts/audit-repo.mjs --root <repo> --output <dir> --check-canon --sources all

```

Stable capabilities:

- `audit`
- `pre-write`
- `post-write`
- `canon-draft`
- `check-canon`

When loaded as a Claude Code plugin, these are also available as
namespaced slash commands:

- `/lumin-repo-lens` — one-click baseline-aware repo lens pass for the
  current workspace; it should run without asking you to pick a mode
- `/lumin-repo-lens:audit`
- `/lumin-repo-lens:full` — one-click full profile audit
- `/lumin-repo-lens:welcome`
- `/lumin-repo-lens:pre-write`
- `/lumin-repo-lens:post-write`
- `/lumin-repo-lens:canon-draft`
- `/lumin-repo-lens:check-canon`
- `/lumin-repo-lens:refactor-plan`

Start with `/lumin-repo-lens:welcome` if you are unsure which
path to use. It does not run a scan; it gives a short, non-jargony
choice between checking the repo now, checking before coding, or making
a gentle refactor plan.

For chat use, `pre-write` should accept natural language. Say what you
want to change; the assistant infers the compact intent internally and
streams it through `--intent -`. The explicit intent JSON shape is for
automation, debugging, and reproducible tests.

The slash commands are thin delegators: they load the relevant surface
`SKILL.md`, then load the shared
`skills/lumin-repo-lens/references/command-routing.md`, and
route to the same public `scripts/audit-repo.mjs` entrypoint. They do
not create a second execution path. `pre-write` and `post-write` share
the `grounded-write-gate` surface because post-write consumes the
pre-write advisory from the same change. `canon-draft` and
`check-canon` share the `grounded-canon` surface because draft and drift
belong to one promotion lifecycle. `refactor-plan` stays on the audit
surface because it is a coaching/reporting command: it
has no `audit-repo.mjs --refactor-plan` engine flag, producer, or JSON
artifact of its own. It runs the audit evidence path, then translates
the cold gates into an incremental refactoring plan using
`references/refactor-plan-policy.md` plus
`templates/refactor-plan-template.md`. For larger cleanup work, use it as a loop: collect a baseline, let the model write a semantic phase plan, hand the first code-changing slice to `pre-write`, implement one phase, run `post-write`, then rerun a scoped quick audit over that phase's touched area plus transitive consumers.

The public surface is intentionally plain: the assistant should answer
with what is stable, what to smooth next, and how to verify. The cold
counts, JSON artifacts, scan ranges, and maintainer details stay on disk
for proof, debugging, CI, or reviewer handoff.

`pre-write` is intentionally lighter than an audit. When it is the only
requested lifecycle mode, the orchestrator skips the base quick profile
and lets the pre-write child build only the artifacts implied by the
intent. Use `audit` separately when you want a repository-wide evidence
pass.

## Best Fit

This skill is sharpest on TypeScript / JavaScript monorepos that use:

- npm, pnpm, yarn, or Bun workspaces
- `package.json#exports`, including subpath exports and conditional
  `types` / `import` / `default` targets
- `package.json#imports` / Node `#imports`
- tsconfig `paths` aliases, including per-app aliases
- package public API surfaces through `main`, `module`, `browser`,
  `types`, `typings`, and `bin`

Public package entrypoints are protected by the `publicApi_FP23`
policy, so exports reachable only through package public surface are
muted instead of shown as cleanup candidates.

The pre-write gate also checks planned file names against sibling
prefix clusters. For example, a planned `lib/cardNewsService.js` can be
new while still warning that `lib/cardNews*` already has several owner
files. This is a domain-level hint for feature requests where the exact
symbol name is not enough.

P4 shape matching is exact by design. Automation can provide
`shape.typeLiteral` or `shape.hash` in pre-write intent for grounded
shape matches. Loose
`fields` arrays are preserved as intent evidence, but they do not become
structural-equality claims. See
`references/pre-write-intent-shape.md` for the machine-readable intent
shape.

Expect lower confidence on custom runtime resolvers, computed dynamic
imports, framework conventions not listed in `references/`, or
generated files without detectable generated-file evidence.

Root sibling scripts such as `build-symbol-graph.mjs`,
`measure-topology.mjs`, `generate-canon-draft.mjs`, `check-canon.mjs`,
and `rank-fixes.mjs` remain available in the maintainer repository for
engine development and narrow reproducer work. They are intentionally
not the preferred user-facing interface.

Internal engine entrypoints are documented for maintainers only; users
should start from `scripts/audit-repo.mjs` or `lumin-repo-lens`.

## Build The Skill Package

This section is for maintainer checkouts. If you are reading this file
inside `skills/lumin-repo-lens/`, the skill package has already
been generated and `npm run build:skill` is not available there.

Do not distribute the maintainer repo root directly. From the maintainer
checkout, generate the skill package surface first:

```bash
npm run build:skill
```

To stage a Claude Code plugin-root package, run:

```bash
npm run build:plugin
```

That writes `dist/lumin-repo-lens-plugin/` with `.claude-plugin/`,
`commands/`, and the generated Claude Code skill surfaces. The Codex
wrapper is excluded by default to avoid Claude Code implicit-invocation
overlap; pass `node scripts/build-plugin-package.mjs --include-codex`
only for a mixed local bundle.

There are two package shapes:

- Skill directory only: `skills/lumin-repo-lens/` or a zip of
  that directory. This is enough when the host only needs the read-only
  audit/refactor-plan surface and shared CLI runtime.
- Claude Code plugin zip: repo root with plugin metadata and commands.
  For this shape, the package root must include:

- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `commands/*.md`
- the generated `skills/lumin-repo-lens/` directory
- the generated `skills/grounded-write-gate/` directory
- the generated `skills/grounded-canon/` directory
- optionally, the generated `skills/lumin-repo-lens-codex/` Codex wrapper

Do not zip the contents of `skills/` as the archive root when shipping
the three sibling surfaces together. A zip whose root is
`lumin-repo-lens/`, `grounded-write-gate/`, and `grounded-canon/`
is a skill-folder bundle, not a Claude Code plugin package; sibling
paths such as `${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/...`
assume the plugin-root shape above.

The generated `skills/lumin-repo-lens/` directory contains the
shared audit skill files, five public script wrappers, `_engine/`
runtime internals, the runtime canon spine, `templates/`, and selected
`references/`. The generated sibling skill directories contain lean
`SKILL.md` files that point back to the shared engine. The generated
package excludes tests, history, lab corpora, generated drafts, review
outputs, and maintainer self-audit fact snapshots such as
`type-ownership.md`, `helper-registry.md`, `topology.md`, and
`naming.md`.

## Maintainer Map

These docs exist in the maintainer repository and are not part of the
generated skill package. In a maintainer checkout, look under:

- `docs/README.md`
- `docs/product-surface.md`
- `docs/internal-engine.md`
- `maintainer history notes`
- `maintainer spec notes`
- `docs/lab/README.md`

Reproducible lab artifacts such as `canonical-draft/`, `output/`,
`review-output*/`, `p6-corpus/`, `audit-artifacts/`, optional `.audit/`,
and local tool state such as `.claude/` are maintainer surfaces, not
public skill entrypoints.

When auditing this maintainer checkout itself, `audit-repo.mjs`
automatically excludes lab/corpus/generated mirror directories and records
them in `manifest.scanRange.autoExcludes`. Pass
`--no-self-audit-excludes` only for an intentional whole-repo scan.

## Maintainer Checks

The skill-triggering harness is maintainer-only. It verifies prompt and
expectation metadata offline without invoking a model:

```bash
npm run check:skill-triggering
```

The saved-answer behavior harness is also offline. It does not rank audit
findings or call a model; it checks representative final answers for
answer-level regressions such as internal jargon leaks, overclaiming
review-only findings, or treating `audit-summary.latest.md` ordering as
the final recommendation:

```bash
npm run check:behavior
```

Live trigger sweeps require a Claude CLI environment and are intentionally
opt-in:

```bash
./test-harness/run-all.sh
```

These evaluation files are intentionally not included in the deployable
skill directory. A skill-only archive can run the audit engine, but it
cannot reproduce the maintainer evaluation campaign without the source
checkout.
