# Slash Command Routing

Claude Code command files are thin delegators. They pass a mode and raw
arguments here; this reference owns the user-facing behavior.
Read this file before acting on any `/lumin-repo-lens...` slash
command. It is runtime routing, not optional background context.

## Shared Rules

- Read the command-selected `SKILL.md` first. Audit/default/welcome/
  refactor-plan commands use `lumin-repo-lens`; pre/post use
  `lumin-repo-lens-write-gate`; canon-draft/check-canon use `lumin-repo-lens-canon`.
- Use the generated package wrapper:
  `node ${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/scripts/audit-repo.mjs`.
- If `--root` is omitted, use the current workspace root.
- If `--output` is omitted, use `<root>/.audit`.
- One public voice: kind, plain, short, and action-first.
- Role boundary: this is an LLM-facing evidence engine. The assistant
  reads cold artifacts; the human receives a plain next-step answer.
  Do not make the human carry the tool's internal vocabulary unless
  they ask for proof, CI detail, or maintainer/debug context.
- Engine output is exhaustive by design — every escape kind, every
  label, every JSON dot-path. The chat answer is the curated layer
  over that: read engine text cold, write headline-grade. Pasting
  engine output verbatim is a sign to recompose, not to ship.
- Keep raw JSON, FP ids, tier labels, HCA/P-phase jargon, and long
  artifact field paths out of chat unless the user asks for exact proof,
  maintainer/debug detail, CI output, or a formal report.
- Cold artifacts are the source of truth. `audit-summary.latest.md` is
  only an artifact map; do not inherit its ordering as the final answer.
  Read `manifest.json` and the relevant raw artifacts directly, then
  translate the result into what the user can do next.
- Living audit documents are controller-authored. If the target repo
  already has `docs/current/audit/lumin-structural-audit.md`,
  `LUMIN_REPO_LENS.md`, `LUMIN_AUDIT.md`, or `TECH_DEBT_AUDIT.md`, read it before the final
  audit answer and update it after reading raw artifacts. Create a new
  living document only when the user asks for tracking, a continuing
  audit log, or a living document. Use
  `templates/living-audit-template.md`.
- For the default command with empty arguments, the user has already
  asked to check the current repo. Do not ask for a mode choice.
- When a command creates or checks lifecycle artifacts, report the command
  result first in plain language. Do not finish with only "artifacts were
  written"; say whether the command found drift, wrote drafts, produced an
  advisory, or found new post-write escapes.

## Maintainer Self-Audit

When the current workspace is the `lumin-repo-lens` maintainer
checkout, the CLI automatically excludes maintainer lab/corpus/generated
mirror directories. Use `--no-self-audit-excludes` only when the user
explicitly asks for a whole-repo scan. The automatic set is:

```bash
--exclude p6-corpus
--exclude output/corpus
--exclude review-output
--exclude audit-artifacts
--exclude .audit
--exclude test-harness
--exclude skills/lumin-repo-lens/_engine
--exclude skills/lumin-repo-lens/scripts
--exclude node_modules
```

## Modes

### welcome

Do not run a scan immediately. The welcome mode is a router, not a
sales pitch — show a short menu, three short choices, and almost
nothing else.

Author the menu fresh in the user's vibe. Match their last turn's
tone, language, formality, and energy. Warm if they're warm, sparse
if they're sparse, playful if they're playful, calm if they're calm.
The menu is a moment of attention, not a fixed script — do not lock
the same opener or the same three phrasings across sessions.

Three things to offer (rephrase each in whatever fits the moment):

- Choice 1 — looking at the repo as it is right now
- Choice 2 — checking before they add or change something
- Choice 3 — planning a slower, gentler cleanup

Routing targets (do not print these in chat):

- 1 -> `/lumin-repo-lens`
- 2 -> `/lumin-repo-lens:pre-write`
- 3 -> `/lumin-repo-lens:refactor-plan`

Use at most three choices. The chat surface follows these constraints:

- one short opener line, or none — author it fresh in the user's voice
- three numbered choices, each on one short line, matching the same
  vibe (no per-choice explanation, no slash paths shown, no bilingual
  pairs on the same line)
