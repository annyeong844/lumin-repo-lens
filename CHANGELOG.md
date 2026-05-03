# Changelog

## 0.9.0-beta.13 - 2026-05-04

### Self-audit export surface cleanup

- Trim internal helper exports surfaced by the engine's own SAFE_FIX audit
  candidates while preserving each helper's internal runtime use.
- Add export-surface regression tests for the classify policy, manifest,
  function clone, definition id, and post-write file-delta helper modules.
- Regenerate the shipping skill mirror so Claude Code installs the cleanup
  under a fresh public beta cache key.
- Self-audit result after cleanup: `SAFE_FIX = 0`, `safeFixGroups = 0`,
  `REVIEW_FIX = 0`, `DEGRADED = 0`, with no blind zones.

## 0.9.0-beta.12 - 2026-05-03

### Public plugin cache refresh

- Bump the public beta package version so Claude Code installs a fresh plugin
  cache containing the `0.9.0-beta.11` engine changes.
- This release carries the merged Cloudflare Worker entry protection and
  `safeFixGroups` artifact output under a new installable version key.

## 0.9.0-beta.11 - 2026-05-03

### Large-repo classify scaling

- Add a safe text-zero reference shortcut so candidates whose identifier
  appears exactly once on the declaration line skip AST walking without
  dropping large files or lowering evidence precision.
- Cache per-file provenance and importer-scoped tsconfig alias filtering so
  unresolved-specifier taint no longer scales as candidates x unresolved specs
  x alias entries.
- Keep file-size degradation opt-in (`--classify-max-file-bytes`, default `0`)
  and record classify performance metadata including text-zero candidates,
  provenance cache entries, unprocessed candidates, and file-size cap status.
- Stress-test result: `next.js-canary --production --profile quick` completed
  4,873 files in 221.5s with `classify.incomplete=false`,
  `unprocessedCandidates=0`, `maxFileBytes=0`, and 92 SAFE_FIX candidates;
  Hono, Kit, Astro, Nuxt, and Nest stress runs also completed without
  incomplete classify artifacts.

## 0.9.0-beta.10 - 2026-05-02

### Static SAFE_FIX calibration

- Recalibrate `SAFE_FIX` to mean static-graph-clean mechanical cleanup under
  the recorded scan range, instead of requiring optional runtime coverage and
  git staleness evidence.
- Allow bucket A export-demotion candidates to rank `SAFE_FIX` when local
  provenance is clean; declaration dependencies, policy exclusions, blocking
  taint, and runtime-executed contradictions still block SAFE_FIX.
- Update ranking tests and public wording so cleanup value does not collapse to
  hundreds of review-only candidates in repos without coverage or git history.

## 0.9.0-beta.9 - 2026-05-02

### Invalid tsconfig fixture tolerance

- Skip unusable `tsconfig*.json` files when TypeScript throws while reading or
  parsing config fixtures, instead of aborting alias discovery.
- Add regression coverage for malformed tsconfig fixtures living beside valid
  sibling configs.
- Stress-test result: `astro-main --production` now completes the required
  symbol graph step and reports `parseErrors: 0`, `blindZones: 0`, and
  `unresolvedInternalRatio: 0.0045`.

## 0.9.0-beta.8 — 2026-05-02

### Production-scope test-path calibration

- Treat `runtime-tests/` and `test-utils/` directories as test-like paths for
  `--production` scans, so runtime harness and test helper exports do not leak
  into production dead-export proposals.
- Add regression coverage in the shared path classifier and file collector.
- Stress-test results: `hono-main --production` exposed
  `runtime-tests/workerd/index.ts`, and `kit-main --production` exposed a
  root `test-utils/` directory. The shared classifier now filters both
  conventions consistently before downstream dead-export bucketing.

## 0.9.0-beta.7 — 2026-05-02

### Declaration-file parser blind-zone reduction

- Parse `.d.ts`, `.d.mts`, and `.d.cts` files with `oxc-parser`'s
  declaration-file mode (`lang: "dts"`) instead of ordinary TypeScript mode.
- Add regression coverage for declaration-only value exports such as
  `export const runtimeDependencies: string[];`.
- Stress-test result: `nuxt-main --production --exclude nuxt-main` now reports
  `parseErrors: 0`, `blindZones: 0`, and records
  `packages/nuxt/meta.d.ts::runtimeDependencies` as a definition.

## 0.9.0-beta.6

- Retry OXC parsing in JSX mode when `.js`/`.mjs`/`.cjs` files fail in
  plain JS mode, covering Next.js and React files that keep JSX syntax in
  `.js` sources.
- Align `manifest.confidence.parseErrors` with symbol-graph parse-error
  warnings so parse blind zones are reported consistently.
- Add regression coverage for JSX-in-JS parse handling and manifest parse
  error confidence.
- Stress-test result: `next.js-canary --production` parser gaps dropped from
  511 files to 3 remaining non-JSX syntax gaps.
## 0.9.0-beta.5

- Replace broad framework path muting with package-scoped framework evidence
  plus specific protected convention matching.
- Keep weak framework matches review-visible and emit aggregate
  `summary.frameworkPolicy` counters for muted findings, review hints,
  rejected signals, and path-shaped candidates kept visible.
- Add Hono route registration facts so Hono handlers are protected only when
  passed to route APIs, not by `routes/` path shape.
- Add framework safety fixtures for Next.js, Hono, SvelteKit, Astro, React
  Router, Nuxt/Nitro, and NestJS false-mute prevention.

## 0.9.0-beta.4

- Resolve workspace package exports that point at `dist/` outputs back to
  package-root source files such as `index.ts` and `api.ts`.
- Reduce false unresolved/external classification for Cal.com-style workspace
  package imports when the authored source lives at package root rather than
  under `src/`, `source/`, or `lib/`.
- Prevent `@nuxt/opencollective` from activating Nuxt/Nitro route muting in
  non-Nuxt projects such as NestJS.

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
