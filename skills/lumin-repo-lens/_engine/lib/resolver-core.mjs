// Specifier → filesystem path resolver.
//
// `makeResolver(root, aliasMap)` returns a closure that takes (fromFile,
// spec) and returns ONE of:
//   - an absolute file path when resolved to a local source file,
//   - 'EXTERNAL' when the spec looks like an external npm package
//     (no matching alias / tsconfig path / root-prefix interpretation),
//   - 'UNRESOLVED_INTERNAL' when the spec DID match a local alias
//     pattern (tsconfig paths or wildcard) but the target file doesn't
//     exist. This is a scanner blind spot, NOT an external package —
//     v1.9.7 caller code (build-symbol-graph) treats these separately.
//   - null when spec is empty or a relative path that matches no file.
//
// Resolution order (each stage returns the result OR `undefined` = continue):
//   1. relative  → stage claims any spec starting with `.`; returns file|null.
//   2. scoped tsconfig paths (FP-36, nearest-scope-first)
//   3. scoped tsconfig baseUrl (baseUrl-only imports like app/_types)
//   4. exact alias
//   5. wildcard alias (longest matchPrefix wins)
//   6. hash-wildcard (Node #imports)
//   7. root-prefix (FP-16)
//   → fallthrough: 'EXTERNAL' sentinel.
//
// The EXTERNAL vs UNRESOLVED_INTERNAL distinction matters for the
// resolver-blindness gate in rank-fixes / _lib/ranking: external
// package imports (react, eslint) are NOT a blind spot for dead-export
// analysis, but a failed tsconfig `@/*` lookup IS.
//
// Post-P3 cleanup (2026-04-21): `makeResolver` was 205 LOC. Decomposed
// into 6 module-level stage helpers + a thin orchestrator. Each stage
// is independently readable; `makeResolver` is now ~20 LOC.

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { mapOutputToSource } from './alias-map.mjs';
import { fileExists, dirExists } from './paths.mjs';
import { fileIsInsideScope, matchSpec } from './tsconfig-paths.mjs';

const RESOLVE_FILE_EXTS = [
  '', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.d.ts', '.d.mts', '.d.cts',
];
const RESOLVE_INDEX_EXTS = [
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx',
  '/index.mjs', '/index.cjs', '/index.mts', '/index.cts',
  '/index.d.ts', '/index.d.mts', '/index.d.cts',
];

// v1.8.0 symlink aliasing fix: resolver returns the realpath (symlinks
// resolved) so downstream consumers see the same absolute path that
// `collectFiles` walked past. Before this, a symlinked alias like
// `src/lib.ts → ../vendored/lib.ts` caused consumer lookups to miss.
//
// Cache realpath calls — invariant for a given audit run.
const realpathCache = new Map();
function canonicalize(p) {
  if (p === null || p === 'EXTERNAL' || p === 'UNRESOLVED_INTERNAL') return p;
  const cached = realpathCache.get(p);
  if (cached !== undefined) return cached;
  let real;
  try { real = realpathSync(p); }
  catch { real = p; }
  realpathCache.set(p, real);
  return real;
}

// Callers switch on four cases. Use this predicate to ask "is this a
// concrete file path?" — returns false for both sentinels AND null.
export function isResolvedFile(r) {
  return typeof r === 'string' && r !== 'EXTERNAL' && r !== 'UNRESOLVED_INTERNAL';
}

// ── Shared path-probe helper ─────────────────────────────
//
// Runs the extension + /index.* + .mjs→.ts swap fallback chain against
// a literal base path. Returns the first match or null.
function probeTarget(literal) {
  if (fileExists(literal)) return literal;
  for (const ext of RESOLVE_FILE_EXTS) {
    if (ext && fileExists(literal + ext)) return literal + ext;
  }
  for (const ext of RESOLVE_INDEX_EXTS) {
    if (fileExists(literal + ext)) return literal + ext;
  }
  if (/\.jsx$/.test(literal)) {
    const swap = literal.replace(/\.jsx$/, '.tsx');
    if (fileExists(swap)) return swap;
  } else {
    for (const alt of ['.ts', '.tsx']) {
      const swap = literal.replace(/\.(mjs|cjs|js)$/, alt);
      if (swap !== literal && fileExists(swap)) return swap;
    }
  }
  return null;
}