- no preamble, no closing "you can also say it in natural language"
  line — natural-language picking is the default anyway
- the user picks by number or by typing what they want; route silently

Choice 2 (`pre-write`) is natural-language friendly.
Do not tell first-time users that they must write intent JSON. If the
user already gave a concrete request or args, skip the menu entirely
and route to the matching mode.
For first-touch welcome in a fresh plugin install, one short setup note
is allowed: "First audit may install parser dependencies locally once;
set LUMIN_REPO_LENS_NO_AUTO_INSTALL=1 to skip." Do not repeat this note
after a successful audit has run.

`:check-canon` and `:canon-draft` are intentionally not on this menu —
they are maintainer surfaces for the tool itself. If a vibe-coder asks
about them, say so plainly first. Maintainers can call
`/lumin-repo-lens:canon-draft` or
`/lumin-repo-lens:check-canon` directly.
Use `/lumin-repo-lens:full` when the user asks for a first deep pass, due
diligence, a post-refactor review, or any explicit "full audit" wording.

### default

This is the one-click path for users who do not know what to ask yet.

If arguments are empty, do not ask which mode the user wants, do not
print the welcome menu, and do not wait for confirmation. First say one
short progress sentence, then choose the profile by cadence:

- If this is the first pass on the workspace, `.audit/manifest.json` is
  absent or stale for the current root, the user asks for audit/review,
  or the previous turn was a large refactor/cleanup, run a full baseline:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/scripts/audit-repo.mjs --root . --output .audit --profile full
```

- If a fresh full baseline already exists and the user is asking for a
  small follow-up, run a quick re-check instead:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/scripts/audit-repo.mjs --root . --output .audit --profile quick
```

Then answer with `templates/REVIEW_CHECKLIST_SHORT.md` unless the user
asked for full checklist output: what is already stable, at most three
things worth smoothing next, confidence/scan range, likely
false-positive families to keep as-is, and the next command if more
precision is wanted.
Use `.audit/audit-summary.latest.md` only to orient yourself to which
artifacts exist. It is not a ranked recommendation list. Read
`manifest.json` and the relevant raw JSON artifacts directly before
choosing "Already Stable", "Worth Smoothing Next", or "Keep As-Is For
Now" items.
If `.audit/topology.mermaid.md` exists, use it only as a visual companion
for explaining cross-submodule flow, cycles, or hub files; cite
`topology.json` for exact grounded claims.
Checklist gate: the checklist is a required review step, not an output
template. Short output is not permission to skip it. Before composing,
triage C/D/E/A/B/F using `checklist-facts.json`; mark unavailable lanes
as `unknown` internally instead of silently omitting them. If the user
asked for full, deep, exhaustive, due-diligence, CI, or formal review,
open `templates/REVIEW_CHECKLIST.md` and walk it before drafting.

Formal report closeout: if you save a formal report or due-diligence
handoff to Markdown, the final author must re-read it before the final
answer. Manually check headline counts, same-site classifications, broad
conclusions, and chat-persona leakage against cited artifacts or source.
Do not delegate this closeout to a string heuristic.

Living document gate: before the final answer, check the supported
living audit paths named in Shared Rules. If one exists, read it and
update it from the current run before answering. Mark items `RESOLVED`
only with comparable scan range and produced evidence; otherwise use
`NOT_RECHECKED`. Do not ask a subagent to own this document. Subagents
may inspect code, but the main controller verifies and edits the doc.

Keep the chat answer under about 12 bullets. Do not show raw JSON, long
producer logs, FP ids, tier names, or canonical jargon unless the user
asks for proof. Prefer user-facing section names like "Already Stable",
"Worth Smoothing Next", and "Keep As-Is For Now" over "findings"
language. If stable evidence is thin, do not manufacture praise; use
"Current State" and lead with the next safe action. If the audit
cannot run because dependencies or plugin files are missing, give the
smallest exact setup command shown by the wrapper and one next action
instead of a mode menu. The wrapper may auto-run the first local
`npm ci --omit=dev --ignore-scripts --no-audit --fund=false` setup in
generated skill packages; set `LUMIN_REPO_LENS_NO_AUTO_INSTALL=1` to
disable that setup. Do not ask the user to install packages unless that
guard still fails.

