// Alias map builder — reads each package's `exports` and `imports` fields
// and compiles them into a flat Map keyed by specifier pattern, with
// wildcard entries stored separately with pre-computed `matchPrefix` /
// `matchSuffix` for O(1) resolver lookup.
//
// Also exposes `mapOutputToSource` for resolver-core — when an `exports`
// entry points at compiled output (`./dist/index.js`), we probe sibling
// source-dir conventions (`src/`, `source/`, `lib/`, etc.) to prefer the
// authored `.ts` source.

import path from 'node:path';
import { fileExists } from './paths.mjs';
import { discoverScopedTsconfigResolution } from './tsconfig-paths.mjs';
import { readJsonFile } from './artifacts.mjs';

// Recursively extract a string target from a conditional exports object.
// Handles nested forms like { node: { import: { types, default }, require: ... } }.
// FP-18 fix: earlier code did `target.import ?? target.default` which can return an object.
export function extractStringTarget(target, depth = 0) {
  if (depth > 8) return null;
  if (target == null) return null;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const r = extractStringTarget(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof target !== 'object') return null;

  // v0.6.5 FP-28: prefer "source" conditions first — these point at actual
  // source (e.g., `@zod/source: "./src/index.ts"`), not compiled output.
  // The skill always prefers source over compiled artifacts for analysis.
  for (const key of Object.keys(target)) {
    if (key === 'source' || key === '@*/source' || /^@[^/]+\/source$/.test(key) || key.endsWith('/source')) {
      const r = extractStringTarget(target[key], depth + 1);
      if (r) return r;
    }
  }

  // Standard preference order: import > default > node > require > types
  for (const key of ['import', 'default', 'node', 'require', 'types']) {
    if (key in target) {
      const r = extractStringTarget(target[key], depth + 1);
      if (r) return r;
    }
  }
  // Fallback: any string value
  for (const v of Object.values(target)) {
    const r = extractStringTarget(v, depth + 1);
    if (r) return r;
  }
  return null;
}

// v0.6.3: map a package.json "exports" output-dir target to the actual
// source file. Common output-dir → source-dir pairs:
//   dist/ → src/, source/, lib/
//   distribution/ → source/, src/   (sindresorhus convention)
//   build/ → src/
//   out/ → src/
// Also swaps compiled extensions (.mjs/.cjs/.js) to source (.ts/.tsx).
// Uses filesystem existence to pick the first plausible source path.
// Falls back to the original (stripped) target if no swap matches.
const OUT_SRC_PAIRS = [
  ['dist', 'src'],
  ['dist', 'source'],
  ['dist', 'lib'],
  ['distribution', 'source'],
  ['distribution', 'src'],
  ['build', 'src'],
  ['out', 'src'],
  ['es', 'src'],
  ['esm', 'src'],
];

export function listPackageDirs(root, repoMode) {
  const dirs = [];
  const seen = new Set();
  function add(dir) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    dirs.push(resolved);
  }
  add(root);
  for (const wd of repoMode.workspaceDirs || []) add(wd);
  return dirs;
}

export function mapOutputToSource(pkgDir, target) {
  const stripped = target.replace(/^\.\//, '');
  const sourceCandidates = [];
  const fallbackCandidates = [];

  function addCandidate(list, candidate) {
    if (!candidate || list.includes(candidate)) return;
    list.push(candidate);
  }

  for (const [out, src] of OUT_SRC_PAIRS) {
    if (!stripped.startsWith(out + '/')) continue;
    const rest = stripped.slice(out.length + 1);
    addCandidate(sourceCandidates, src + '/' + rest);
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.(mjs|cjs|js)$/, '.ts'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.(mjs|cjs|js)$/, '.tsx'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.jsx$/, '.tsx'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.d\.[cm]?ts$/, '.ts'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.d\.[cm]?ts$/, '.tsx'));
    const restStem = rest.replace(/\.d\.[cm]?ts$/, '').replace(/\.[^.]+$/, '');
    const asDir = src + '/' + restStem + '/index.ts';
    addCandidate(sourceCandidates, asDir);
  }

  addCandidate(fallbackCandidates, stripped);
  addCandidate(fallbackCandidates, stripped.replace(/\.(mjs|cjs|js)$/, '.ts'));
  addCandidate(fallbackCandidates, stripped.replace(/\.(mjs|cjs|js)$/, '.tsx'));
  addCandidate(fallbackCandidates, stripped.replace(/\.jsx$/, '.tsx'));
  addCandidate(fallbackCandidates, stripped.replace(/\.d\.[cm]?ts$/, '.ts'));
  addCandidate(fallbackCandidates, stripped.replace(/\.d\.[cm]?ts$/, '.tsx'));

  const candidates = [...sourceCandidates, ...fallbackCandidates];
  for (const c of candidates) {
    const abs = path.join(pkgDir, c);
    if (fileExists(abs)) return abs;
  }
  return path.join(pkgDir, stripped);
}

