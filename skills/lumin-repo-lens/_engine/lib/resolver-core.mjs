// Specifier → filesystem path resolver.
//
// `makeResolver(root, aliasMap)` returns a closure that takes (fromFile,
// spec) and returns ONE of:
//   - an absolute file path when resolved to a local source file,
//   - 'NON_SOURCE_ASSET' when the spec resolves to an existing asset
//     file outside the JS/TS source family (for example
//     `./style.css?inline`),
//   - 'EXTERNAL' when the spec looks like an external npm package
//     (no matching alias / tsconfig path / root-prefix interpretation),
//   - 'UNRESOLVED_INTERNAL' when the spec DID match a local alias
//     pattern (tsconfig paths or wildcard), or a package-local Node
//     `#imports` specifier that this resolver cannot evaluate, but the
//     target file doesn't exist / cannot be proven. This is a scanner blind
//     spot, NOT an external package — v1.9.7 caller code
//     (build-symbol-graph) treats these separately.
//   - null when spec is empty or a relative path that matches no file.
//
// Resolution order (each stage returns the result OR `undefined` = continue):
//   1. relative  → stage claims any spec starting with `.`; returns file|null.
//   2. scoped tsconfig paths (FP-36, nearest-scope-first)
//   3. scoped tsconfig baseUrl (baseUrl-only imports like app/_types)
//   4. exact alias
//   5. wildcard alias (longest matchPrefix wins)
//   6. hash-wildcard / unsupported package-local Node #imports
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
import { performance } from 'node:perf_hooks';
import { mapOutputToSource, unsupportedOutputSourceLayoutForTarget } from './alias-map.mjs';
import { fileExists, dirExists, relPath } from './paths.mjs';
import { fileIsInsideScope, matchSpec } from './tsconfig-paths.mjs';
import {
  GENERATED_ARTIFACT_MISSING_HINT,
  GENERATED_ARTIFACT_MISSING_REASON,
  generatedArtifactForTargetCandidates,
  generatedRelativeArtifactEvidence,
  generatedWorkspaceSubpathEvidence,
  isStrongGeneratedArtifact,
  normalizeGeneratedSpecifierSubpath,
  unresolvedGeneratedArtifactHintForCandidates,
} from './generated-artifact-evidence.mjs';
import {
  generatedVirtualSurfaceForSubpath,
  isGeneratedVirtualResolution,
} from './generated-virtual-surface.mjs';

const RESOLVE_FILE_EXTS = [
  '', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.d.ts', '.d.mts', '.d.cts',
];
const RESOLVE_INDEX_EXTS = [
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx',
  '/index.mjs', '/index.cjs', '/index.mts', '/index.cts',
  '/index.d.ts', '/index.d.mts', '/index.d.cts',
];
export const NON_SOURCE_ASSET_RESOLUTION = 'NON_SOURCE_ASSET';
const NODE_IMPORTS_UNSUPPORTED_REASON = 'hash-imports-unsupported';
const NODE_IMPORTS_UNSUPPORTED_HINT = 'node-imports-unsupported';
const CONDITION_PROFILE_AMBIGUOUS_HINT = 'condition-profile-ambiguous';
const OUTPUT_SOURCE_LAYOUT_UNSUPPORTED_REASON = 'output-source-layout-unsupported';
const OUTPUT_SOURCE_LAYOUT_UNSUPPORTED_HINT = 'output-to-source-mapping-unsupported';
const OUTPUT_SOURCE_LAYOUT_UNSUPPORTED_FAMILY = 'output-to-source-mapping';

