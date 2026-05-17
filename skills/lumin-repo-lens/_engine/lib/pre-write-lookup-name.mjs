// Name-candidate lookup for the pre-write gate (P1-1).
//
// Pure function. Consumes an injected `symbols` object (typically
// parsed from `<output>/symbols.json`) and a parsed list of
// `canonicalClaims` (from `_lib/pre-write-canonical-parser.mjs`), plus
// the resolver-confidence inputs. Returns a result shape that the
// renderer in `_lib/pre-write-render.mjs` consumes directly.
//
// Canonical anchors (read before editing this file):
//   - canonical/pre-write-gate.md §3 Step 3 — lookup procedure
//   - canonical/pre-write-gate.md §8 — canonical/ interaction (canonical-first)
//   - canonical/identity-and-alias.md §2 — identity rule
//   - canonical/identity-and-alias.md §3 — identity-keyed fan-in (name-only keying forbidden)
//   - canonical/identity-and-alias.md §9 — resolver-confidence per-identity demotion
//   - canonical/any-contamination.md §3 — tier definitions
//   - canonical/any-contamination.md §6 Stage 1 + §9 — pre-write demotion, label-specific
//   - canonical/fact-model.md §3.1 — type-owner canonical identity field (`exportedName`)
//   - maintainer history notes §4.3 — result shape; §5.3 — algorithm

import { specifierCouldMatchFile } from './finding-provenance.mjs';
import {
  isWeakCommonToken,
  uniquePreWriteTokens,
} from './pre-write-token-policy.mjs';

// ── Cheap-filter near-name constants ─────────────────────────

const NEAR_NAME_MAX_LENGTH_DELTA = 2;
const NEAR_NAME_SHARED_PREFIX_MIN = 4;
const NEAR_NAME_MAX_DISTANCE = 2;
const NEAR_NAME_MAX_RESULTS = 5;
const SEMANTIC_HINT_MAX_RESULTS = 5;
const SEMANTIC_HINT_MIN_SCORE = 2;
const SEMANTIC_STOP_TOKENS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on',
  'or', 'the', 'this', 'that', 'to', 'with',
  'add', 'new', 'helper', 'function', 'type', 'file', 'module', 'service',
  'manager', 'index', 'main', 'src', 'lib', 'utils', 'util', 'ts', 'js', 'mjs',
  'cjs', 'tsx', 'jsx',
]);
const SERVICE_OPERATION_POLICY_ID = 'prewrite-service-operation-sibling-cue';
const SERVICE_OPERATION_POLICY_VERSION = 'prewrite-service-operation-sibling-cue-v1';
const SERVICE_OPERATION_POLICY_MAX_RESULTS = 5;
const LOCAL_OPERATION_POLICY_ID = 'prewrite-local-operation-sibling';
const LOCAL_OPERATION_POLICY_VERSION = 'prewrite-local-operation-sibling-v1';
const LOCAL_OPERATION_POLICY_MAX_RESULTS = 5;
const SERVICE_READ_QUERY_VERBS = new Set([
  'fetch', 'find', 'get', 'list', 'load', 'lookup', 'query', 'read', 'resolve',
  'retrieve', 'search',
]);
const SERVICE_MUTATION_VERB_FAMILIES = new Map([
  ['add', 'mutation-create'],
  ['create', 'mutation-create'],
  ['delete', 'mutation-delete'],
  ['destroy', 'mutation-delete'],
  ['dispatch', 'mutation-send'],
  ['emit', 'mutation-send'],
  ['patch', 'mutation-update'],
  ['remove', 'mutation-delete'],
  ['save', 'mutation-save'],
  ['send', 'mutation-send'],
  ['set', 'mutation-update'],
  ['update', 'mutation-update'],
  ['upsert', 'mutation-save'],
  ['write', 'mutation-save'],
]);
const SERVICE_OPERATION_VERBS = new Set([
  ...SERVICE_READ_QUERY_VERBS,
  ...SERVICE_MUTATION_VERB_FAMILIES.keys(),
]);
const SERVICE_POLICY_PROMOTABLE_REASONS = new Set([
  'single-non-weak-token-only',
  'near-distance-exceeded',
  'near-length-delta-exceeded',
]);
const SERVICE_POLICY_EXCLUDED_PATH_SEGMENTS = new Set([
  '__generated__',
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'vendor',
  'vendors',
]);
const SERVICE_POLICY_NON_CALLABLE_DEFINITION_KINDS = new Set([
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
]);
// ── Helpers ──────────────────────────────────────────────────

function sharedPrefix(a, b) {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}

function splitSemanticTokens(value) {
  return uniquePreWriteTokens(value)
    .filter((token) =>
      token.length >= 2 &&
      !SEMANTIC_STOP_TOKENS.has(token)
    );
}

function uniqueTokens(...parts) {
  return [...new Set(parts.flatMap(splitSemanticTokens))];
}

function commonTokens(a, b) {
  const aSet = new Set(uniqueTokens(a));
  return uniqueTokens(b).filter((token) => aSet.has(token));
}

function hasOnlyWeakCommonTokens(a, b) {
  const common = commonTokens(a, b);
  return common.length > 0 && common.every(isWeakCommonToken);
}

function normalizeRelPath(value) {
  return typeof value === 'string' && value.trim()
    ? value.replace(/\\/g, '/')
    : null;
}

function dirnameRel(value) {
  const normalized = normalizeRelPath(value);
  if (!normalized) return null;
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(0, idx) : '';
}