// Pattern-form sibling of `mapOutputToSource`. Used when the target
// contains `*` (e.g. `./dist/*.js`) and FS probing doesn't apply —
// the wildcard isn't a real file, so we can't pick among candidates
// by existence. Returns the first plausible source pattern after
// applying the same out-dir + extension swaps. Previously each
// wildcard-using call site rolled its own narrow `.js → .ts`
// replacement and silently missed `.mjs`/`.cjs`/`.jsx` (FP-40 class
// — same bug fixed for the `exports` side in v1.10.0 R-8).
export function mapOutputPatternToSource(pattern) {
  let s = pattern.replace(/^\.\//, '');
  for (const [out, src] of OUT_SRC_PAIRS) {
    if (s.startsWith(out + '/')) {
      s = src + '/' + s.slice(out.length + 1);
      break;
    }
  }
  return s
    .replace(/\.(mjs|cjs|js)$/, '.ts')
    .replace(/\.jsx$/, '.tsx');
}

export function mapOutputPatternToSourceCandidates(pattern) {
  const stripped = pattern.replace(/^\.\//, '');
  const sourceCandidates = [];
  const fallbackCandidates = [];

  function addCandidate(list, candidate) {
    if (!candidate || list.includes(candidate)) return;
    list.push(candidate);
  }

  for (const [out, src] of OUT_SRC_PAIRS) {
    if (!stripped.startsWith(out + '/')) continue;
    const rest = stripped.slice(out.length + 1);
    addCandidate(sourceCandidates, src + '/' + rest);
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.(mjs|cjs|js)$/, '.ts'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.(mjs|cjs|js)$/, '.tsx'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.jsx$/, '.tsx'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.d\.[cm]?ts$/, '.ts'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.d\.[cm]?ts$/, '.tsx'));
  }

  addCandidate(fallbackCandidates, stripped);
  addCandidate(fallbackCandidates, stripped.replace(/\.(mjs|cjs|js)$/, '.ts'));
  addCandidate(fallbackCandidates, stripped.replace(/\.(mjs|cjs|js)$/, '.tsx'));
  addCandidate(fallbackCandidates, stripped.replace(/\.jsx$/, '.tsx'));
  addCandidate(fallbackCandidates, stripped.replace(/\.d\.[cm]?ts$/, '.ts'));
  addCandidate(fallbackCandidates, stripped.replace(/\.d\.[cm]?ts$/, '.tsx'));

  return [...sourceCandidates, ...fallbackCandidates];
}

// Detect the source-file counterpart of each workspace's public entry
// (package.json `exports['.']`). Used by build-symbol-graph to skip
// barrel files — they serve as re-export hubs, not definition
// sources, so their "dead exports" are false by construction.
//
// Moved here from build-symbol-graph.mjs in v1.10.1: this function
// is a tiny wrapper over `extractStringTarget` + `mapOutputToSource`
// (both defined in this module), so it belongs where those live.
// Returns a `Set<absolutePath>` — caller checks membership by abs
// path as def files are keyed.
//
// Unparseable or missing package.json files are silently skipped:
// workspaces aren't required to export anything; a workspace without
// exports just doesn't contribute a barrel entry.
export function detectBarrelFiles(root, repoMode) {
  const barrels = new Set();
  for (const wd of listPackageDirs(root, repoMode)) {
    // readJsonFile returns null on missing OR malformed — either is a
    // non-fatal skip here. See docblock above.
    const pkg = readJsonFile(path.join(wd, 'package.json'));
    if (!pkg) continue;
    for (const [subpath, target] of normalizeExportsToEntries(pkg.exports)) {
      if (subpath !== '.') continue;
      const t = extractStringTarget(target);
      if (t) barrels.add(mapOutputToSource(wd, t));
    }
  }
  return barrels;
}

