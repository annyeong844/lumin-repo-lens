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
const SEMANTIC_WEAK_VERBS = new Set([
  'add', 'build', 'check', 'create', 'delete', 'get', 'load', 'make', 'parse',
  'read', 'return', 'save', 'set', 'update', 'write',
]);

// ── Helpers ──────────────────────────────────────────────────

function sharedPrefix(a, b) {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}

function splitSemanticTokens(value) {
  return String(value ?? '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeSemanticToken)
    .filter((token) =>
      token.length >= 2 &&
      !SEMANTIC_STOP_TOKENS.has(token)
    );
}

function normalizeSemanticToken(token) {
  const t = String(token ?? '').toLowerCase();
  if (t === 'rel') return 'relative';
  if (t === 'ctx') return 'context';
  if (t === 'cfg') return 'config';
  if (t === 'config') return 'configuration';
  if (t === 'exists' || t === 'existing' || t === 'existence') return 'exist';
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

function uniqueTokens(...parts) {
  return [...new Set(parts.flatMap(splitSemanticTokens))];
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

function computeNearNames(intentName, defIndex) {
  const candidates = [];

  for (const [file, namesObj] of Object.entries(defIndex ?? {})) {
    for (const name of Object.keys(namesObj ?? {})) {
      if (name === intentName) continue;

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
        candidates.push({ name, ownerFile: file, distance: approxDist });
        continue;
      }

      // Cheap filter B (length delta): without a shared prefix, Lev ≥ 3
      // is guaranteed when length delta ≥ 3. Skip without computing.
      if (Math.abs(name.length - intentName.length) > NEAR_NAME_MAX_LENGTH_DELTA) continue;

      const dist = levenshteinCapped(name, intentName, NEAR_NAME_MAX_DISTANCE);
      if (dist <= NEAR_NAME_MAX_DISTANCE) {
        candidates.push({ name, ownerFile: file, distance: dist });
      }
    }
  }

  candidates.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return candidates.slice(0, NEAR_NAME_MAX_RESULTS);
}

function computeSemanticHints(intentName, intentDeclaration, defIndex) {
  const queryTokens = uniqueTokens(intentName, intentDeclaration?.kind, intentDeclaration?.why);
  if (queryTokens.length === 0) return [];
  const querySet = new Set(queryTokens);
  const candidates = [];

  for (const [file, namesObj] of Object.entries(defIndex ?? {})) {
    for (const name of Object.keys(namesObj ?? {})) {
      if (name === intentName) continue;
      const fileStem = file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? '';
      const ownerDir = file.split(/[\\/]/).slice(0, -1).join(' ');
      const candidateNameTokens = uniqueTokens(name);
      const candidateSupportTokens = uniqueTokens(fileStem, ownerDir);
      const candidateTokens = [...new Set([...candidateNameTokens, ...candidateSupportTokens])];
      const matchedTokens = candidateTokens.filter((token) => querySet.has(token));
      if (matchedTokens.length === 0) continue;

      const score = matchedTokens.length;
      if (score < SEMANTIC_HINT_MIN_SCORE) continue;
      const matchedNameTokens = candidateNameTokens.filter((token) => querySet.has(token));
      const strongNameMatches = matchedNameTokens.filter((token) => !SEMANTIC_WEAK_VERBS.has(token));
      const strongSupportMatches = candidateSupportTokens
        .filter((token) =>
          querySet.has(token) &&
          !SEMANTIC_WEAK_VERBS.has(token) &&
          !strongNameMatches.includes(token)
        );
      if (strongNameMatches.length < 2 && !(strongNameMatches.length === 1 && strongSupportMatches.length >= 1)) {
        continue;
      }
      candidates.push({
        name,
        ownerFile: file,
        matchedTokens,
        matchedNameTokens,
        matchedSupportTokens: strongSupportMatches,
        score,
      });
    }
  }

  candidates.sort((a, b) =>
    b.score - a.score ||
    a.ownerFile.localeCompare(b.ownerFile) ||
    a.name.localeCompare(b.name)
  );
  return candidates.slice(0, SEMANTIC_HINT_MAX_RESULTS);
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
      anyContamination,
      resolverConfidence: resolver.level,
      citations: [fanInInfo.citation, contam.citation, ...(resolver.citation ? [resolver.citation] : [])],
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
  const nearNames = identities.length === 0
    ? computeNearNames(intentName, defIndex)
    : [];
  const semanticHints = identities.length === 0
    ? computeSemanticHints(intentName, intentDeclaration, defIndex)
    : [];
  if (nearNames.length > 0) {
    citations.push(`[degraded, fuzzy-name match; source: symbols.json.defIndex name scan — search hint only, NOT a grounded reuse claim]`);
  }
  if (semanticHints.length > 0) {
    citations.push(`[degraded, intent-token match; source: symbols.json.defIndex plus intent.name/intent.why tokens — search hint only, NOT a grounded reuse claim]`);
  }
  if (nearNames.length === 0 && semanticHints.length === 0 && identities.length === 0 && !canonicalClaim) {
    citations.push(`[확인 불가, scan range: symbols.json.defIndex does not contain '${intentName}'; no near-name or intent-token candidates either]`);
  }

  return {
    intentName,
    result,
    identities,
    canonicalClaim,
    canonicalAstStatus,
    nearNames,
    semanticHints,
    citations,
  };
}