function intentOwnerFileHint(intentDeclaration) {
  return normalizeRelPath(
    intentDeclaration?.ownerFile ??
    intentDeclaration?.file ??
    intentDeclaration?.targetFile ??
    null
  );
}

function localityFor(candidate, intentOwnerFile) {
  const candidateFile = normalizeRelPath(candidate.ownerFile);
  if (!candidateFile || !intentOwnerFile) {
    return { sameDir: false, sameFile: false };
  }
  return {
    sameDir: dirnameRel(candidateFile) === dirnameRel(intentOwnerFile),
    sameFile: candidateFile === intentOwnerFile,
  };
}

function localityRank(entry) {
  if (entry?.locality?.sameFile) return 2;
  if (entry?.locality?.sameDir) return 1;
  return 0;
}

function capSuppressedCandidates(entries, cap) {
  return entries.slice(0, cap).map((entry) => ({
    ...entry,
    candidateCount: entries.length,
  }));
}

function candidateIdentity(entry) {
  return entry?.identity ?? (
    entry?.ownerFile && entry?.name
      ? `${normalizeRelPath(entry.ownerFile)}::${entry.name}`
      : null
  );
}

// Levenshtein with an early-exit cap. If distance exceeds `cap`, returns
// `cap + 1` — good enough for filter purposes.
function levenshteinCapped(a, b, cap) {
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > cap) return cap + 1;

  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

// ── Fan-in resolution (identity-keyed ONLY) ──────────────────

function resolveFanIn(symbols, identity) {
  const supportsIdentity = symbols?.meta?.supports?.identityFanIn === true;
  if (!supportsIdentity) {
    return {
      fanIn: null,
      fanInConfidence: 'unavailable',
      citation: `[확인 불가, reason: symbols.meta.supports.identityFanIn is not true; identity fan-in not emitted by this producer]`,
    };
  }
  const map = symbols.fanInByIdentity ?? {};
  if (identity in map) {
    return {
      fanIn: map[identity],
      fanInConfidence: 'grounded',
      citation: `[grounded, symbols.json.fanInByIdentity['${identity}'] = ${map[identity]}]`,
    };
  }
  // supports.identityFanIn=true promises the map covers EVERY identity
  // (0 included — producer contract). Absence of the identity here means
  // producer contract violation OR the map is incomplete. Never fall
  // back to topSymbolFanIn (name-keyed would conflate distinct identities
  // per canonical/identity-and-alias.md §3). Emit [확인 불가] instead.
  return {
    fanIn: null,
    fanInConfidence: 'unavailable',
    citation: `[확인 불가, reason: supports.identityFanIn=true but fanInByIdentity['${identity}'] is absent — producer contract violation. symbols.topSymbolFanIn is name-keyed and MUST NOT be substituted]`,
  };
}

function normalizeFanInSpace(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    value: Number.isFinite(record.value) ? record.value : 0,
    type: Number.isFinite(record.type) ? record.type : 0,
    broad: Number.isFinite(record.broad) ? record.broad : 0,
  };
}

function resolveFanInSpace(symbols, identity) {
  const supportsIdentitySpace = symbols?.meta?.supports?.identityFanInSpace === true;
  if (!supportsIdentitySpace) {
    return {
      fanInSpace: null,
      fanInSpaceConfidence: 'unavailable',
      citation: `[확인 불가, reason: symbols.meta.supports.identityFanInSpace is not true; type/value fan-in breakdown not emitted by this producer]`,
    };
  }
  const map = symbols.fanInByIdentitySpace ?? {};
  if (identity in map) {
    const fanInSpace = normalizeFanInSpace(map[identity]);
    return {
      fanInSpace,
      fanInSpaceConfidence: 'grounded',
      citation: `[grounded, symbols.json.fanInByIdentitySpace['${identity}'] = ${JSON.stringify(fanInSpace)}]`,
    };
  }
  return {
    fanInSpace: null,
    fanInSpaceConfidence: 'unavailable',
    citation: `[확인 불가, reason: supports.identityFanInSpace=true but fanInByIdentitySpace['${identity}'] is absent — producer contract violation]`,
  };
}

// ── Contamination state classification (6-state matrix) ──────

function classifyContamination(defInfo, supports) {
  const supportsAny = supports?.anyContamination === true;

  if (!supportsAny) {
    return {
      state: 'capability-absent',
      citation: `[확인 불가, reason: producer did not emit anyContamination capability (symbols.meta.supports.anyContamination !== true)]`,
    };
  }

  const ann = defInfo?.anyContamination;
  if (!ann) {
    return { state: 'clean', citation: '[grounded, anyContamination annotation absent → clean]' };
  }

  const labels = Array.isArray(ann.labels) ? ann.labels : [];
  const hasSevere = labels.includes('severely-any-contaminated');
  const hasAnyContam = labels.includes('any-contaminated');
  const hasAnyMild = labels.includes('has-any');
  const hasUnknownSurface = labels.includes('unknown-surface');

  if (hasSevere) {
    return {
      state: 'severely-any-contaminated',
      labels: [...labels],
      measurements: ann.measurements,
      recommendation: {
        action: 'warn-on-reuse',
        confidence: 'low',
        reason: 'severely-any-contaminated semantic reuse caution',
      },
      citation: `[grounded, anyContamination.label = 'severely-any-contaminated', measurements = ${JSON.stringify(ann.measurements ?? {})}]`,
    };
  }
  if (hasAnyContam) {
    return {
      state: 'any-contaminated',
      labels: [...labels],
      measurements: ann.measurements,
      recommendation: {
        action: 'warn-on-reuse',
        confidence: 'low',
        reason: 'any-contaminated semantic reuse caution',
      },
      citation: `[grounded, anyContamination.label = 'any-contaminated', measurements = ${JSON.stringify(ann.measurements ?? {})}]`,
    };
  }
  if (hasAnyMild) {
    return {
      state: 'has-any-only',
      labels: [...labels],
      measurements: ann.measurements,
      citation: `[grounded structural, any signal present, semantic caution: mild \`any\` occurrence, raw: ${JSON.stringify(ann.measurements ?? {})}]`,
    };
  }
  if (hasUnknownSurface) {
    return {
      state: 'unknown-surface-only',
      labels: [...labels],
      measurements: ann.measurements,
      citation: `[grounded structural, semantic caution: unknown-surface, raw: ${JSON.stringify(ann.measurements ?? {})}]`,
    };
  }

  // Annotation present but with no recognized labels — fall back to clean
  // with a cautionary citation. Future producers shouldn't hit this; if
  // they do, we surface an honest citation rather than silently collapsing.
  return {
    state: 'clean',
    citation: `[확인 불가, reason: anyContamination annotation present but labels[] empty or unrecognized: ${JSON.stringify(labels)}]`,
  };
}

