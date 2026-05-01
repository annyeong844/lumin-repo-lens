// Recursive source-file walker. Replaces an earlier shell `find`
// invocation with a Node-native tree walk (Windows/macOS/Linux safe).
//
// Takes `root` + `{ includeTests, languages, exclude }` and returns a
// sorted deduped list of absolute file paths. Language filter maps to
// file extensions. Test filter (when `includeTests: false`) delegates to
// the shared `isTestLikePath` classifier in `_lib/test-paths.mjs`.
//
// Walking strategy: walk all non-pruned top-level subdirs + collect
// root-level entry files (FP-13). Canonical-list approach (only walk
// `src/`, `lib/`, ...) was discarded after it blinded the audit on
// unconventional layouts — 98.5% miss on Claude Code src (FP-17).

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { isTestLikePath } from './test-paths.mjs';
import { JS_FAMILY_LANGS } from './lang.mjs';

const CANONICAL_MARKERS = new Set([
  'src', 'lib', 'bin', 'types', 'apps', 'packages',
  'tests', 'test', '__tests__', 'e2e', 'integration',
  'public', 'app', 'pages', 'scripts',
]);
const ROOT_PRUNE_NAMES = new Set([
  'node_modules', '.git', 'coverage',
  '.next', '.svelte-kit', '.astro', '.turbo', '.cache', '.nuxt', '.output',
  'out', 'target', '.venv', 'venv', '__pycache__',
]);
const ROOT_PRUNE_PREFIXES = ['dist', 'build', '.'];
const WALK_PRUNE_NAMES = new Set(['node_modules', '.git', 'coverage']);
const WALK_PRUNE_PREFIXES = ['dist', 'build'];

function normalizeCollectOptions(opts) {
  const {
    includeTests = true,
    // v1.8.3: default to the full JS family. Prior default
    // `['ts', 'tsx', 'js', 'mjs']` silently dropped `.jsx`, `.cjs`,
    // `.mts`, `.cts`, so callers that relied on the default would under-
    // count in any repo that used those extensions — especially
    // `.cjs`-heavy tooling dirs or `.jsx` React projects.
    languages = JS_FAMILY_LANGS,
    exclude = [],
  } = opts;

  return {
    includeTests,
    extSet: new Set(languages.map((e) => '.' + e)),
    excludeRules: buildExcludeRules(exclude),
  };
}

function normalizeExcludePattern(pattern) {
  return String(pattern ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\*\//, '')
    .replace(/\/\*$/, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function buildExcludeRules(exclude) {
  // User-supplied exclude patterns are intentionally conservative:
  //   --exclude build       prunes a `build/` directory segment
  //   --exclude src/a.ts    excludes that exact path suffix
  //   --exclude skip-me.js  excludes files with that basename
  //
  // This preserves the original directory-boundary behavior (so
  // `build-index.ts` is not removed by `--exclude build`) while making
  // explicit file-path excludes work as users expect.
  return exclude
    .map((p) => normalizeExcludePattern(p))
    .filter(Boolean)
    .map((pattern) => {
      const lastSegment = pattern.split('/').at(-1) ?? pattern;
      const fileLike = /\.[^/]+$/.test(lastSegment);
      return fileLike
        ? { kind: 'file', pattern }
        : { kind: 'directory', needle: '/' + pattern + '/' };
    });
}

function boundedRelativePath(root, full, { directory = false } = {}) {
  const rel = path.relative(root, full).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    const normalized = full.replace(/\\/g, '/').replace(/^\/+/, '');
    return '/' + normalized + (directory ? '/' : '');
  }
  return '/' + rel + (directory ? '/' : '');
}

function isExcludedPath(root, full, excludeRules, { directory = false } = {}) {
  const normalized = boundedRelativePath(root, full, { directory });
  return excludeRules.some((rule) => {
    if (rule.kind === 'directory') return normalized.includes(rule.needle);
    if (directory) return false;
    return normalized.endsWith('/' + rule.pattern);
  });
}

function readDirOrNull(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    // Directory may vanish mid-scan or become unreadable; callers treat
    // null as "skip this branch" so one race does not kill the audit.
    return null;
  }
}

function shouldPruneRootDir(name) {
  if (ROOT_PRUNE_NAMES.has(name)) return true;
  return ROOT_PRUNE_PREFIXES.some((pre) =>
    pre === '.'
      ? name.startsWith('.') && !CANONICAL_MARKERS.has(name)
      : name === pre || name.startsWith(pre + '-'));
}

function shouldPruneWalkDir(name) {
  if (WALK_PRUNE_NAMES.has(name)) return true;
  for (const pre of WALK_PRUNE_PREFIXES) {
    if (name === pre || name.startsWith(pre + '-')) return true;
  }
  return false;
}

function collectSearchDirs(root, excludeRules) {
  const searchDirs = [];
  const entries = readDirOrNull(root);
  if (!entries) {
    return searchDirs;
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.isSymbolicLink()) continue;
    if (shouldPruneRootDir(e.name)) continue;
    const full = path.join(root, e.name);
    if (isExcludedPath(root, full, excludeRules, { directory: true })) continue;
    searchDirs.push(full);
  }
  return searchDirs;
}

function collectRootEntries(root, extSet, excludeRules) {
  // Root-level entry files (FP-13). Repo-root entry points like
  // `server.ts` / `main.ts` wire together the whole app — their imports
  // must be visible or consumers of route handlers / registries look dead.
  // v0.6.8 fix: filters by caller-provided `extSet` so Python / Go scans
  // don't leak root-level .mjs into the result (and vice versa).
  const rootEntries = [];
  const entries = readDirOrNull(root);
  if (!entries) {
    return rootEntries;
  }

  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name);
    if (!extSet.has(ext)) continue;
    const full = path.join(root, e.name);
    if (isExcludedPath(root, full, excludeRules)) continue;
    rootEntries.push(full);
  }
  return rootEntries;
}

function walkSourceFiles(scanRoot, dir, extSet, excludeRules, out) {
  const entries = readDirOrNull(dir);
  if (!entries) return;

  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (shouldPruneWalkDir(e.name)) continue;
      if (isExcludedPath(scanRoot, full, excludeRules, { directory: true })) continue;
      walkSourceFiles(scanRoot, full, extSet, excludeRules, out);
    } else if (e.isFile()) {
      if (!extSet.has(path.extname(e.name))) continue;
      if (isExcludedPath(scanRoot, full, excludeRules)) continue;
      out.push(full);
    }
  }
}

function dedupeSorted(files) {
  const sorted = files.toSorted();
  const deduped = [];
  let prev = null;
  for (const f of sorted) {
    if (f !== prev) { deduped.push(f); prev = f; }
  }
  return deduped;
}

export function collectFiles(root, opts = {}) {
  const resolvedRoot = path.resolve(root);
  const { includeTests, extSet, excludeRules } = normalizeCollectOptions(opts);
  const searchDirs = collectSearchDirs(resolvedRoot, excludeRules);
  const rootEntries = collectRootEntries(resolvedRoot, extSet, excludeRules);
  const out = [];

  // If root has NO subdirs at all (rare — flat-file repo), walk root.
  for (const d of searchDirs.length === 0 ? [resolvedRoot] : searchDirs) {
    walkSourceFiles(resolvedRoot, d, extSet, excludeRules, out);
  }
  out.push(...rootEntries);

  // De-dupe (search dir roots can overlap with walker output).
  const deduped = dedupeSorted(out);
  return includeTests ? deduped : deduped.filter((f) => !isTestLikePath(f));
}