// Root-prefix probe variant. Used only by `resolveRootPrefix`. Richer
// fallback chain including .mjs→.ts/.tsx/.mts/.cts swaps + stripped
// /index.* suffixes. Kept separate because the "from-root" case handles
// both relative-like specs (`src/foo/bar.js`) and self-reference
// (`<rootBasename>/...`), which have slightly different shape needs.
function probeRootCandidate(base) {
  for (const ext of RESOLVE_FILE_EXTS) {
    if (fileExists(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_INDEX_EXTS) {
    if (fileExists(base + ext)) return base + ext;
  }
  if (/\.(mjs|cjs|js|jsx)$/.test(base)) {
    for (const alt of ['.ts', '.tsx', '.mts', '.cts']) {
      const cand = base.replace(/\.(mjs|cjs|js|jsx)$/, alt);
      if (fileExists(cand)) return cand;
    }
    const stripped = base.replace(/\.(mjs|cjs|js|jsx)$/, '');
    for (const idx of RESOLVE_INDEX_EXTS) {
      if (fileExists(stripped + idx)) return stripped + idx;
    }
  }
  return null;
}

// ── Stage 1: relative paths ──────────────────────────────
//
// A spec starting with `.` is definitively relative — this stage OWNS the
// result. Returns file path OR null (terminal; relative-not-found is not
// an external package candidate).

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const ext of RESOLVE_FILE_EXTS) {
    if (fileExists(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_INDEX_EXTS) {
    if (fileExists(base + ext)) return base + ext;
  }
  // ESM-compiled JS in source trees often maps to TS/TSX originals.
  if (/\.(mjs|cjs|js|jsx)$/.test(spec)) {
    for (const alt of ['.ts', '.tsx', '.mts', '.cts']) {
      const swapped = spec.replace(/\.(mjs|cjs|js|jsx)$/, alt);
      const p = path.resolve(path.dirname(fromFile), swapped);
      if (fileExists(p)) return p;
    }
    const stripped = base.replace(/\.(mjs|cjs|js|jsx)$/, '');
    for (const idx of RESOLVE_INDEX_EXTS) {
      if (fileExists(stripped + idx)) return stripped + idx;
    }
  }
  return null;
}

// ── Stage 2: scoped tsconfig paths (FP-36) ───────────────
//
// If `spec` matches a `compilerOptions.paths` pattern whose `scopeDir`
// contains `fromFile`, substitute and probe. A match that fails to
// produce a file is UNRESOLVED_INTERNAL (scanner blind spot), NOT
// EXTERNAL — the user's intent was clearly a local file and the
// scanner failed to find it.
//
// Returns: file path | 'UNRESOLVED_INTERNAL' | undefined (no match).

function resolveScopedTsconfig(fromFile, spec, scoped) {
  for (const entry of scoped) {
    if (!fileIsInsideScope(fromFile, entry.scopeDir)) continue;
    const star = matchSpec(spec, entry);
    if (star === null) continue;
    // Match found. Attempt every target in order.
    for (const target of entry.targets) {
      const substituted = entry.wildcard
        ? target.replace('*', star)
        : target;
      const literal = path.resolve(entry.baseUrlDir, substituted);
      const hit = probeTarget(literal);
      if (hit) return hit;
    }
    // Pattern matched but no file — scanner blind spot. Do NOT fall
    // through to alias lookup or EXTERNAL.
    return 'UNRESOLVED_INTERNAL';
  }
  return undefined;
}

// ── Stage 3: scoped tsconfig baseUrl ─────────────────────
//
// TypeScript resolves non-relative imports against baseUrl before
// falling back to package lookup. In app-scoped monorepos that often
// means imports like `app/_types` with no `paths` entry at all. Treat
// the specifier as internal only when the first segment exists under
// the app's baseUrl; otherwise leave ordinary package names external.

function firstSegmentCandidate(baseUrlDir, spec) {
  if (!spec || spec.startsWith('#')) return null;
  const parts = spec.split('/');
  if (parts[0]?.startsWith('@')) {
    if (parts.length < 2) return null;
    return path.resolve(baseUrlDir, parts[0], parts[1]);
  }
  return path.resolve(baseUrlDir, parts[0]);
}

function resolveScopedBaseUrl(fromFile, spec, scopedBaseUrls) {
  for (const entry of scopedBaseUrls) {
    if (!fileIsInsideScope(fromFile, entry.scopeDir)) continue;

    const literal = path.resolve(entry.baseUrlDir, spec);
    const hit = probeTarget(literal);
    if (hit) return hit;

    const firstSegment = firstSegmentCandidate(entry.baseUrlDir, spec);
    if (firstSegment && (dirExists(firstSegment) || probeTarget(firstSegment))) {
      return 'UNRESOLVED_INTERNAL';
    }
  }
  return undefined;
}

// ── Stage 4: exact alias ─────────────────────────────────

function resolveExactAlias(spec, aliasMap) {
  if (!aliasMap.has(spec)) return undefined;
  const entry = aliasMap.get(spec);
  if (entry.type !== 'exact') return undefined;
  // Exact aliases are local intent. If the alias is declared but cannot
  // resolve to a concrete file, surface resolver blindness instead of
  // falling through as if nothing matched.
  return probeTarget(entry.path) ?? 'UNRESOLVED_INTERNAL';
}

// ── Stage 5: wildcard alias lookup ───────────────────────
//
// Collect all matching entries and prefer the one with the longest
// `matchPrefix` (most-specific match, per Node.js exports resolution
// semantics).

function resolveWildcard(spec, aliasMap) {
  let bestWildcard = null;
  for (const [, entry] of aliasMap) {
    if (entry.type !== 'wildcard') continue;
    if (!spec.startsWith(entry.matchPrefix)) continue;
    if (entry.matchSuffix && !spec.endsWith(entry.matchSuffix)) continue;
    const starEnd = entry.matchSuffix ? spec.length - entry.matchSuffix.length : spec.length;
    const star = spec.slice(entry.matchPrefix.length, starEnd);
    if (star.length === 0) continue;
    if (!bestWildcard || entry.matchPrefix.length > bestWildcard.entry.matchPrefix.length) {
      bestWildcard = { entry, star };
    }
  }
  if (!bestWildcard) return undefined;

  const { entry, star } = bestWildcard;
  const substituted = entry.targetPattern.replace('*', star);
  const literal = path.join(entry.pkgDir, substituted.replace(/^\.\//, ''));
  if (fileExists(literal)) return literal;
  for (const alt of ['.ts', '.tsx']) {
    const swap = literal.replace(/\.(mjs|cjs|js)$/, alt);
    if (swap !== literal && fileExists(swap)) return swap;
  }
  // v1.9.11 FP-38: extensionless literal (legacy-subpath `./*` targets)
  // → probe each source extension.
  if (!/\.[a-zA-Z]+$/.test(literal)) {
    for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx']) {
      if (fileExists(literal + ext)) return literal + ext;
    }
  }
  const remapped = mapOutputToSource(entry.pkgDir, substituted);
  if (fileExists(remapped)) return remapped;
  const strippedLit = literal.replace(/\.(ts|tsx|mjs|cjs|js|jsx|mts|cts)$/, '');
  for (const idx of RESOLVE_INDEX_EXTS) {
    if (fileExists(strippedLit + idx)) return strippedLit + idx;
  }
  return 'UNRESOLVED_INTERNAL';
}

// ── Stage 6: hash-wildcard (Node #imports subpath) ───────

function resolveHashWildcard(spec, aliasMap) {
  let matched = false;
  for (const [, entry] of aliasMap) {
    if (entry.type !== 'hash-wildcard') continue;
    if (!spec.startsWith(entry.keyPrefix)) continue;
    if (entry.keySuffix && !spec.endsWith(entry.keySuffix)) continue;
    const starEnd = entry.keySuffix ? spec.length - entry.keySuffix.length : spec.length;
    const tail = spec.slice(entry.keyPrefix.length, starEnd);
    if (tail.length === 0) continue;
    matched = true;
    const tailCandidates = [tail];
    if (!entry.keySuffix) {
      const runtimeExtStripped = tail.replace(/\.(mjs|cjs|js|jsx)$/, '');
      if (runtimeExtStripped && runtimeExtStripped !== tail) tailCandidates.push(runtimeExtStripped);
    }
    const targetPatterns = Array.isArray(entry.targetPatterns) && entry.targetPatterns.length
      ? entry.targetPatterns
      : [entry.targetPattern];
    for (const targetPattern of targetPatterns) {
      for (const tailCandidate of tailCandidates) {
        const candidate = path.join(entry.pkgDir, targetPattern.replace('*', tailCandidate));
        const hit = probeTarget(candidate);
        if (hit) return hit;
      }
    }
  }
  return matched ? 'UNRESOLVED_INTERNAL' : undefined;
}

// ── Stage 7: root-prefix (FP-16) ─────────────────────────
//
// Root-prefix imports like `src/foo/bar.js` without tsconfig paths
// support. Two interpretations in sequence:
//   (a) FROM-root: `bootstrap/state.js` → `<root>/bootstrap/state.js`
//   (b) SELF-reference: root = `/path/src`, spec = `src/bootstrap/...`
//       → spec's first segment equals root's basename, strip it.

function resolveRootPrefix(spec, root) {
  const firstSlash = spec.indexOf('/');
  if (firstSlash <= 0) return undefined;

  const firstSegment = spec.slice(0, firstSlash);
  const rootBasename = path.basename(root);

  // (a) from-root interpretation — only probe if firstSegment is a real
  // dir under root (filters out the huge number of specs where
  // root-prefix doesn't apply).
  const rootCandidate = path.join(root, firstSegment);
  if (dirExists(rootCandidate)) {
    const hit = probeRootCandidate(path.resolve(root, spec));
    if (hit) return hit;
  }

  // (b) self-reference interpretation
  if (firstSegment === rootBasename) {
    const stripped = spec.slice(firstSlash + 1);
    const hit = probeRootCandidate(path.resolve(root, stripped));
    if (hit) return hit;
  }

  return undefined;
}

// ── Orchestrator ─────────────────────────────────────────

export function makeResolver(root, aliasMap) {
  // FP-36: pre-sort scoped tsconfig paths by scope depth (deeper = more
  // specific) and pattern specificity. More-local tsconfig wins over
  // less-local; longer matchPrefix wins over shorter.
  const scoped = Array.isArray(aliasMap.scopedTsconfigPaths)
    ? [...aliasMap.scopedTsconfigPaths].sort((a, b) => {
        const depthDelta = b.scopeDir.length - a.scopeDir.length;
        if (depthDelta !== 0) return depthDelta;
        return b.matchPrefix.length - a.matchPrefix.length;
      })
    : [];
  const scopedBaseUrls = Array.isArray(aliasMap.scopedTsconfigBaseUrls)
    ? [...aliasMap.scopedTsconfigBaseUrls].sort((a, b) =>
        b.scopeDir.length - a.scopeDir.length)
    : [];

  const resolveRaw = function resolve(fromFile, spec) {
    if (!spec || typeof spec !== 'string') return null;
    if (spec.startsWith('.')) return resolveRelative(fromFile, spec);

    let hit;
    hit = resolveScopedTsconfig(fromFile, spec, scoped);
    if (hit !== undefined) return hit;
    hit = resolveScopedBaseUrl(fromFile, spec, scopedBaseUrls);
    if (hit !== undefined) return hit;
    hit = resolveExactAlias(spec, aliasMap);
    if (hit !== undefined) return hit;
    hit = resolveWildcard(spec, aliasMap);
    if (hit !== undefined) return hit;
    hit = resolveHashWildcard(spec, aliasMap);
    if (hit !== undefined) return hit;
    hit = resolveRootPrefix(spec, root);
    if (hit !== undefined) return hit;

    return 'EXTERNAL';
  };

  // Wrap: canonicalize any file path. Null / sentinels pass through.
  // See `canonicalize` docblock for symlink-aliasing rationale.
  return function resolve(fromFile, spec) {
    return canonicalize(resolveRaw(fromFile, spec));
  };
}