// Normalize `pkgJson.exports` into a list of [subpath, target] pairs,
// covering the three shapes permitted by Node.js's exports spec:
//   1. String         "exports": "./dist/index.mjs"
//   2. Conditional    "exports": { import: X, default: Y }
//   3. Subpaths map   "exports": { ".": X, "./sub": Y, ... }
// Legacy code assumed shape 3 only and iterated Object.entries — which
// for a string value yields character-position iteration (BUG). v0.6.3
// landed the normalization.
function normalizeExportsToEntries(rawExports) {
  if (typeof rawExports === 'string') return [['.', rawExports]];
  if (rawExports && typeof rawExports === 'object' && !Array.isArray(rawExports)) {
    const keys = Object.keys(rawExports);
    const isSubpathMap = keys.some((k) => k === '.' || k.startsWith('./'));
    return isSubpathMap ? Object.entries(rawExports) : [['.', rawExports]];
  }
  return [];
}

// Pass 1: pkgJson.exports → map entries. Handles exact subpaths and
// wildcard subpaths (`./*`, `./features/*`, ...). Wildcard entries carry
// pre-computed matchPrefix / matchSuffix for O(1) resolver lookup.
function addExportsEntries(map, pkgDir, pkgJson) {
  for (const [subpath, target] of normalizeExportsToEntries(pkgJson.exports)) {
    const t = extractStringTarget(target);
    if (!t || typeof t !== 'string') continue;

    if (subpath.includes('*')) {
      // v0.6.8 fix: broadened from `subpath === './*'` to any subpath
      // containing `*` — covers `./features/*`, `./ui/components/*`, and
      // patterns with suffixes like `./sub/*.js`. Multiple wildcards per
      // package supported; resolver picks the longest prefix match.
      const starIdx = subpath.indexOf('*');
      const subpathPrefix = subpath.slice(1, starIdx);
      const subpathSuffix = subpath.slice(starIdx + 1);
      const uniqueKey = `${pkgJson.name}${subpath.slice(1)}__WILDCARD__`;
      map.set(uniqueKey, {
        type: 'wildcard',
        source: 'exports',
        pkgDir,
        pkgName: pkgJson.name,
        matchPrefix: pkgJson.name + subpathPrefix,
        matchSuffix: subpathSuffix,
        targetPattern: t,
      });
    } else {
      const resolvedTarget = mapOutputToSource(pkgDir, t);
      const spec = subpath === '.' ? pkgJson.name : pkgJson.name + subpath.slice(1);
      map.set(spec, { type: 'exact', source: 'exports', path: resolvedTarget });
    }
  }
}

// Pass 2 (v1.9.11 FP-38): workspace packages without `exports`. Older
// pnpm / Bun / Turborepo workspaces use `main` + legacy subpath
// resolution. If we don't register a fallback, the resolver treats the
// entire package as EXTERNAL and every workspace-consumed symbol falls
// dead. Observed impact: 13/229 Tier C findings on duyet (2026-04) were
// this class.
//
// Only adds when the `exports` pass (above) did NOT already register a
// matching entry — an explicit `exports` map always wins.
function addLegacySubpathFallback(map, pkgDir, pkgJson) {
  const hasExplicitBare = map.has(pkgJson.name);
  if (!hasExplicitBare && typeof pkgJson.main === 'string') {
    const mainResolved = mapOutputToSource(pkgDir, pkgJson.main);
    map.set(pkgJson.name, { type: 'exact', source: 'legacy-main', path: mainResolved });
  }

  // Legacy subpath wildcard. Check for existing wildcard OR exact entry
  // with matching package-name prefix.
  const hasSubpathCoverage =
    [...map.keys()].some((k) => k.startsWith(pkgJson.name + '/')) ||
    [...map.values()].some((v) =>
      v && typeof v === 'object' &&
      v.matchPrefix && v.matchPrefix.startsWith(pkgJson.name + '/'));
  if (hasSubpathCoverage) return;

  const uniqueKey = `${pkgJson.name}/__LEGACY_SUBPATH__`;
  map.set(uniqueKey, {
    type: 'wildcard',
    source: 'legacy-subpath',
    pkgDir,
    pkgName: pkgJson.name,
    matchPrefix: pkgJson.name + '/',
    matchSuffix: '',
    // '*' means "take the subpath verbatim and probe from pkgDir".
    // mapOutputToSource isn't needed here — we point at source files
    // directly, not compiled output.
    targetPattern: './*',
    legacySubpath: true,
  });
}

