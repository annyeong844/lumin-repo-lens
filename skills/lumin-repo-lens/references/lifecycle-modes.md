# Lifecycle Modes

Use this reference when invoking `pre-write`, `post-write`,
`canon-draft`, or `check-canon`, or when interpreting the corresponding
manifest blocks.

## Pre-Write

Run before writing code in a repository context to surface what already
exists: types, helpers, canonical owner claims, near-name alternatives,
dependency signals, and exact shape matches when `shape-index.json` is
available.

```bash
node scripts/audit-repo.mjs --root . --output ./output --pre-write --intent intent.json
# Or read the same intent JSON from stdin:
# node scripts/audit-repo.mjs --root . --output ./output --pre-write --intent -
```

The intent file is a structured declaration of planned names, files,
dependencies, shapes, and type escapes. In normal chat use, the assistant
infers this JSON from the user's request; do not make the user hand-author
it unless they explicitly want to. The advisory is written as:

- `<output>/pre-write-advisory.latest.json`
- `<output>/pre-write-advisory.<invocationId>.json`

The advisory JSON also records `artifactPaths.invocationSpecific`.
When run through `audit-repo.mjs`, `manifest.preWrite.advisoryPath`
points at that invocation-specific file and `latestAdvisoryPath` keeps
the convenience pointer separately. Use the invocation-specific path for
post-write; `latest` can be overwritten by a later pre-write run.

The intent JSON normalizes these five top-level keys: `names`, `shapes`,
`files`, `dependencies`, and `plannedTypeEscapes`. See
`references/pre-write-intent-shape.md` for the minimal valid shape and
examples. Missing top-level arrays default to `[]` with an
`intentWarnings` entry; present-but-wrong types are schema errors.

Pre-write is advisory. It informs the edit; it does not veto the edit.
When `--pre-write` is the only lifecycle mode requested through the
orchestrator, it does not run the base quick audit first. Its cold-cache
preflight is intent-shaped: name lookups build `symbols.json`,
dependency package lookups build `symbols.json` for static package-import
consumer counts, file lookups build `symbols.json`, `topology.json`, and
`triage.json`, and shape lookups build `shape-index.json`. With
`--no-fresh-audit`, missing dependency import counts are reported as
unavailable rather than `0 observed consumers`.

Exit codes through the orchestrator:

- `0`: success
- `1`: pre-write child failed after dispatch, such as malformed intent JSON
- `2`: `--pre-write` requested without `--intent`

## Post-Write

Run after writing code to compare the pre-write `any` inventory snapshot
with a fresh after-inventory, and to compare the pre-write file inventory
plus `intent.files` with the current scanned file set.

```bash
node scripts/audit-repo.mjs --root . --output ./output --post-write --pre-write-advisory ./output/pre-write-advisory.<invocationId>.json
```

Delta labels:

- `planned`
- `planned-not-observed`
- `silent-new`
- `pre-existing`
- `removed`
- `observed-unbaselined`

`silent-new` entries are the required acknowledgement set. Missing
baseline or scan-range mismatch degrades honestly to
`observed-unbaselined`.

`fileDelta.unexpectedNew` records scanned files that appeared after
pre-write but were not listed in `intent.files`. This is a visibility
signal, not a veto; the assistant should acknowledge the files and decide
whether the intent was incomplete or the change drifted.

Artifacts:

- `<output>/post-write-delta.latest.json`
- `<output>/post-write-delta.<preWriteInvocationId>.<deltaInvocationId>.json`

`--pre-write` and `--post-write` are mutually exclusive. They represent
different lifecycle stages; chaining them in one call makes silent-new
detection meaningless.

`--strict-post-write` escalates spawn/read failures to exit 2. It does
not turn legitimate `ran: true` deltas into blocking exits.
`--strict-post-write-confidence` additionally escalates legitimate
`ran: true` deltas to exit 2 when the before baseline is missing, scan
range parity is not `ok`, or the after inventory is incomplete.

## Canon Draft

Run when proposing current observations as canonical draft files for a
human or LLM reviewer to promote.

```bash
node scripts/audit-repo.mjs --root . --output ./output --canon-draft
node scripts/audit-repo.mjs --root . --output ./output --canon-draft --sources type-ownership,naming
```

Sources:

- `type-ownership`: exported type identities from `symbols.json` or fresh
  AST. Identity: `ownerFile::exportedName`. Optional shape evidence can
  add a note section, but does not change labels.
- `helper-registry`: exported top-level helpers from fresh AST. Fan-in is
  distinct consumer-file count, not call-site count.
- `topology`: submodule structure from `topology.json`; hard dependency,
  exits 2 when absent in standalone source mode.
- `naming`: file and symbol naming cohorts from fresh AST.

Drafts land in `canonical-draft/` by default and are versioned instead
of overwritten. Existing promoted canon files are called out in the
draft header so promotion cannot happen silently.

`--canon-draft` is never part of `quick`, `full`, or `ci`; it is always
explicit opt-in.

## Check Canon

Run after canonical files have been promoted to compare current
observation against the shipping truth.

```bash
node scripts/audit-repo.mjs --root . --output ./output --check-canon --sources all
```

Sources:

- `type-ownership`
- `helper-registry`
- `topology`
- `naming`

`--sources all` expands to all four sources and uses the single
`check-canon.mjs --source all` path. Missing canon for some sources is
reported as `skipped-missing-canon`; it does not hard-fail the aggregate
when other sources were checked.

Default orchestrator semantics are advisory. Use
`--strict-check-canon` to escalate drift or all-fail states.

## Lifecycle Flag Matrix

| --pre-write | --post-write | --canon-draft | Allowed | Notes |
|:-:|:-:|:-:|:-:|---|
| - | - | - | yes | base audit pipeline |
| yes | - | - | yes | requires `--intent` |
| - | yes | - | yes | requires `--pre-write-advisory` |
| - | - | yes | yes | advisory, explicit opt-in |
| yes | yes | any | no | pre/post mutex, exit 2 |
| yes | - | yes | yes | both manifest blocks populated |
| - | yes | yes | yes | both manifest blocks populated |

Manifest blocks are independent: `manifest.preWrite`,
`manifest.postWrite`, `manifest.canonDraft`, and `manifest.checkCanon`
may coexist when the mode combination is valid.