// ── Resolver-confidence demotion (per-identity) ──────────────

function demoteResolverConfidence(ownerFile, { unresolvedInternalSpecifiers, filesWithParseErrors }) {
  let level = 'high';
  const taints = [];

  if (Array.isArray(filesWithParseErrors) && filesWithParseErrors.includes(ownerFile)) {
    level = 'low';
    taints.push(`defining-file-parse-error: '${ownerFile}'`);
  }

  if (Array.isArray(unresolvedInternalSpecifiers)) {
    for (const spec of unresolvedInternalSpecifiers) {
      if (specifierCouldMatchFile(spec, ownerFile) === 'match') {
        taints.push(`unresolved-specifier-could-match: '${spec}' ↔ '${ownerFile}'`);
        if (level === 'high') level = 'medium';
        else if (level === 'medium') level = 'low';
        break;
      }
    }
  }

  const citation = taints.length > 0
    ? `[degraded, resolver-confidence: ${level}, taints: ${JSON.stringify(taints)}]`
    : null;
  return { level, citation };
}

// ── Near-name hints (NOT_OBSERVED only) ──────────────────────

function enumerateSearchCandidates(defIndex, classMethodIndex) {
  const out = [];
  for (const [file, namesObj] of Object.entries(defIndex ?? {})) {
    for (const [name, defInfo] of Object.entries(namesObj ?? {})) {
      out.push({
        name,
        ownerFile: file,
        matchedField: 'defIndex',
        defInfo,
      });
    }
  }
  for (const [file, methodsByName] of Object.entries(classMethodIndex ?? {})) {
    for (const [name, records] of Object.entries(methodsByName ?? {})) {
      const list = Array.isArray(records) ? records : [records];
      for (const record of list) {
        if (!record || typeof record !== 'object') continue;
        out.push({
          name: record.name ?? record.methodName ?? name,
          ownerFile: record.ownerFile ?? file,
          matchedField: 'classMethodIndex',
          identity: record.identity,
          className: record.className,
          memberKind: record.memberKind,
          visibility: record.visibility,
          static: record.static === true,
          line: record.line,
        });
      }
    }
  }
  return out;
}

function candidateHintFields(candidate) {
  const out = {
    name: candidate.name,
    ownerFile: candidate.ownerFile,
  };
  if (candidate.matchedField) out.matchedField = candidate.matchedField;
  if (candidate.identity) out.identity = candidate.identity;
  const definitionKind = candidate.definitionKind ?? candidate.defInfo?.kind;
  if (definitionKind) out.definitionKind = definitionKind;
  if (candidate.matchedField === 'classMethodIndex') out.exportedName = candidate.name;
  if (candidate.className) out.className = candidate.className;
  if (candidate.memberKind) out.memberKind = candidate.memberKind;
  if (candidate.visibility) out.visibility = candidate.visibility;
  if (candidate.static) out.static = true;
  if (candidate.line) out.line = candidate.line;
  return out;
}

