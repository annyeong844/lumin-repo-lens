---
description: "Run a full Lumin Repo Lens review. Usage: /lumin-repo-lens:full [--root <repo>] [--output <dir>]"
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/SKILL.md`,
then read `${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/references/command-routing.md`.

Mode: `audit`
Arguments: {{ARGUMENTS}}
Required profile: `full`

Run the audit mode with `--profile full`. If `Arguments` already
contains a `--profile` flag, replace it with `--profile full`; otherwise
add `--profile full`. This command exists so the slash menu exposes a
one-click full audit.

Follow that mode exactly.