const JS_SOURCE_EXT_RE = /\.(d\.)?(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;

function resourceQueryStart(spec) {
  const q = spec.indexOf('?');
  const h = spec.indexOf('#');
  const candidates = [];
  if (q >= 0) candidates.push(q);
  // Leading # is a Node package-import specifier, not a resource fragment.
  if (h > 0) candidates.push(h);
  return candidates.length ? Math.min(...candidates) : -1;
}

function stripResourceQuery(spec) {
  const idx = resourceQueryStart(spec);
  return idx >= 0 ? spec.slice(0, idx) : spec;
}

function looksLikeNonSourceAsset(spec) {
  const stripped = stripResourceQuery(spec);
  if (!/\.[^/.]+$/i.test(stripped)) return false;
  return !JS_SOURCE_EXT_RE.test(stripped);
}

// v1.8.0 symlink aliasing fix: resolver returns the realpath (symlinks
// resolved) so downstream consumers see the same absolute path that
// `collectFiles` walked past. Before this, a symlinked alias like
// `src/lib.ts → ../vendored/lib.ts` caused consumer lookups to miss.
//
// Cache realpath calls — invariant for a given audit run.
const realpathCache = new Map();
function canonicalize(p) {
  if (p === null || p === 'EXTERNAL' || p === 'UNRESOLVED_INTERNAL' || p === NON_SOURCE_ASSET_RESOLUTION) return p;
  if (isGeneratedVirtualResolution(p)) return p;
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
  return typeof r === 'string' &&
    r !== 'EXTERNAL' &&
    r !== 'UNRESOLVED_INTERNAL' &&
    r !== NON_SOURCE_ASSET_RESOLUTION;
}

export function isNonSourceAssetResolution(r) {
  return r === NON_SOURCE_ASSET_RESOLUTION;
}

export { isGeneratedVirtualResolution };

const RESOLVER_STAGE_NAMES = Object.freeze([
  'invalid',
  'memoHit',
  'relative',
  'scopedTsconfig',
  'scopedBaseUrl',
  'exactAlias',
  'wildcardAlias',
  'hashWildcard',
  'rootPrefix',
  'external',
  'canonicalize',
]);

function createResolverStageStats() {
  return Object.fromEntries(RESOLVER_STAGE_NAMES.map((name) => [name, {
    attempts: 0,
    terminalResults: 0,
    count: 0,
    cacheHits: 0,
    cacheMisses: 0,
    patternMatches: 0,
    probeHits: 0,
    probeMisses: 0,
    fallbackHits: 0,
    unresolvedInternalResults: 0,
    wallMs: 0,
  }]));
}

function cloneResolverStageStats(stats) {
  return Object.fromEntries(RESOLVER_STAGE_NAMES.map((name) => {
    const stage = stats[name] ?? {};
    return [name, {
      attempts: Math.max(0, Math.round(stage.attempts ?? 0)),
      terminalResults: Math.max(0, Math.round(stage.terminalResults ?? 0)),
      count: Math.max(0, Math.round(stage.count ?? 0)),
      cacheHits: Math.max(0, Math.round(stage.cacheHits ?? 0)),
      cacheMisses: Math.max(0, Math.round(stage.cacheMisses ?? 0)),
      patternMatches: Math.max(0, Math.round(stage.patternMatches ?? 0)),
      probeHits: Math.max(0, Math.round(stage.probeHits ?? 0)),
      probeMisses: Math.max(0, Math.round(stage.probeMisses ?? 0)),
      fallbackHits: Math.max(0, Math.round(stage.fallbackHits ?? 0)),
      unresolvedInternalResults: Math.max(0, Math.round(stage.unresolvedInternalResults ?? 0)),
      wallMs: Math.max(0, Math.round(stage.wallMs ?? 0)),
    }];
  }));
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
  const fsSpec = stripResourceQuery(spec);
  if (looksLikeNonSourceAsset(spec)) {
    const asset = path.resolve(path.dirname(fromFile), fsSpec);
    if (fileExists(asset)) return NON_SOURCE_ASSET_RESOLUTION;
  }

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
// contains `fromFile`, substitute and probe. When that target is absent in a
// source checkout, a concrete workspace package source or generated virtual
// surface for the same specifier may still be better evidence than a blind
// zone. If no concrete fallback exists, the miss stays UNRESOLVED_INTERNAL,
// NOT EXTERNAL — the user's intent was clearly local.
//
// Returns: file path | 'UNRESOLVED_INTERNAL' | undefined (no match).

function resolveAliasFallbackAfterTsconfigMiss(spec, aliasMap) {
  for (const resolver of [resolveExactAlias, resolveWildcard, resolveHashWildcard]) {
    const hit = resolver(spec, aliasMap);
    if (isResolvedFile(hit) || isGeneratedVirtualResolution(hit)) return hit;
  }
  return null;
}

function scopedTsconfigProbeCacheKey(entry, star, spec) {
  return [
    entry.configPath ?? '',
    entry.scopeDir ?? '',
    entry.baseUrlDir ?? '',
    entry.key ?? '',
    entry.matchPrefix ?? '',
    entry.wildcard ? 'wildcard' : 'exact',
    star ?? '',
    spec,
    ...(entry.targets ?? []),
  ].join('\0');
}

function resolveScopedTsconfig(fromFile, spec, scoped, aliasMap, probeCache, stageStats) {
  for (const entry of scoped) {
    if (!fileIsInsideScope(fromFile, entry.scopeDir)) continue;
    const star = matchSpec(spec, entry);
    if (star === null) continue;
    if (stageStats) stageStats.patternMatches++;
    const cacheKey = scopedTsconfigProbeCacheKey(entry, star, spec);
    if (probeCache?.has(cacheKey)) {
      if (stageStats) stageStats.cacheHits++;
      return probeCache.get(cacheKey);
    }
    if (probeCache && stageStats) stageStats.cacheMisses++;
    // Match found. Attempt every target in order.
    for (const target of entry.targets) {
      const substituted = entry.wildcard
        ? target.replace('*', star)
        : target;
      const literal = path.resolve(entry.baseUrlDir, substituted);
      const hit = probeTarget(literal);
      if (hit) {
        if (stageStats) stageStats.probeHits++;
        probeCache?.set(cacheKey, hit);
        return hit;
      }
      if (stageStats) stageStats.probeMisses++;
    }
    const fallback = resolveAliasFallbackAfterTsconfigMiss(spec, aliasMap);
    if (fallback) {
      if (stageStats) stageStats.fallbackHits++;
      probeCache?.set(cacheKey, fallback);
      return fallback;
    }
    // Pattern matched but neither the tsconfig target nor a concrete package
    // fallback exists — scanner blind spot. Do NOT fall through to EXTERNAL.
    if (stageStats) stageStats.unresolvedInternalResults++;
    probeCache?.set(cacheKey, 'UNRESOLVED_INTERNAL');
    return 'UNRESOLVED_INTERNAL';
  }
  return undefined;
}

function unresolvedRecord(root, reason, details = {}) {
  const targetCandidates = (details.targetCandidates ?? [])
    .filter((p) => typeof p === 'string' && p.length > 0)
    .map((p) => relPath(root, p));
  return {
    reason,
    ...(details.stage ? { resolverStage: details.stage } : {}),
    ...(details.outputLevel ? { outputLevel: details.outputLevel } : {}),
    ...(details.unsupportedFamily ? { unsupportedFamily: details.unsupportedFamily } : {}),
    ...(details.matchedPattern ? { matchedPattern: details.matchedPattern } : {}),
    ...(details.source ? { source: details.source } : {}),
    ...(targetCandidates.length ? { targetCandidates: [...new Set(targetCandidates)].slice(0, 8) } : {}),
    ...(details.hint ? { hint: details.hint } : {}),
    ...(details.generatedArtifact ? { generatedArtifact: details.generatedArtifact } : {}),
  };
}

function explainScopedTsconfig(root, fromFile, spec, scoped) {
  for (const entry of scoped) {
    if (!fileIsInsideScope(fromFile, entry.scopeDir)) continue;
    const star = matchSpec(spec, entry);
    if (star === null) continue;
    const candidates = entry.targets.map((target) => {
      const substituted = entry.wildcard ? target.replace('*', star) : target;
      return path.resolve(entry.baseUrlDir, substituted);
    });
    const generatedArtifact = generatedArtifactForTargetCandidates(root, candidates);
    return unresolvedRecord(root, 'tsconfig-path-target-missing', {
      stage: 'tsconfig-paths',
      matchedPattern: entry.key,
      targetCandidates: candidates,
      hint: generatedArtifact ? GENERATED_ARTIFACT_MISSING_HINT : unresolvedGeneratedArtifactHintForCandidates(candidates),
      ...(generatedArtifact ? { generatedArtifact } : {}),
    });
  }
  return null;
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

const SCOPED_BASEURL_NO_MATCH = Symbol('scoped-baseurl-no-match');

function scopedBaseUrlProbeCacheKey(entry, spec) {
  return [
    entry.configPath ?? '',
    entry.scopeDir ?? '',
    entry.baseUrlDir ?? '',
    spec,
  ].join('\0');
}

function resolveScopedBaseUrlEntry(spec, entry, probeCache, stageStats) {
  const key = scopedBaseUrlProbeCacheKey(entry, spec);
  if (probeCache?.has(key)) {
    if (stageStats) stageStats.cacheHits++;
    return probeCache.get(key);
  }
  if (probeCache && stageStats) stageStats.cacheMisses++;

  const literal = path.resolve(entry.baseUrlDir, spec);
  const hit = probeTarget(literal);
  if (hit) {
    probeCache?.set(key, hit);
    return hit;
  }

  const firstSegment = firstSegmentCandidate(entry.baseUrlDir, spec);
  const result = firstSegment && (dirExists(firstSegment) || probeTarget(firstSegment))
    ? 'UNRESOLVED_INTERNAL'
    : SCOPED_BASEURL_NO_MATCH;
  probeCache?.set(key, result);
  return result;
}

function resolveScopedBaseUrl(fromFile, spec, scopedBaseUrls, probeCache, stageStats) {
  for (const entry of scopedBaseUrls) {
    if (!fileIsInsideScope(fromFile, entry.scopeDir)) continue;

    const result = resolveScopedBaseUrlEntry(spec, entry, probeCache, stageStats);
    if (result !== SCOPED_BASEURL_NO_MATCH) return result;
  }
  return undefined;
}

function explainScopedBaseUrl(root, fromFile, spec, scopedBaseUrls) {
  for (const entry of scopedBaseUrls) {
    if (!fileIsInsideScope(fromFile, entry.scopeDir)) continue;

    const literal = path.resolve(entry.baseUrlDir, spec);
    const firstSegment = firstSegmentCandidate(entry.baseUrlDir, spec);
    if (firstSegment && (dirExists(firstSegment) || probeTarget(firstSegment))) {
      return unresolvedRecord(root, 'baseurl-target-missing', {
        stage: 'tsconfig-baseurl',
        matchedPattern: entry.scopeDir,
        targetCandidates: [literal],
      });
    }
  }
  return null;
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

function explainExactAlias(root, spec, aliasMap) {
  if (!aliasMap.has(spec)) return null;
  const entry = aliasMap.get(spec);
  if (entry.type !== 'exact') return null;
  const generatedArtifact =
    entry.generatedArtifact ?? generatedArtifactForTargetCandidates(root, [entry.path]);
  const outputLayout = generatedArtifact
    ? null
    : unsupportedOutputSourceLayoutForTarget(entry.target, { source: entry.source });
  const reason = outputLayout
    ? OUTPUT_SOURCE_LAYOUT_UNSUPPORTED_REASON
    : isStrongGeneratedArtifact(generatedArtifact)
    ? GENERATED_ARTIFACT_MISSING_REASON
    : 'exact-alias-target-missing';
  return unresolvedRecord(root, reason, {
    stage: 'exact-alias',
    matchedPattern: spec,
    source: entry.source,
    targetCandidates: [entry.path],
    ...(outputLayout
      ? {
          outputLevel: 'unsupported',
          unsupportedFamily: OUTPUT_SOURCE_LAYOUT_UNSUPPORTED_FAMILY,
          hint: OUTPUT_SOURCE_LAYOUT_UNSUPPORTED_HINT,
        }
      : {
          hint: generatedArtifact
            ? GENERATED_ARTIFACT_MISSING_HINT
            : unresolvedGeneratedArtifactHintForCandidates([entry.path]),
        }),
    ...(generatedArtifact ? { generatedArtifact } : {}),
  });
}

// ── Stage 5: wildcard alias lookup ───────────────────────
//
// Collect all matching entries and prefer the one with the longest
// `matchPrefix` (most-specific match, per Node.js exports resolution
// semantics).

const WILDCARD_ALIAS_NO_MATCH = Symbol('wildcard-alias-no-match');

function wildcardAliasProbeCacheKey(spec) {
  return spec;
}

function resolveWildcard(spec, aliasMap, probeCache, stageStats) {
  const cacheKey = wildcardAliasProbeCacheKey(spec);
  if (probeCache?.has(cacheKey)) {
    if (stageStats) stageStats.cacheHits++;
    const cached = probeCache.get(cacheKey);
    return cached === WILDCARD_ALIAS_NO_MATCH ? undefined : cached;
  }
  if (probeCache && stageStats) stageStats.cacheMisses++;

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
  if (!bestWildcard) {
    probeCache?.set(cacheKey, WILDCARD_ALIAS_NO_MATCH);
    return undefined;
  }

  const { entry, star } = bestWildcard;
  const substituted = entry.targetPattern.replace('*', star);
  const literal = path.join(entry.pkgDir, substituted.replace(/^\.\//, ''));
  // v1.9.11 FP-38 follow-up: legacy workspace subpaths can have dotted
  // extensionless stems (`location.input`, `features.repository`). Treat the
  // full subpath as the stem and run the same TS/JS probe chain used by
  // relative and baseUrl resolution instead of assuming the last dot is a
  // real file extension.
  const literalHit = probeTarget(literal);
  if (literalHit) {
    probeCache?.set(cacheKey, literalHit);
    return literalHit;
  }
  const remapped = mapOutputToSource(entry.pkgDir, substituted);
  if (fileExists(remapped)) {
    probeCache?.set(cacheKey, remapped);
    return remapped;
  }
  const strippedLit = literal.replace(/\.(ts|tsx|mjs|cjs|js|jsx|mts|cts)$/, '');
  for (const idx of RESOLVE_INDEX_EXTS) {
    if (fileExists(strippedLit + idx)) {
      const hit = strippedLit + idx;
      probeCache?.set(cacheKey, hit);
      return hit;
    }
  }
  const virtualSurface = generatedVirtualSurfaceForSubpath(entry, star);
  if (virtualSurface) {
    const result = Object.freeze({
      ...virtualSurface,
      resolverStage: 'wildcard-alias',
      matchedPattern: entry.legacySubpath ? `${entry.pkgName}/*` : `${entry.matchPrefix}*${entry.matchSuffix ?? ''}`,
      aliasSource: entry.source,
    });
    probeCache?.set(cacheKey, result);
    return result;
  }
  probeCache?.set(cacheKey, 'UNRESOLVED_INTERNAL');
  return 'UNRESOLVED_INTERNAL';
}

function bestWildcardMatch(spec, aliasMap) {
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
  return bestWildcard;
}

function explainWildcard(root, spec, aliasMap) {
  const match = bestWildcardMatch(spec, aliasMap);
  if (!match) return null;
  const { entry, star } = match;
  const substituted = entry.targetPattern.replace('*', star);
  const literal = path.join(entry.pkgDir, substituted.replace(/^\.\//, ''));
  const remapped = mapOutputToSource(entry.pkgDir, substituted);
  const targetCandidates = [literal, remapped];
  const generatedArtifact = generatedWorkspaceSubpathEvidence(entry, star);
  const outputLayout = generatedArtifact
    ? null
    : unsupportedOutputSourceLayoutForTarget(substituted, { source: entry.source });
  const generatedHint = generatedArtifact ? GENERATED_ARTIFACT_MISSING_HINT : undefined;
  const reason = outputLayout
    ? OUTPUT_SOURCE_LAYOUT_UNSUPPORTED_REASON
    : entry.legacySubpath
    ? (generatedHint ? GENERATED_ARTIFACT_MISSING_REASON : 'workspace-package-subpath-target-missing')
    : 'wildcard-alias-target-missing';
  return unresolvedRecord(root, reason, {
      stage: 'wildcard-alias',
      matchedPattern: entry.legacySubpath ? `${entry.pkgName}/*` : `${entry.matchPrefix}*${entry.matchSuffix ?? ''}`,
      source: entry.source,
      targetCandidates,
      ...(outputLayout
        ? {
            outputLevel: 'unsupported',
            unsupportedFamily: OUTPUT_SOURCE_LAYOUT_UNSUPPORTED_FAMILY,
            hint: OUTPUT_SOURCE_LAYOUT_UNSUPPORTED_HINT,
          }
        : {
            hint: generatedHint ?? unresolvedGeneratedArtifactHintForCandidates(targetCandidates),
          }),
      ...(generatedArtifact
        ? {
            generatedArtifact: {
              ...generatedArtifact,
              matchedPackage: entry.pkgName,
              targetSubpath: normalizeGeneratedSpecifierSubpath(star),
            },
          }
        : {}),
    });
}

// ── Stage 6: Node #imports subpath / unsupported family ──

function resolveHashWildcard(spec, aliasMap) {
  let matched = false;
  for (const [, entry] of aliasMap) {
    if (entry.type === 'hash-unsupported') {
      if (hashImportEntryMatches(entry, spec)) return 'UNRESOLVED_INTERNAL';
      continue;
    }
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
  if (spec.startsWith('#')) return 'UNRESOLVED_INTERNAL';
  return matched ? 'UNRESOLVED_INTERNAL' : undefined;
}

function hashImportEntryMatches(entry, spec) {
  if (entry.key && !entry.key.includes('*')) return spec === entry.key;
  if (!spec.startsWith(entry.keyPrefix ?? '')) return false;
  if (entry.keySuffix && !spec.endsWith(entry.keySuffix)) return false;
  const starEnd = entry.keySuffix ? spec.length - entry.keySuffix.length : spec.length;
  return spec.slice((entry.keyPrefix ?? '').length, starEnd).length > 0;
}

function hashImportEntryCandidates(entry, spec) {
  if (Array.isArray(entry.targetCandidates)) return entry.targetCandidates;
  if (!Array.isArray(entry.targetPatterns)) return [];
  const starEnd = entry.keySuffix ? spec.length - entry.keySuffix.length : spec.length;
  const tail = spec.slice((entry.keyPrefix ?? '').length, starEnd);
  if (!tail) return [];
  return entry.targetPatterns.map((targetPattern) =>
    path.join(entry.pkgDir, targetPattern.replace('*', tail)));
}

function explainHashWildcard(root, spec, aliasMap) {
  for (const [, entry] of aliasMap) {
    if (entry.type === 'hash-unsupported') {
      if (!hashImportEntryMatches(entry, spec)) continue;
      const candidates = hashImportEntryCandidates(entry, spec);
      return unresolvedRecord(root, entry.reason ?? 'condition-profile-ambiguous', {
        stage: 'hash-imports',
        outputLevel: 'unsupported',
        unsupportedFamily: 'node-imports',
        matchedPattern: entry.key ?? `${entry.keyPrefix ?? ''}*${entry.keySuffix ?? ''}`,
        source: entry.source,
        targetCandidates: candidates,
        hint: CONDITION_PROFILE_AMBIGUOUS_HINT,
      });
    }
    if (entry.type !== 'hash-wildcard') continue;
    if (!spec.startsWith(entry.keyPrefix)) continue;
    if (entry.keySuffix && !spec.endsWith(entry.keySuffix)) continue;
    const starEnd = entry.keySuffix ? spec.length - entry.keySuffix.length : spec.length;
    const tail = spec.slice(entry.keyPrefix.length, starEnd);
    if (tail.length === 0) continue;
    const targetPatterns = Array.isArray(entry.targetPatterns) && entry.targetPatterns.length
      ? entry.targetPatterns
      : [entry.targetPattern];
    const candidates = targetPatterns.map((targetPattern) =>
      path.join(entry.pkgDir, targetPattern.replace('*', tail)));
    return unresolvedRecord(root, 'hash-import-target-missing', {
      stage: 'hash-imports',
      matchedPattern: `${entry.keyPrefix}*${entry.keySuffix ?? ''}`,
      source: entry.source,
      targetCandidates: candidates,
      hint: unresolvedGeneratedArtifactHintForCandidates(candidates),
    });
  }
  if (spec.startsWith('#')) {
    return unresolvedRecord(root, NODE_IMPORTS_UNSUPPORTED_REASON, {
      stage: 'hash-imports',
      outputLevel: 'unsupported',
      unsupportedFamily: 'node-imports',
      source: 'package-json-imports',
      hint: NODE_IMPORTS_UNSUPPORTED_HINT,
    });
  }
  return null;
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

export function explainUnresolvedSpecifier(root, aliasMap, fromFile, spec) {
  if (!spec || typeof spec !== 'string') return null;
  if (spec.startsWith('.')) {
    const fsSpec = stripResourceQuery(spec);
    const targetAbs = path.resolve(path.dirname(fromFile), fsSpec);
    const generatedArtifact = generatedRelativeArtifactEvidence(root, fromFile, targetAbs);
    const generatedMissing = isStrongGeneratedArtifact(generatedArtifact);
    return unresolvedRecord(root, generatedMissing
      ? GENERATED_ARTIFACT_MISSING_REASON
      : 'relative-target-missing', {
      stage: 'relative',
      targetCandidates: [targetAbs],
      hint: generatedMissing
        ? GENERATED_ARTIFACT_MISSING_HINT
        : unresolvedGeneratedArtifactHintForCandidates([targetAbs]),
      generatedArtifact: generatedMissing ? generatedArtifact : undefined,
    });
  }

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

  return explainScopedTsconfig(root, fromFile, spec, scoped) ??
    explainScopedBaseUrl(root, fromFile, spec, scopedBaseUrls) ??
    explainExactAlias(root, spec, aliasMap) ??
    explainWildcard(root, spec, aliasMap) ??
    explainHashWildcard(root, spec, aliasMap) ??
    unresolvedRecord(root, 'unknown-internal-resolution');
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

  const stageStats = createResolverStageStats();
  const scopedTsconfigProbeCache = new Map();
  const scopedBaseUrlProbeCache = new Map();
  const wildcardAliasProbeCache = new Map();

  function recordInstantStage(name) {
    const stage = stageStats[name];
    if (!stage) return;
    stage.attempts++;
    stage.terminalResults++;
    stage.count++;
  }

  function runResolverStage(name, fn) {
    const stage = stageStats[name];
    const started = performance.now();
    if (stage) stage.attempts++;
    const hit = fn();
    if (stage) {
      stage.wallMs += performance.now() - started;
      if (hit !== undefined) {
        stage.terminalResults++;
        stage.count++;
      }
    }
    return hit;
  }

  const resolveRaw = function resolve(fromFile, spec) {
    if (!spec || typeof spec !== 'string') {
      recordInstantStage('invalid');
      return null;
    }
    if (spec.startsWith('.')) {
      return runResolverStage('relative', () => resolveRelative(fromFile, spec));
    }

    let hit;
    hit = runResolverStage('scopedTsconfig', () =>
      resolveScopedTsconfig(
        fromFile,
        spec,
        scoped,
        aliasMap,
        scopedTsconfigProbeCache,
        stageStats.scopedTsconfig));
    if (hit !== undefined) return hit;
    hit = runResolverStage('scopedBaseUrl', () =>
      resolveScopedBaseUrl(fromFile, spec, scopedBaseUrls, scopedBaseUrlProbeCache, stageStats.scopedBaseUrl));
    if (hit !== undefined) return hit;
    hit = runResolverStage('exactAlias', () => resolveExactAlias(spec, aliasMap));
    if (hit !== undefined) return hit;
    hit = runResolverStage('wildcardAlias', () =>
      resolveWildcard(spec, aliasMap, wildcardAliasProbeCache, stageStats.wildcardAlias));
    if (hit !== undefined) return hit;
    hit = runResolverStage('hashWildcard', () => resolveHashWildcard(spec, aliasMap));
    if (hit !== undefined) return hit;
    hit = runResolverStage('rootPrefix', () => resolveRootPrefix(spec, root));
    if (hit !== undefined) return hit;

    recordInstantStage('external');
    return 'EXTERNAL';
  };

  // Wrap: canonicalize any file path. Null / sentinels pass through.
  // See `canonicalize` docblock for symlink-aliasing rationale.
  const memo = new Map();
  const memoStats = { hits: 0, misses: 0 };

  function memoKey(fromFile, spec) {
    return `${String(fromFile)}\0${String(spec)}`;
  }

  function resolve(fromFile, spec) {
    const key = memoKey(fromFile, spec);
    if (memo.has(key)) {
      const started = performance.now();
      memoStats.hits++;
      const value = memo.get(key);
      const stage = stageStats.memoHit;
      stage.count++;
      stage.wallMs += performance.now() - started;
      return value;
    }
    memoStats.misses++;
    const rawValue = resolveRaw(fromFile, spec);
    const canonicalizeStarted = performance.now();
    const value = canonicalize(rawValue);
    const canonicalizeStage = stageStats.canonicalize;
    canonicalizeStage.attempts++;
    canonicalizeStage.terminalResults++;
    canonicalizeStage.count++;
    canonicalizeStage.wallMs += performance.now() - canonicalizeStarted;
    memo.set(key, value);
    return value;
  }

  resolve.memoStats = function memoStatsSnapshot() {
    return {
      hits: memoStats.hits,
      misses: memoStats.misses,
      size: memo.size,
    };
  };

  resolve.stageStats = function stageStatsSnapshot() {
    return cloneResolverStageStats(stageStats);
  };

  return resolve;
}
