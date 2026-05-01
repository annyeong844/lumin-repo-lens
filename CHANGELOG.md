# Changelog

## 0.9.0-beta.2

- Clean stale legacy `dist/lumin-audit-plugin/` output from the source build
  flow before publishing the current package.
- Align `/lumin-repo-lens:full` command metadata with its `full` routing mode.
- Bump the plugin version so Claude Code update checks can see the package
  change.

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