function computeNearNameCandidates(intentName, intentDeclaration, defIndex, classMethodIndex) {
  const candidates = [];
  const suppressedNearNames = [];
  const intentOwnerFile = intentOwnerFileHint(intentDeclaration);

  for (const candidate of enumerateSearchCandidates(defIndex, classMethodIndex)) {
    const { name } = candidate;
    if (name === intentName && candidate.matchedField !== 'classMethodIndex') continue;
    const matchedTokens = commonTokens(intentName, name);
    const hasCommonTokenSignal = matchedTokens.length > 0;
    if (hasOnlyWeakCommonTokens(intentName, name)) {
      suppressedNearNames.push({
        ...candidateHintFields(candidate),
        matchedTokens,
        reason: 'domain-token-overlap',
        locality: localityFor(candidate, intentOwnerFile),
      });
      continue;
    }

    // Cheap filter A (prefix): shared prefix ≥ 4 qualifies on a
    // relaxed length budget — `formatTimestamp` (15) vs `formatDate`
    // (10) is a legitimate hint despite delta 5. But `formatLongerName`
    // (16) vs `formatX` (7) is too divergent; cap the prefix-path
    // delta at intentName.length so the candidate is at most ~2× the
    // intent. Keeps "useful sibling hints" while rejecting extreme
    // length mismatches.
    const prefix = sharedPrefix(name, intentName);
    if (prefix >= NEAR_NAME_SHARED_PREFIX_MIN &&
        Math.abs(name.length - intentName.length) <= intentName.length) {
      const approxDist = levenshteinCapped(name, intentName, NEAR_NAME_MAX_DISTANCE * 4);
      candidates.push({ ...candidateHintFields(candidate), distance: approxDist });
      continue;
    }

    // Cheap filter B (length delta): without a shared prefix, Lev ≥ 3
    // is guaranteed when length delta ≥ 3. Skip without computing.
    const lengthDelta = Math.abs(name.length - intentName.length);
    if (lengthDelta > NEAR_NAME_MAX_LENGTH_DELTA) {
      if (hasCommonTokenSignal || prefix >= NEAR_NAME_SHARED_PREFIX_MIN) {
        suppressedNearNames.push({
          ...candidateHintFields(candidate),
          matchedTokens,
          lengthDelta,
          reason: 'near-length-delta-exceeded',
          locality: localityFor(candidate, intentOwnerFile),
        });
      }
      continue;
    }

    const dist = levenshteinCapped(name, intentName, NEAR_NAME_MAX_DISTANCE);
    if (dist <= NEAR_NAME_MAX_DISTANCE) {
      candidates.push({ ...candidateHintFields(candidate), distance: dist });
    } else if (hasCommonTokenSignal || prefix >= NEAR_NAME_SHARED_PREFIX_MIN) {
      suppressedNearNames.push({
        ...candidateHintFields(candidate),
        matchedTokens,
        distance: dist,
        reason: prefix < NEAR_NAME_SHARED_PREFIX_MIN && !hasCommonTokenSignal
          ? 'near-prefix-mismatch'
          : 'near-distance-exceeded',
        locality: localityFor(candidate, intentOwnerFile),
      });
    }
  }

  candidates.sort((a, b) =>
    a.distance - b.distance ||
    (a.matchedField === 'classMethodIndex' ? 0 : 1) - (b.matchedField === 'classMethodIndex' ? 0 : 1) ||
    a.name.localeCompare(b.name) ||
    a.ownerFile.localeCompare(b.ownerFile)
  );
  suppressedNearNames.sort((a, b) =>
    localityRank(b) - localityRank(a) ||
    (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY) ||
    (a.lengthDelta ?? Number.POSITIVE_INFINITY) - (b.lengthDelta ?? Number.POSITIVE_INFINITY) ||
    a.name.localeCompare(b.name) ||
    a.ownerFile.localeCompare(b.ownerFile)
  );
  return {
    nearNames: candidates.slice(0, NEAR_NAME_MAX_RESULTS),
    suppressedNearNames: capSuppressedCandidates(suppressedNearNames, NEAR_NAME_MAX_RESULTS),
    suppressedNearNameCount: suppressedNearNames.length,
  };
}

function computeSemanticHintCandidates(intentName, intentDeclaration, defIndex, classMethodIndex) {
  const queryTokens = uniqueTokens(intentName, intentDeclaration?.kind, intentDeclaration?.why);
  if (queryTokens.length === 0) return {
    semanticHints: [],
    suppressedSemanticHints: [],
    suppressedSemanticHintCount: 0,
    intentTokens: [],
  };
  const querySet = new Set(queryTokens);
  const semanticHints = [];
  const suppressedSemanticHints = [];
  const intentOwnerFile = intentOwnerFileHint(intentDeclaration);

  for (const candidate of enumerateSearchCandidates(defIndex, classMethodIndex)) {
    const { name } = candidate;
    if (name === intentName && candidate.matchedField !== 'classMethodIndex') continue;
    const fileStem = candidate.ownerFile.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? '';
    const ownerDir = candidate.ownerFile.split(/[\\/]/).slice(0, -1).join(' ');
    const candidateNameTokens = uniqueTokens(name);
    const candidateSupportTokens = uniqueTokens(fileStem, ownerDir, candidate.className);
    const candidateTokens = [...new Set([...candidateNameTokens, ...candidateSupportTokens])];
    const matchedTokens = candidateTokens.filter((token) => querySet.has(token));
    if (matchedTokens.length === 0) continue;

    const score = matchedTokens.length;
    if (score < SEMANTIC_HINT_MIN_SCORE) {
      if (matchedTokens.length === 1) {
        suppressedSemanticHints.push({
          ...candidateHintFields(candidate),
          matchedTokens,
          score,
          reason: matchedTokens.every(isWeakCommonToken)
            ? 'domain-token-overlap'
            : 'single-non-weak-token-only',
          locality: localityFor(candidate, intentOwnerFile),
        });
      }
      continue;
    }
    const matchedNameTokens = candidateNameTokens.filter((token) => querySet.has(token));
    const strongNameMatches = matchedNameTokens.filter((token) => !isWeakCommonToken(token));
    const strongSupportMatches = candidateSupportTokens
      .filter((token) =>
        querySet.has(token) &&
        !isWeakCommonToken(token) &&
        !strongNameMatches.includes(token)
      );
    if (strongNameMatches.length < 2 && !(strongNameMatches.length === 1 && strongSupportMatches.length >= 1)) {
      suppressedSemanticHints.push({
        ...candidateHintFields(candidate),
        matchedTokens,
        matchedNameTokens,
        matchedSupportTokens: strongSupportMatches,
        score,
        reason: matchedTokens.every(isWeakCommonToken)
          ? 'domain-token-overlap'
          : 'insufficient-non-weak-support',
        locality: localityFor(candidate, intentOwnerFile),
      });
      continue;
    }
    semanticHints.push({
      ...candidateHintFields(candidate),
      matchedTokens,
      matchedNameTokens,
      matchedSupportTokens: strongSupportMatches,
      score,
    });
  }

  const sortHints = (arr) => arr.sort((a, b) =>
    localityRank(b) - localityRank(a) ||
    b.score - a.score ||
    a.name.localeCompare(b.name) ||
    a.ownerFile.localeCompare(b.ownerFile)
  );
  const candidateCount = suppressedSemanticHints.length;
  return {
    semanticHints: sortHints(semanticHints).slice(0, SEMANTIC_HINT_MAX_RESULTS),
    suppressedSemanticHints: capSuppressedCandidates(
      sortHints(suppressedSemanticHints),
      SEMANTIC_HINT_MAX_RESULTS,
    ),
    suppressedSemanticHintCount: candidateCount,
    intentTokens: queryTokens,
  };
}

