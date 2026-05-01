# Changelog

## 0.9.0-beta.3

- Remove legacy `lumin-audit` and `grounded-audit` CLI aliases from the
  generated package so the public beta presents one current CLI name:
  `lumin-repo-lens`.
- Rename the generated sibling skill surfaces to
  `lumin-repo-lens-write-gate` and `lumin-repo-lens-canon`.
- Align public English skill/reference/template docs on the `unknown`
  evidence label.
- Resolve app-scoped `compilerOptions.baseUrl` imports such as `app/_types`
  without requiring a `paths` entry.
- Narrow Nuxt/Nitro muting so a bare `h3` dependency does not hide ordinary
  `middleware/` or `plugins/` exports in non-Nuxt server projects.

## 0.9.0-beta.2

- Clean stale legacy `dist/lumin-audit-plugin/` output from the source build
  flow before publishing the current package.
- Align `/lumin-repo-lens:full` command metadata with its `full` routing mode.
- Bump the plugin version so Claude Code update checks can see the package
  change.
- Clarify the public version line: this is not a downgrade from `1.11.11`;
  earlier `1.x` labels were internal package labels, and the Claude Code
  marketplace beta line starts at `0.9.0-beta.x`.

## 0.9.0-beta.1

- Re-label the public Claude Code marketplace package as beta rather than a
  stable `1.x` release.
- Align plugin metadata, generated skill package metadata, and SARIF tool
  version on `0.9.0-beta.1`.
- Add prerelease-version coverage to the source drift guard before publishing
  the beta tag.

## 1.11.11

- Initial public Claude Code marketplace package.
- Ships the `lumin-repo-lens`, `grounded-write-gate`, and `grounded-canon`
  skill surfaces.
- Includes slash-command delegators, plugin metadata, and the generated local
  analysis engine required by the plugin.
