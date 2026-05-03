// Per-finding provenance — `supportedBy` / `taintedBy` /
// `resolverConfidence` / `parseStatus` fields that accompany each
// dead-export candidate on the way to `rank-fixes.mjs`.
//
// Moved out of `_lib/classify-facts.mjs` in v1.10.2 because the
// provenance layer was the youngest topic in that file and the most
// likely to grow (new taint kinds as new FP classes are discovered).
// Keeping it next to the regex/AST counters made classify-facts the
// fastest-growing module in `_lib/`; a dedicated home flattens the
// graph.
//
// The vocabulary (taint kinds, severity groups) lives in
// `_lib/vocab.mjs`. This module emits the structural records;
// `_lib/ranking.mjs` consumes them for tier decisions.

import path from 'node:path';

import { TAINT } from './vocab.mjs';
import { fileIsInsideScope, matchSpec } from './tsconfig-paths.mjs';

const EXT_RE = /\.(d\.[cm]?ts|tsx?|jsx?|mjs|cjs|mts|cts)$/;
const scopedEntryCache = new WeakMap();

function slash(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

function stripExt(p) {
  return slash(p).replace(EXT_RE, '');
}

function trimDotSlash(p) {
  return slash(p).replace(/^\.\//, '');
}

function normalizePath(p) {
  return path.posix.normalize(trimDotSlash(p));
}

function maybeAbs(root, file) {
  if (!root || !file || path.isAbsolute(file)) return slash(file);
  return slash(path.resolve(root, file));
}

function sameSubmodule(submoduleOf, a, b) {
  if (typeof submoduleOf !== 'function' || !a || !b) return false;
  return submoduleOf(a) === submoduleOf(b);
}

function cacheForAliasMap(aliasMap) {
  if (!aliasMap || typeof aliasMap !== 'object') return null;
  let cache = scopedEntryCache.get(aliasMap);
  if (!cache) {
    cache = new Map();
    scopedEntryCache.set(aliasMap, cache);
  }
  return cache;
}

function applicableScopedEntries(aliasMap, propName, fromHint, root) {
  const entries = Array.isArray(aliasMap?.[propName]) ? aliasMap[propName] : [];
  if (entries.length === 0) return entries;
  if (!fromHint) return entries;

  const absFrom = maybeAbs(root, fromHint);
  const cache = cacheForAliasMap(aliasMap);
  const key = `${propName}\0${absFrom}`;
  if (cache?.has(key)) return cache.get(key);

  const filtered = entries.filter((entry) =>
    !entry.scopeDir || fileIsInsideScope(absFrom, slash(entry.scopeDir)));
  cache?.set(key, filtered);
  return filtered;
}

function firstSlashIndex(spec) {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length >= 3 ? spec.indexOf('/', spec.indexOf('/') + 1) : -1;
  }
  return spec.indexOf('/');
}

function legacySuffixMatch(spec, relFile) {
  const firstSlash = firstSlashIndex(spec);
  if (firstSlash < 0) return false;
  const tailStem = stripExt(spec.slice(firstSlash + 1));
  const fileStem = stripExt(relFile);
  return fileStem === tailStem || fileStem.endsWith('/' + tailStem);
}

function fileStemMatchesCandidate(relFile, candidate) {
  const fileStem = stripExt(normalizePath(relFile));
  const candidateStem = stripExt(normalizePath(candidate));
  return fileStem === candidateStem ||
    fileStem === `${candidateStem}/index` ||
    candidateStem.endsWith('/' + fileStem) ||
    fileStem.endsWith('/' + candidateStem);
}

function relativeSpecCouldMatch(spec, relFile, fromHint) {
  if (!fromHint) return legacySuffixMatch(spec, relFile) ? 'match' : 'no-match';
  const baseDir = path.posix.dirname(slash(fromHint));
  const candidate = path.posix.normalize(path.posix.join(baseDir, spec));
  return fileStemMatchesCandidate(relFile, candidate) ? 'match' : 'no-match';
}

function scopedPathCouldMatch(spec, relFile, { aliasMap, fromHint, root }) {
  const scoped = applicableScopedEntries(aliasMap, 'scopedTsconfigPaths', fromHint, root);
  if (scoped.length === 0) return null;

  const absRelFile = maybeAbs(root, relFile);
  let sawScopedPattern = false;
  for (const entry of scoped) {
    const star = matchSpec(spec, entry);
    if (star === null) continue;
    sawScopedPattern = true;
    for (const target of entry.targets ?? []) {
      const substituted = entry.wildcard ? target.replace('*', star) : target;
      const absCandidate = slash(path.resolve(slash(entry.baseUrlDir), substituted));
      if (fileStemMatchesCandidate(absRelFile, absCandidate)) return 'match';
    }
  }
  return sawScopedPattern ? 'no-match' : null;
}

function scopedBaseUrlCouldMatch(spec, relFile, { aliasMap, fromHint, root }) {
  const scopedBaseUrls = applicableScopedEntries(aliasMap, 'scopedTsconfigBaseUrls', fromHint, root);
  if (scopedBaseUrls.length === 0) return null;
  const absRelFile = maybeAbs(root, relFile);
  for (const entry of scopedBaseUrls) {
    const absCandidate = slash(path.resolve(slash(entry.baseUrlDir), spec));
    if (fileStemMatchesCandidate(absRelFile, absCandidate)) return 'unknown';
  }
  return null;
}

function isAliasLike(spec) {
  return /^(?:@\/|~\/|#\/)/.test(spec);
}

function isBarePackage(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return false;
  if (isAliasLike(spec)) return false;
  if (spec.startsWith('@')) return spec.split('/').length <= 2;
  return !spec.includes('/');
}

// Does an unresolved specifier plausibly resolve to the given repo-rel file?
// Returns a tri-state so unknown alias/baseUrl shapes can stay local-scope soft
// taint instead of becoming repo-wide blocking taint.
export function specifierCouldMatchFile(spec, relFile, opts = {}) {
  if (typeof spec !== 'string' || typeof relFile !== 'string') return 'no-match';

  // Backward-compatible legacy mode for old unit callers and old artifacts.
  if (!opts || Object.keys(opts).length === 0) {
    return legacySuffixMatch(spec, relFile) ? 'match' : 'no-match';
  }

  const { aliasMap, fromHint, submoduleOf, root } = opts;
  if (spec.startsWith('.')) return relativeSpecCouldMatch(spec, relFile, fromHint);
  if (isBarePackage(spec)) return 'no-match';

  const scopedPath = scopedPathCouldMatch(spec, relFile, { aliasMap, fromHint, root });
  if (scopedPath) return scopedPath;

  const baseUrl = scopedBaseUrlCouldMatch(spec, relFile, { aliasMap, fromHint, root });
  if (baseUrl) return baseUrl;

  if (isAliasLike(spec)) {
    return sameSubmodule(submoduleOf, relFile, fromHint) ? 'unknown' : 'no-match';
  }

  if (!spec.startsWith('.') && spec.includes('/')) {
    return sameSubmodule(submoduleOf, relFile, fromHint) ? 'unknown' : 'no-match';
  }

  return 'no-match';
}

function normalizeUnresolvedSpecifierRecord(item) {
  if (typeof item === 'string') {
    return { specifier: item };
  }
  if (!item || typeof item !== 'object') return null;
  const specifier = item.specifier ?? item.fromSpec ?? item.spec;
  if (typeof specifier !== 'string') return null;
  return {
    specifier,
    consumerFile: item.consumerFile ?? item.file ?? null,
    fromHint: item.fromHint ?? item.consumerFile ?? item.file ?? null,
  };
}

// Compute per-finding provenance. Returns
// `{supportedBy, taintedBy, resolverConfidence, parseStatus}`.
// The classifier appends these fields to each emitted dead-candidate
// so `rank-fixes.mjs` can gate tiering per finding instead of
// relying on a single repo-global ratio.
export function computeFindingProvenance(finding, {
  filesWithParseErrors = [],
  unresolvedInternalSpecifiers = [],
  submoduleOf,
  aliasMap,
  root,
  astEvidence,
  astCount,
} = {}) {
  const supportedBy = [];
  const taintedBy = [];

  supportedBy.push({ kind: astEvidence, count: astCount });

  // Strongest taint — the defining file itself failed to parse. In
  // practice rare (parse-error files wouldn't emit defs into the
  // graph) but kept for defensive completeness.
  if (filesWithParseErrors.includes(finding.file)) {
    taintedBy.push({
      kind: TAINT.DEFINING_FILE_PARSE_ERROR,
      file: finding.file,
      effect: 'the file declaring this symbol failed to parse; classification may be incorrect',
    });
  }

  // Soft taint — parse errors elsewhere might have hidden a consumer
  // of THIS symbol. P0 scopes this to same-submodule when a resolver is
  // available; otherwise preserves the old repo-wide fallback.
  const otherFailed = filesWithParseErrors.filter((f) => f !== finding.file);
  const relevantFailed = typeof submoduleOf === 'function'
    ? otherFailed.filter((f) => sameSubmodule(submoduleOf, finding.file, f))
    : otherFailed;
  if (relevantFailed.length > 0) {
    taintedBy.push({
      kind: TAINT.PARSE_ERRORS_ELSEWHERE,
      scope: typeof submoduleOf === 'function' ? 'same-submodule' : 'repo-wide',
      affected: relevantFailed.length,
      sample: relevantFailed.slice(0, 3),
      effect: 'other files failed to parse; a potential consumer of this symbol may be missing from the graph',
    });
  }

  // Strongest per-finding signal — an unresolved specifier's path
  // shape matches THIS file. A tsconfig-paths or alias addition
  // could make it resolve and surface a consumer.
  const matching = [];
  const unknown = [];
  for (const item of unresolvedInternalSpecifiers) {
    const rec = normalizeUnresolvedSpecifierRecord(item);
    if (!rec) continue;
    const result = specifierCouldMatchFile(rec.specifier, finding.file, {
      aliasMap,
      fromHint: rec.fromHint,
      submoduleOf,
      root,
    });
    if (result === 'match') matching.push(rec);
    else if (result === 'unknown' && sameSubmodule(submoduleOf, finding.file, rec.consumerFile)) {
      unknown.push(rec);
    }
  }
  if (matching.length > 0) {
    taintedBy.push({
      kind: TAINT.UNRESOLVED_SPEC_MATCH,
      specifiers: matching.slice(0, 5).map((r) => r.specifier),
      total: matching.length,
      effect: "at least one unresolved import's path shape suggests it could resolve to this file; adding the matching tsconfig paths entry would likely surface a consumer",
    });
  }
  if (unknown.length > 0) {
    const first = unknown[0];
    taintedBy.push({
      kind: TAINT.UNRESOLVED_SPEC_MATCH_UNKNOWN,
      specifiers: unknown.slice(0, 5).map((r) => r.specifier),
      total: unknown.length,
      consumerFile: first.consumerFile ?? undefined,
      fromHint: first.fromHint ?? undefined,
      effect: "at least one unresolved import is alias-shaped in this candidate's submodule, but the matcher cannot prove a direct file match",
    });
  }

  let resolverConfidence;
  if (taintedBy.some((t) => t.kind === TAINT.UNRESOLVED_SPEC_MATCH ||
                            t.kind === TAINT.DEFINING_FILE_PARSE_ERROR)) {
    resolverConfidence = 'low';
  } else if (taintedBy.some((t) => t.kind === TAINT.PARSE_ERRORS_ELSEWHERE ||
                                  t.kind === TAINT.UNRESOLVED_SPEC_MATCH_UNKNOWN)) {
    resolverConfidence = 'medium';
  } else {
    resolverConfidence = 'high';
  }

  return {
    supportedBy,
    taintedBy,
    resolverConfidence,
    parseStatus: filesWithParseErrors.includes(finding.file) ? 'error' : 'ok',
  };
}