// ── Service-operation sibling policy (WT-23 P1) ──────────────

function normalizeDomainToken(token) {
  if (typeof token !== 'string') return null;
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 &&
      token.endsWith('s') &&
      !token.endsWith('ss') &&
      !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

function serviceOperationInfo(name) {
  const tokens = uniqueTokens(name);
  const verb = tokens[0] ?? null;
  let operationFamily = null;
  if (SERVICE_READ_QUERY_VERBS.has(verb)) {
    operationFamily = 'read-query';
  } else if (SERVICE_MUTATION_VERB_FAMILIES.has(verb)) {
    operationFamily = SERVICE_MUTATION_VERB_FAMILIES.get(verb);
  }

  const domainTokens = tokens
    .filter((token) => token !== verb && !SERVICE_OPERATION_VERBS.has(token))
    .map(normalizeDomainToken)
    .filter(Boolean);

  return {
    verb,
    operationFamily,
    domainTokens: [...new Set(domainTokens)],
  };
}

function policyExcludedPath(ownerFile) {
  const normalized = normalizeRelPath(ownerFile);
  if (!normalized) return false;
  const segments = normalized.split('/');
  return segments.some((segment) => SERVICE_POLICY_EXCLUDED_PATH_SEGMENTS.has(segment)) ||
    /\.bundle\.[cm]?[jt]sx?$/.test(normalized) ||
    /(^|\/)vendor\.[cm]?[jt]sx?$/.test(normalized);
}

function supportingReasonRank(reason) {
  switch (reason) {
    case 'single-non-weak-token-only':
      return 0;
    case 'near-distance-exceeded':
      return 1;
    case 'near-length-delta-exceeded':
      return 2;
    case 'domain-token-overlap':
      return 3;
    default:
      return 10;
  }
}

function sortSupportingReasons(reasons) {
  return [...new Set(reasons)].sort((a, b) =>
    supportingReasonRank(a) - supportingReasonRank(b) ||
    a.localeCompare(b)
  );
}

function mergeSuppressedPolicyCandidates(suppressedNearNames, suppressedSemanticHints) {
  const byIdentity = new Map();
  const append = (entry, lane) => {
    const identity = candidateIdentity(entry);
    if (!identity) return;
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, {
        ...candidateHintFields(entry),
        identity,
        locality: entry.locality ?? { sameDir: false, sameFile: false },
        supportingReasons: [],
        matchedTokens: [],
        suppressedLanes: [],
      });
    }
    const current = byIdentity.get(identity);
    if (localityRank(entry) > localityRank(current)) {
      current.locality = entry.locality ?? current.locality;
    }
    if (entry.reason) current.supportingReasons.push(entry.reason);
    if (Array.isArray(entry.matchedTokens)) {
      current.matchedTokens.push(...entry.matchedTokens);
    }
    current.suppressedLanes.push(lane);
    if (Number.isFinite(entry.distance)) current.distance = entry.distance;
    if (Number.isFinite(entry.lengthDelta)) current.lengthDelta = entry.lengthDelta;
    if (Number.isFinite(entry.score)) current.score = entry.score;
  };

  for (const entry of suppressedNearNames ?? []) append(entry, 'near-name');
  for (const entry of suppressedSemanticHints ?? []) append(entry, 'semantic');

  return [...byIdentity.values()].map((candidate) => ({
    ...candidate,
    supportingReasons: sortSupportingReasons(candidate.supportingReasons),
    matchedTokens: [...new Set(candidate.matchedTokens)],
    suppressedLanes: [...new Set(candidate.suppressedLanes)].sort(),
  }));
}

function servicePolicyBaseCandidate(candidate, reason = null) {
  const out = {
    identity: candidate.identity,
    name: candidate.name,
    ownerFile: candidate.ownerFile,
  };
  if (candidate.matchedField) out.matchedField = candidate.matchedField;
  if (candidate.definitionKind) out.definitionKind = candidate.definitionKind;
  if (reason) out.reason = reason;
  if (candidate.operationFamily) out.operationFamily = candidate.operationFamily;
  if (candidate.sharedDomainTokens) out.sharedDomainTokens = candidate.sharedDomainTokens;
  if (candidate.supportingReasons) out.supportingReasons = candidate.supportingReasons;
  if (candidate.locality) out.locality = candidate.locality;
  if (candidate.signatureSupport) out.signatureSupport = candidate.signatureSupport;
  if (candidate.suppressedLanes) out.suppressedLanes = candidate.suppressedLanes;
  return out;
}

function isNonCallableServiceDefinition(candidate) {
  return SERVICE_POLICY_NON_CALLABLE_DEFINITION_KINDS.has(candidate.definitionKind);
}

function sortServicePolicyEntries(entries) {
  return entries.sort((a, b) =>
    localityRank(b) - localityRank(a) ||
    String(a.operationFamily ?? '').localeCompare(String(b.operationFamily ?? '')) ||
    a.name.localeCompare(b.name) ||
    a.ownerFile.localeCompare(b.ownerFile) ||
    a.identity.localeCompare(b.identity)
  );
}