// Pass 3 (FP-03): Node.js `#imports` subpath support. Covers both exact
// form (`"#foo": "./dist/foo.mjs"`) and hash-wildcard form
// (`"#foo/*": "./dist/foo/*.mjs"`). Share the same out-dir + extension
// logic as `exports` via `mapOutputToSource` / `mapOutputPatternToSource`
// (v1.10.1 consolidation).
function addHashImports(map, pkgDir, pkgJson) {
  const imports = pkgJson.imports ?? {};
  for (const [key, target] of Object.entries(imports)) {
    const t = extractStringTarget(target);
    if (!t || typeof t !== 'string') continue;
    if (key.includes('*')) {
      // Wildcard form can't FS-probe (the `*` isn't a file) — use
      // mapOutputPatternToSource. Covers `.mjs` / `.cjs` / `.jsx` and
      // the wider set of source-dir conventions (src/ source/ lib/
      // build/ out/ es/ esm/) via OUT_SRC_PAIRS.
      const starIdx = key.indexOf('*');
      const keyPrefix = key.slice(0, starIdx);
      const keySuffix = key.slice(starIdx + 1);
      const targetPatterns = mapOutputPatternToSourceCandidates(t);
      map.set(`${key}__HASHWILDCARD__`, {
        type: 'hash-wildcard',
        source: 'imports',
        pkgDir,
        keyPrefix,
        keySuffix,
        targetPattern: mapOutputPatternToSource(t),
        targetPatterns,
      });
    } else {
      // Exact form can FS-probe through mapOutputToSource — returns an
      // absolute path to the first existing candidate (or to the literal
      // target if none exist).
      map.set(key, { type: 'exact', source: 'imports', path: mapOutputToSource(pkgDir, t) });
    }
  }
}

export function buildAliasMap(root, repoMode) {
  const map = new Map();
  const packages = listPackageDirs(root, repoMode);

  for (const pkgDir of packages) {
    // readJsonFile returns null on missing OR malformed — either way we
    // skip this workspace rather than aborting alias map build for the
    // others (E1 regression protection: a truncated / BOM-mangled /
    // comment-containing pkg.json in one workspace used to cascade into
    // Tier C over-claims across every sibling).
    const pkgJson = readJsonFile(path.join(pkgDir, 'package.json'));
    if (!pkgJson || !pkgJson.name) continue;

    // Pass order matters: legacy-subpath fallback checks for entries the
    // exports pass added; hash-imports uses an independent key namespace
    // so its order is flexible.
    addExportsEntries(map, pkgDir, pkgJson);
    addLegacySubpathFallback(map, pkgDir, pkgJson);
    addHashImports(map, pkgDir, pkgJson);
  }

  // v1.9.7 FP-36: discover per-scope tsconfig `compilerOptions.paths`.
  // Attached as a property on the Map to preserve backward compat with
  // callers that iterate the Map as `for (const [k, v] of aliasMap)`.
  // Resolver-core reads `.scopedTsconfigPaths` and applies
  // nearest-scope-first for non-relative specifiers.
  const tsconfigResolution = discoverScopedTsconfigResolution(root);
  map.scopedTsconfigPaths = tsconfigResolution.paths;
  map.scopedTsconfigBaseUrls = tsconfigResolution.baseUrls;

  return map;
}
