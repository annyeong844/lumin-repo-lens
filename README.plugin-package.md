# Lumin Repo Lens Claude Code Plugin Package

Install this directory as the Claude Code plugin root. Do not install `skills/` alone;
the slash command delegators and plugin metadata live at this package root.

This directory is a plugin-root package. It includes Claude Code plugin
metadata, slash-command delegators, and generated skill surfaces.

Slash command delegators resolve through `${CLAUDE_PLUGIN_ROOT}` and
point at the generated skill surfaces below.

Included skill surfaces:

- `skills/lumin-repo-lens/`
- `skills/lumin-repo-lens-write-gate/`
- `skills/lumin-repo-lens-canon/`

The Codex wrapper is excluded by default to avoid Claude Code implicit-invocation overlap.