function emptyServiceOperationSiblingPolicy() {
  return {
    policyId: SERVICE_OPERATION_POLICY_ID,
    policyVersion: SERVICE_OPERATION_POLICY_VERSION,
    evaluatedCandidateCount: 0,
    promotedCandidateCount: 0,
    mutedCandidateCount: 0,
    promoted: [],
    muted: [],
  };
}

function computeServiceOperationSiblingPolicy({
  intentName,
  suppressedNearNames,
  suppressedSemanticHints,
}) {
  const policy = emptyServiceOperationSiblingPolicy();
  const candidates = mergeSuppressedPolicyCandidates(suppressedNearNames, suppressedSemanticHints);
  if (candidates.length === 0) return policy;

  const intentOperation = serviceOperationInfo(intentName);
  const intentDomainSet = new Set(intentOperation.domainTokens);
  const promoted = [];
  const muted = [];

  for (const candidate of candidates) {
    const candidateOperation = serviceOperationInfo(candidate.name);
    const candidateDomainSet = new Set(candidateOperation.domainTokens);
    const sharedDomainTokens = intentOperation.domainTokens
      .filter((token) => candidateDomainSet.has(token));
    const enriched = {
      ...candidate,
      operationFamily: candidateOperation.operationFamily,
      sharedDomainTokens,
      signatureSupport: {
        status: 'unavailable',
        reason: 'no-signature-facts',
      },
    };

    const hasPromotableSuppression = enriched.supportingReasons
      .some((reason) => SERVICE_POLICY_PROMOTABLE_REASONS.has(reason));
    let muteReason = null;
    if (!enriched.name || !enriched.ownerFile || !enriched.identity) {
      muteReason = 'service-sibling-insufficient-metadata';
    } else if (policyExcludedPath(enriched.ownerFile)) {
      muteReason = 'service-sibling-policy-excluded';
    } else if (enriched.matchedField && enriched.matchedField !== 'defIndex') {
      muteReason = 'service-sibling-surface-kind-unsupported';
    } else if (isNonCallableServiceDefinition(enriched)) {
      muteReason = 'service-sibling-non-callable-definition';
    } else if (!hasPromotableSuppression) {
      muteReason = 'service-sibling-insufficient-suppressed-support';
    } else if (!enriched.locality?.sameFile && !enriched.locality?.sameDir) {
      muteReason = 'service-sibling-locality-mismatch';
    } else if (!intentOperation.operationFamily || !candidateOperation.operationFamily) {
      muteReason = 'service-sibling-unknown-operation';
    } else if (intentDomainSet.size === 0 || sharedDomainTokens.length === 0) {
      muteReason = 'service-sibling-domain-mismatch';
    } else if (intentOperation.operationFamily !== candidateOperation.operationFamily) {
      muteReason = 'service-sibling-operation-family-mismatch';
    } else if (intentOperation.operationFamily !== 'read-query') {
      muteReason = 'service-sibling-family-not-promotable';
    }

    if (muteReason) {
      muted.push(servicePolicyBaseCandidate(enriched, muteReason));
    } else {
      promoted.push(servicePolicyBaseCandidate(enriched));
    }
  }

  policy.evaluatedCandidateCount = candidates.length;
  policy.promotedCandidateCount = promoted.length;
  policy.mutedCandidateCount = muted.length;
  policy.promoted = sortServicePolicyEntries(promoted).slice(0, SERVICE_OPERATION_POLICY_MAX_RESULTS);
  policy.muted = sortServicePolicyEntries(muted).slice(0, SERVICE_OPERATION_POLICY_MAX_RESULTS);
  return policy;
}

function emptyLocalOperationSiblingPolicy(status = 'not-run', reason = null) {
  const policy = {
    policyId: LOCAL_OPERATION_POLICY_ID,
    policyVersion: LOCAL_OPERATION_POLICY_VERSION,
    status,
    evaluatedCandidateCount: 0,
    promotedCandidateCount: 0,
    mutedCandidateCount: 0,
    promoted: [],
    muted: [],
  };
  if (reason) policy.reason = reason;
  return policy;
}

function localOperationPolicyCandidate(entry, enriched, reason = null) {
  const out = {
    identity: entry.identity,
    name: entry.name,
    ownerFile: normalizeRelPath(entry.ownerFile),
    matchedField: 'preWriteLocalOperationIndex',
    surfaceKind: 'nested-local-operation',
    operationFamily: enriched.operationFamily,
    sharedDomainTokens: enriched.sharedDomainTokens,
    locality: enriched.locality,
    eligibleForDeadExportRanking: entry.eligibleForDeadExportRanking === true,
    eligibleForSafeFix: entry.eligibleForSafeFix === true,
    signatureSupport: {
      status: 'unavailable',
      reason: 'no-signature-facts',
    },
  };
  if (Array.isArray(enriched.supportingReasons)) {
    out.supportingReasons = enriched.supportingReasons;
  }
  if (reason) out.reason = reason;
  if (entry.containerName) out.containerName = entry.containerName;
  if (entry.containerKind) out.containerKind = entry.containerKind;
  if (Number.isFinite(entry.line)) out.line = entry.line;
  if (Number.isFinite(entry.containerLine)) out.containerLine = entry.containerLine;
  if (Array.isArray(entry.domainTokens)) out.domainTokens = entry.domainTokens;
  return out;
}

