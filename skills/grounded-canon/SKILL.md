---
name: grounded-canon
description: "Maintainer-only canon surface for Lumin Repo Lens/lumin-repo-lens: draft or check promoted repository facts, canonical drift, canon-draft/check-canon results, parser contracts, and maintainer validation evidence."
---

# Grounded Canon

This is the maintainer-facing canonical fact surface for lumin-repo-lens.
It owns `canon-draft` and `check-canon` together because draft output is
reviewed, promoted, and later checked for drift as one lifecycle.

Default voice is concise and factual. This surface may use colder
terminology than the audit surface, but every claim still needs machine
evidence and scan range.
Do not use casual hedging. If evidence is missing or degraded, emit
`[확인 불가]` or a degraded status directly with the scan range.

## Core Contract

```
NO STRUCTURAL CLAIM WITHOUT MACHINE EVIDENCE
NO ABSENCE CLAIM WITHOUT STATED SCAN RANGE
```

## Shared Engine

The shared engine lives in the sibling audit skill:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/scripts/audit-repo.mjs
```

In a maintainer checkout, the equivalent command is:

```bash
node audit-repo.mjs
```

Slash commands still read `<SKILL_ROOT>/references/command-routing.md` from the
shared audit skill for exact flag routing.
Below, `<SKILL_ROOT>` means
`${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens` in plugin
installs, or the repo root in a maintainer checkout.

Below, `<audit-repo>` means whichever of the two commands above applies
to the current context.

This surface owns `/lumin-repo-lens:canon-draft` and
`/lumin-repo-lens:check-canon`.

## References To Load

- Read `<SKILL_ROOT>/references/command-routing.md` first for
  slash-command routing.
- Read `<SKILL_ROOT>/references/lifecycle-modes.md` when exact flags, exit codes, or
  artifact names matter.
- Read `<SKILL_ROOT>/canonical/canon-drift.md` for drift categories, parser contract,
  per-source Markdown reports, and `canon-drift.json` shape.
- Read `<SKILL_ROOT>/canonical/fact-model.md`,
  `<SKILL_ROOT>/canonical/identity-and-alias.md`, and
  `<SKILL_ROOT>/canonical/classification-gates.md` when a drift category, identity, or
  label set is ambiguous.

## Canon Draft

Use when current artifacts should propose canonical facts for review:

```bash
<audit-repo> --canon-draft --root <repo> --output <dir> --sources <sources>
```

Drafts are proposals, not promoted truth. The model may summarize why a
draft changed, but a human or maintainer process still promotes it.

## Check Canon

Use when promoted `canonical/` facts should be compared against fresh
artifacts:

```bash
<audit-repo> --check-canon --root <repo> --output <dir> --sources <sources>
```

If a source is missing, skipped, degraded, or diagnostic-only, surface
that status. Do not turn "skipped" into "clean."

## Output

Use short maintainer blocks:

1. Sources checked
2. Drift found or skipped sources
3. Files written
4. Promotion or follow-up step

For full details, cite `canon-drift.json`, per-source
`canon-drift.<source>.md`, and `manifest.json`.

## Hand Off

If the user shifts to general repo structure, cleanup priority, or
refactor-plan coaching, hand off to `lumin-repo-lens`. If the
user shifts to code changes before or after implementation, hand off to `grounded-write-gate`.
