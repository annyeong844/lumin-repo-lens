// Per-scope tsconfig `compilerOptions.paths` discovery for FP-36.
//
// Why this exists:
// In multi-app monorepos each app often defines its own tsconfig.json
// with a local `paths: { "@/*": ["./*"] }`. Inside apps/agents the
// import `@/components/auth-control` resolves to
// apps/agents/components/auth-control.tsx — BUT only if the resolver
// is scope-aware. Before v1.9.7 the resolver had no tsconfig paths
// support at all and treated these as EXTERNAL, which then got
// collapsed to `null` and counted in `unresolvedUses`. Consequence:
// the consumer of that file was missing from the graph, and the
// definition site was misclassified as Tier C "dead export."
//
// Observed impact on a real monorepo (duyet/monorepo, 2026-04): 218
// of 397 Tier C findings were actually consumed via per-app `@/*`
// aliases.
//
// ─── v1.9.10 "True AST Config Pass" ──────────────────────
//
// v1.9.7 shipped hand-rolled JSONC parsing + hand-rolled `extends`
// resolution. The skill's own regression tests passed, but on the
// actual duyet/monorepo the numbers were byte-identical to pre-v1.9.7.
// FP-36 was still producing 73.2% FP rate. User pointed this out.
//
// Investigation found the real residual: our `loadTsconfigMerged`
// looked for `<configDir>/node_modules/<extended>` when resolving
// `extends`. Bun and pnpm workspaces put `node_modules` at the repo
// ROOT, not per-app, so the lookup failed silently. When the local
// tsconfig had NO local `paths` (common — apps just extend a shared
// config like `@duyet/tsconfig/nextjs.json` which defines `paths`),
// the extended paths were never inherited and `@/*` imports fell
// through to EXTERNAL.
//
// The right answer isn't a better hand-rolled extends resolver. It's
// TypeScript's own resolver. `ts.parseJsonConfigFileContent` does
// EXACTLY what `tsc` does: JSONC tokenization, extends chain walking
// (including workspace-hoisted node_modules), baseUrl resolution,
// paths inheritance. By construction we cannot drift from tsc.
//
// `typescript` was already in the skill's dependencies for other
// reasons, so this costs zero new packages.

import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
  'out', 'coverage', '.turbo', '.cache', 'vendor',
]);

function walk(root, acc) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(root, e.name), acc);
    } else if (e.isFile()) {
      if (e.name === 'tsconfig.json' || /^tsconfig\..+\.json$/.test(e.name)) {
        acc.push(path.join(root, e.name));
      }
    }
  }
}

/**
 * Load one tsconfig and resolve its extends chain + baseUrl + paths
 * via TypeScript's own config resolver. Returns {options, errors}
 * or null if the file itself won't parse.
 */
function loadTsconfig(configPath) {
  if (!existsSync(configPath)) return null;
  const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
  if (readResult.error) return null;
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  return { options: parsed.options, errors: parsed.errors ?? [] };
}

// Forward-slash normalization for path-shaped string fields in the output
// object. TypeScript's compiler API already emits `baseUrl` with forward
// slashes, so the other fields (`configPath`, `scopeDir`) should match that
// convention — artifacts serialized to JSON / SARIF expect POSIX
// separators. `path.relative` / `fileIsInsideScope` accept mixed separators
// on Windows so normalizing here doesn't affect downstream matching.
const toFwdSlash = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p);

/**
 * Find every tsconfig under `root` and return an array of scoped
 * paths entries. Each entry:
 *
 *   {
 *     configPath:   '/repo/apps/agents/tsconfig.json',
 *     scopeDir:     '/repo/apps/agents',
 *     baseUrlDir:   '/repo/apps/agents',  // as TS resolved it
 *     key:          '@/*',
 *     matchPrefix:  '@/',
 *     matchSuffix:  '',
 *     targets:      ['./*'],
 *     wildcard:     true,
 *   }
 *
 * Path-shaped fields are always forward-slash (even on Windows).
 */
export function discoverScopedTsconfigPaths(root) {
  const files = [];
  walk(root, files);
  const entries = [];

  for (const configPath of files) {
    const loaded = loadTsconfig(configPath);
    if (!loaded) continue;
    const paths = loaded.options.paths;
    if (!paths || typeof paths !== 'object') continue;

    const configDir = path.dirname(configPath);
    // TypeScript's resolver puts baseUrl on the options object
    // already resolved to an absolute path, following the extends
    // chain. `pathsBasePath` is TS's answer to "where are the paths
    // defined relative to" — the dir of the config that declared
    // them. Fall back to configDir only if both are missing.
    const baseUrlDir =
      loaded.options.baseUrl ??
      loaded.options.pathsBasePath ??
      configDir;

    // Scope = the directory of the LEAF tsconfig. Files inside this
    // subtree can use these paths. Even if paths come from an ancestor
    // via extends, each leaf gets its own scope — apps/agents and
    // apps/admin both extending the same shared config each carry
    // their own scope for matchPrefix disambiguation.
    const scopeDir = configDir;

    for (const [key, val] of Object.entries(paths)) {
      if (!Array.isArray(val) || val.length === 0) continue;
      const starIdx = key.indexOf('*');
      const matchPrefix = starIdx >= 0 ? key.slice(0, starIdx) : key;
      const matchSuffix = starIdx >= 0 ? key.slice(starIdx + 1) : '';
      entries.push({
        configPath: toFwdSlash(configPath),
        scopeDir: toFwdSlash(scopeDir),
        baseUrlDir: toFwdSlash(baseUrlDir),
        key,
        matchPrefix,
        matchSuffix,
        targets: val,
        wildcard: starIdx >= 0,
      });
    }
  }

  return entries;
}

/**
 * True when `fromFile` (or its ancestor dir) equals `scopeDir` or is
 * contained within it.
 */
export function fileIsInsideScope(fromFile, scopeDir) {
  const rel = path.relative(scopeDir, fromFile);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * If `spec` matches `entry`'s pattern, return the `*` portion (or ''
 * for exact matches). Otherwise return null.
 */
export function matchSpec(spec, entry) {
  if (!entry.wildcard) {
    return spec === entry.key ? '' : null;
  }
  const { matchPrefix, matchSuffix } = entry;
  if (!spec.startsWith(matchPrefix)) return null;
  if (matchSuffix && !spec.endsWith(matchSuffix)) return null;
  if (spec.length < matchPrefix.length + matchSuffix.length) return null;
  return spec.slice(matchPrefix.length, spec.length - matchSuffix.length);
}