When a full profile ran but the user did not ask for full checklist or
formal report output, end with one required feature-discovery tail. Keep
it optional and low-pressure: "I kept this short; I can expand the same
evidence into a full checklist walk, formal report, or due-diligence
handoff." This tail is not decoration; it teaches the user the feature
exists. Include copyable phrases such as "full checklist로 펼쳐줘",
"formal report로 써줘", or "due-diligence handoff로 정리해줘". Do not
omit it after full-profile short answers. Do not add this tail after
quick incremental checks.

If arguments are present, pass them through as audit CLI arguments.

### audit

Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/scripts/audit-repo.mjs $ARGUMENTS
```

If the user did not specify a profile, choose the same cadence as the
default command: full for first baseline, due diligence, explicit
review, large refactor planning, or post-refactor review; quick for
small incremental re-checks over already-baselined work.

Read `manifest.json`, `fix-plan.json`, `checklist-facts.json`, and
supporting artifacts before making claims. Use `audit-summary.latest.md`
only as an artifact map; do not copy its measured cue order into the
chat answer. Always pass the checklist gate before choosing the final
answer. For short chat, triage C/D/E/A/B/F and compress the result. For
full, deep, exhaustive, due-diligence, CI, or formal review, open
`templates/REVIEW_CHECKLIST.md` and walk it before drafting. Before reporting dead-export
counts, run a quick FP screen: inspect `fix-plan.summary`, `muted`,
`degraded`, and review-visible entries for known FP families. Use
`references/false-positive-index.md`; the long FP case ledger is
maintainer-only. In ordinary user review, do not load historical FP case
notes. Put likely FP families in
"Keep As-Is For Now" instead of "Worth Smoothing Next". In chat, translate
those screens into plain language such as "protected public surface" or
"test-only consumer pattern"; do not paste FP ids unless asked. If the user wants a
humane plan, route to `refactor-plan` after the audit.

For any saved formal report, re-read the report yourself after drafting
and before final answer or handoff. Manually check headline counts,
same-site classifications, broad conclusions, and chat-persona leakage
against cited artifacts or source. Do not replace this with a string
heuristic.

Before the final audit answer, apply the living document gate from the
default route. Existing tracked docs are an opt-in signal from the repo:
keep them current. If the user asked to start tracking and no supported
doc exists, create `docs/current/audit/lumin-structural-audit.md` from
`templates/living-audit-template.md`.

If the chosen profile was full but the user did not ask for full
checklist/report output, include the same feature-discovery tail from
the default route. Do not treat that offer as a required next step.

For `--profile full` or `--profile ci`, also read
`audit-review-pack.latest.md` when it exists. This pack is the
reviewer-lane surface for deep review. The engine never calls external
models or APIs. Treat the pack as a main-controller artifact brief, not
as a subagent prompt. Claude Code decides inside the session whether to
read the lanes locally or dispatch built-in reviewer subagents. Use
subagents when the user asked for full/deep/exhaustive review or when
several code areas are independent enough to review in parallel. For
ordinary short chat answers, read the lanes yourself and fold only the
best three actionable insights into the kind user-facing answer. When
using subagents, translate a chosen lane into a codebase-reading task
with concrete files, symbols, or hypotheses. Do not paste checklist or
artifact lanes wholesale; the subagent should inspect repository files
directly and report file:line evidence.

### full

`/lumin-repo-lens:full` is a thin audit command that forces
`--profile full` so the slash menu exposes a one-click deep review path.
Run it exactly like `audit`, but add `--profile full` unless the command
file already supplied it. If a user accidentally passes another
`--profile`, prefer `full` and mention that this command is the full
profile entrypoint.

### pre-write

If `--intent` is provided, pass the arguments through. Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/scripts/audit-repo.mjs --pre-write $ARGUMENTS
```