function computeLocalOperationSiblingPolicy({
  intentName,
  intentDeclaration,
  preWriteLocalOperationIndex,
}) {
  if (!preWriteLocalOperationIndex || typeof preWriteLocalOperationIndex !== 'object') {
    return emptyLocalOperationSiblingPolicy('not-run', 'pre-write-local-operation-index-missing');
  }
  if (preWriteLocalOperationIndex.status !== 'complete') {
    return emptyLocalOperationSiblingPolicy(
      preWriteLocalOperationIndex.status ?? 'unavailable',
      preWriteLocalOperationIndex.reason ?? 'pre-write-local-operation-index-incomplete',
    );
  }

  const policy = emptyLocalOperationSiblingPolicy('complete');
  const ownerFile = intentOwnerFileHint(intentDeclaration);
  if (!ownerFile) {
    policy.reason = 'intent-owner-file-missing';
    return policy;
  }

  const entries = preWriteLocalOperationIndex.byOwnerFile?.[ownerFile] ?? [];
  if (!Array.isArray(entries) || entries.length === 0) return policy;

  const intentOperation = serviceOperationInfo(intentName);
  const intentDomainSet = new Set(intentOperation.domainTokens);
  const promoted = [];
  const muted = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const candidateName = entry.name;
    const candidateOperation = serviceOperationInfo(candidateName);
    const candidateDomainSet = new Set(candidateOperation.domainTokens);
    const sharedDomainTokens = intentOperation.domainTokens
      .filter((token) => candidateDomainSet.has(token));
    const enriched = {
      operationFamily: candidateOperation.operationFamily ?? entry.operationFamily ?? null,
      sharedDomainTokens,
      locality: localityFor(entry, ownerFile),
    };

    let muteReason = null;
    if (!entry.identity || !candidateName || !entry.ownerFile) {
      muteReason = 'local-operation-insufficient-metadata';
    } else if (entry.surfaceKind && entry.surfaceKind !== 'nested-local-operation') {
      muteReason = 'local-operation-surface-kind-unsupported';
    } else if (policyExcludedPath(entry.ownerFile)) {
      muteReason = 'local-operation-policy-excluded';
    } else if (!enriched.locality.sameFile) {
      muteReason = 'local-operation-locality-mismatch';
    } else if (!intentOperation.operationFamily || !enriched.operationFamily) {
      muteReason = 'local-operation-unknown-operation';
    } else if (intentDomainSet.size === 0 || sharedDomainTokens.length === 0) {
      muteReason = 'local-operation-domain-mismatch';
    } else if (intentOperation.operationFamily !== enriched.operationFamily) {
      muteReason = 'local-operation-family-mismatch';
    } else if (intentOperation.operationFamily !== 'read-query') {
      muteReason = 'local-operation-family-not-promotable';
    }

    if (muteReason) {
      muted.push(localOperationPolicyCandidate(entry, enriched, muteReason));
    } else {
      promoted.push(localOperationPolicyCandidate(entry, {
        ...enriched,
        supportingReasons: ['local-operation-same-file-domain-overlap'],
      }));
    }
  }

  policy.evaluatedCandidateCount = promoted.length + muted.length;
  policy.promotedCandidateCount = promoted.length;
  policy.mutedCandidateCount = muted.length;
  policy.promoted = sortServicePolicyEntries(promoted).slice(0, LOCAL_OPERATION_POLICY_MAX_RESULTS);
  policy.muted = sortServicePolicyEntries(muted).slice(0, LOCAL_OPERATION_POLICY_MAX_RESULTS);
  return policy;
}

// ── AST identity enumeration ─────────────────────────────────

function enumerateAstIdentities(intentName, defIndex) {
  const out = [];
  for (const [file, namesObj] of Object.entries(defIndex ?? {})) {
    if (namesObj && intentName in namesObj) {
      out.push({ ownerFile: file, defInfo: namesObj[intentName] });
    }
  }
  return out;
}

// ── Entry point ──────────────────────────────────────────────

/**
 * Look up a single name-candidate against symbols + canonical claims.
 *
 * @param {string} intentName
 * @param {{
 *   symbols: any,                                // parsed symbols.json
 *   canonicalClaims: Array<{                     // from _lib/pre-write-canonical-parser.mjs
 *     name: string,
 *     ownerFile: string,
 *     line: number,
 *     file: string,
 *     section: string,
 *   }>,
 *   unresolvedInternalSpecifiers?: string[],     // defaults to symbols.unresolvedInternalSpecifiers
 *   filesWithParseErrors?: string[],             // defaults to symbols.filesWithParseErrors
 * }} ctx
 * @returns {...}  (see maintainer history notes §4.3)
 */
