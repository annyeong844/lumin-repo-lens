---
description: "Default Lumin Repo Lens entrypoint. With no arguments, run a baseline-aware current-workspace structure review; do not ask the user to choose a mode."
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/SKILL.md`,
then read `${CLAUDE_PLUGIN_ROOT}/skills/lumin-repo-lens/references/command-routing.md`.

Mode: `default`
Arguments: {{ARGUMENTS}}

If `Arguments` is empty, treat this as "check this repo now": run the
baseline-aware repo lens pass on the current workspace. Use full for a first or
stale baseline, quick for a small follow-up with a fresh full baseline.
Do not ask a follow-up question, do not print a mode menu, and do not
wait for confirmation.

Follow that mode exactly.