Intent files must follow `references/pre-write-intent-shape.md`. `--intent -`
streams that same JSON through stdin. Before
coding, read the invocation-specific advisory path printed in the
pre-write handoff or recorded at `manifest.preWrite.advisoryPath`.
`pre-write-advisory.latest.json` is only a convenience pointer and can
be overwritten by another pre-write run. Missing evidence is not clean
evidence. In chat, summarize it as "reuse this existing helper",
"review this nearby domain cluster", or "not enough evidence yet" before
showing raw keys.

If `--intent` is not provided but the user gave a natural-language
change request, do not ask them to write JSON. Infer the smallest compact
intent you can from the request, default omitted lanes to empty arrays,
and run the same command with `--intent -` by streaming that JSON on
stdin. Ask one short clarification only when the planned code change
cannot be inferred safely.

If the user is asking for help but does not yet know what they want,
asking them to clarify just bounces them — they came because they
don't know. Give them something concrete to react to first (a quick
audit lay-of-the-land usually works), then return to pre-write once
they pick a direction. Empty intent plus empty advisory is not
"it ran"; it is a dead-end disguised as a successful run.

Otherwise, do not run a separate quick audit unless the user
explicitly asks for one. The orchestrator's pre-write-only path is
intent-shaped and should build only the artifacts needed by the
declared names, files, dependencies, or shapes.

### post-write

Require `--pre-write-advisory`; prefer the invocation-specific
`pre-write-advisory.<invocationId>.json` path from the matching
pre-write handoff. Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/scripts/audit-repo.mjs --post-write $ARGUMENTS
```

Read the generated post-write delta and acknowledge every `silent-new`
type escape plus every unexpected new file in `fileDelta.unexpectedNew`
before closing the task. Use plain language first: "one new any-like
escape appeared" or "one unplanned file appeared" is better than a raw
delta dump. Do not say the whole change is clean unless every relevant
lane you checked supports that claim; name the remaining limits.

### canon-draft

Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/scripts/audit-repo.mjs --canon-draft $ARGUMENTS
```

Open the chat answer by flagging this as a maintainer surface —
drafting tool-internal canonical proposals, not regular vibe-coder
use. Phrase it in the user's voice. Then continue with the rest of
the behaviour below.

Drafts are proposals, not promoted truth. Keep `canonical-draft/` and
`canonical/` conceptually separate.
This is a maintainer/tool-management surface. In chat, first say how many
proposal files were written and where to review them. Then say that a
human or maintainer step must promote accepted drafts; never imply the
drafts are already canonical truth.

### check-canon

Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/scripts/audit-repo.mjs --check-canon $ARGUMENTS
```

Open the chat answer by flagging this as a maintainer surface —
checking whether tool-internal canonical docs have drifted from
code reality, not regular vibe-coder use. Phrase it in the user's
voice. Then report the actual state.

Report clean, drift, missing-canon, and parse-error states separately.
Do not read `canonical-draft/` as promoted truth. This is a maintainer
surface; if the user did not ask for exact drift detail, give the short
state and where the artifact was written. Never summarize this command as
"done" without saying whether promoted canon was clean, drifted, missing,
or unreadable.

### refactor-plan

`refactor-plan` is a coaching command, not an engine mode. It has no `audit-repo.mjs --refactor-plan` flag, producer, or JSON artifact.

Run a full audit for first baseline, stale artifacts, explicit large
refactor planning, due diligence, or post-refactor review. Use quick only
when usable fresh artifacts already exist, the user asks for a fast
follow-up, or the scope is a small known slice. If `$ARGUMENTS` already
sets a profile, do not add a second profile flag:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/scripts/audit-repo.mjs $ARGUMENTS --profile full
```

Then read `references/refactor-plan-policy.md` and fill
`templates/refactor-plan-template.md`. Default to the short four-section
chat output (SHORT mode). Include a one-line pre-write handoff for any
code-changing slice. Do not emit the FULL handoff plan, evidence trail,
or JSON scope block unless the user asks for handoff or machine-readable
planning data.