export function lookupName(intentName, ctx) {
  const symbols = ctx?.symbols ?? {};
  const canonicalClaims = ctx?.canonicalClaims ?? [];
  const unresolvedInternalSpecifiers = ctx?.unresolvedInternalSpecifiers
    ?? symbols.unresolvedInternalSpecifiers
    ?? [];
  const filesWithParseErrors = ctx?.filesWithParseErrors
    ?? symbols.filesWithParseErrors
    ?? [];

  const supports = symbols?.meta?.supports ?? {};
  const defIndex = symbols?.defIndex ?? {};
  const classMethodIndex = symbols?.classMethodIndex ?? {};
  const intentDeclaration = ctx?.intentDeclaration ?? null;

  // 1. Canonical-first lookup.
  const canonicalClaim = canonicalClaims.find((c) => c.name === intentName) ?? null;

  // 2. AST identity enumeration.
  const astRows = enumerateAstIdentities(intentName, defIndex);

  // 3. Build per-identity rows.
  const citations = [];
  const identities = astRows.map(({ ownerFile, defInfo }) => {
    const identity = `${ownerFile}::${intentName}`;

    const fanInInfo = resolveFanIn(symbols, identity);
    citations.push(fanInInfo.citation);
    const fanInSpaceInfo = resolveFanInSpace(symbols, identity);
    citations.push(fanInSpaceInfo.citation);

    const contam = classifyContamination(defInfo, supports);
    citations.push(contam.citation);

    const resolver = demoteResolverConfidence(ownerFile, { unresolvedInternalSpecifiers, filesWithParseErrors });
    if (resolver.citation) citations.push(resolver.citation);

    const anyContamination = { state: contam.state };
    if (contam.labels) anyContamination.labels = contam.labels;
    if (contam.measurements) anyContamination.measurements = contam.measurements;
    if (contam.recommendation) anyContamination.recommendation = contam.recommendation;

    return {
      identity,
      ownerFile,
      exportedName: intentName,
      fanIn: fanInInfo.fanIn,
      fanInConfidence: fanInInfo.fanInConfidence,
      fanInSpace: fanInSpaceInfo.fanInSpace,
      fanInSpaceConfidence: fanInSpaceInfo.fanInSpaceConfidence,
      anyContamination,
      resolverConfidence: resolver.level,
      citations: [
        fanInInfo.citation,
        fanInSpaceInfo.citation,
        contam.citation,
        ...(resolver.citation ? [resolver.citation] : []),
      ],
    };
  });

  // 4. Determine canonicalAstStatus + result.
  let canonicalAstStatus;
  let result;

  if (!canonicalClaim) {
    canonicalAstStatus = 'not-consulted';
    if (identities.length === 0) result = 'NOT_OBSERVED';
    else if (identities.length === 1) result = 'EXISTS';
    else result = 'EXISTS_MULTIPLE';
  } else {
    if (identities.length === 0) {
      canonicalAstStatus = 'ast-absent';
      result = 'CANONICAL_EXISTS_AST_ABSENT';
    } else {
      const aligned = identities.some((i) => i.ownerFile === canonicalClaim.ownerFile);
      if (aligned) {
        canonicalAstStatus = 'aligned';
        result = 'CANONICAL_EXISTS_AND_EXISTS';
      } else {
        canonicalAstStatus = 'owner-disagrees';
        result = 'CANONICAL_EXISTS_AST_DISAGREE';
      }
    }
    citations.push(`[grounded, canonical/${canonicalClaim.file.split(/[\\/]/).pop()}:L${canonicalClaim.line} declares owner '${canonicalClaim.ownerFile}' for '${intentName}']`);
  }

  // 5. Near-name hints — only when no AST identity was found.
  const nearCandidateResult = identities.length === 0
    ? computeNearNameCandidates(intentName, intentDeclaration, defIndex, classMethodIndex)
    : { nearNames: [], suppressedNearNames: [], suppressedNearNameCount: 0 };
  const nearNames = nearCandidateResult.nearNames;
  const suppressedNearNames = nearCandidateResult.suppressedNearNames;
  const suppressedNearNameCount = nearCandidateResult.suppressedNearNameCount;
  const semanticCandidateResult = identities.length === 0
    ? computeSemanticHintCandidates(intentName, intentDeclaration, defIndex, classMethodIndex)
    : {
      semanticHints: [],
      suppressedSemanticHints: [],
      suppressedSemanticHintCount: 0,
      intentTokens: uniqueTokens(intentName, intentDeclaration?.kind, intentDeclaration?.why),
    };
  const semanticHints = semanticCandidateResult.semanticHints;
  const suppressedSemanticHints = semanticCandidateResult.suppressedSemanticHints;
  const suppressedSemanticHintCount = semanticCandidateResult.suppressedSemanticHintCount;
  const intentTokens = semanticCandidateResult.intentTokens;
  const serviceOperationSiblingPolicy = computeServiceOperationSiblingPolicy({
    intentName,
    suppressedNearNames,
    suppressedSemanticHints,
  });
  const localOperationSiblingPolicy = computeLocalOperationSiblingPolicy({
    intentName,
    intentDeclaration,
    preWriteLocalOperationIndex: symbols.preWriteLocalOperationIndex,
  });
  if (nearNames.length > 0) {
    citations.push(`[degraded, fuzzy-name match; source: symbols.json.defIndex/classMethodIndex name scan — search hint only, NOT a grounded reuse claim]`);
  }
  if (semanticHints.length > 0) {
    citations.push(`[degraded, intent-token match; source: symbols.json.defIndex/classMethodIndex plus intent.name/intent.why tokens — search hint only, NOT a grounded reuse claim]`);
  }
  if (identities.length === 0 && !supports.classMethodIndex) {
    citations.push(`[확인 불가, reason: symbols.meta.supports.classMethodIndex is not true; class-method search unavailable]`);
  }
  if (nearNames.length === 0 && semanticHints.length === 0 && identities.length === 0 && !canonicalClaim) {
    citations.push(`[확인 불가, scan range: symbols.json.defIndex/classMethodIndex does not contain '${intentName}'; no near-name or intent-token candidates either]`);
  }

  return {
    intentName,
    result,
    identities,
    canonicalClaim,
    canonicalAstStatus,
    intentTokens,
    nearNames,
    semanticHints,
    suppressedNearNames,
    suppressedNearNameCount,
    suppressedSemanticHints,
    suppressedSemanticHintCount,
    serviceOperationSiblingPolicy,
    localOperationSiblingPolicy,
    citations,
  };
}
