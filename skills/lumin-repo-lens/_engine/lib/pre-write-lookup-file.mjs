// File-candidate lookup for the pre-write gate (P1-2).
//
// Pure function. Given an intent file path, decide whether the file:
//   - FILE_EXISTS — positive evidence from topology.nodes or symbols.defIndex.
//   - NEW_FILE — positive absence evidence: topology.meta.complete === true,
//                path absent from topology.nodes, AND path absent from
//                symbols.filesWithParseErrors (parse-errored files are real).
//   - FILE_STATUS_UNKNOWN — honest "I cannot tell" default.
//
// Boundary evaluation in P1-2 is deliberately limited: the intent schema
// does not carry planned `from → to` edges, so boundary.status is ALWAYS
// 'NOT_EVALUATED' in this phase. Real ALLOWED/FORBIDDEN verdicts land
// starting P1-3 (or P2's post-write delta observes actual edges).
//
// Canonical anchors:
//   - canonical/pre-write-gate.md §3 Step 3 — lookup table
//   - canonical/pre-write-gate.md §5 — output format (New code candidates)
//   - canonical/fact-model.md §3.4 / §3.5 — topology-edge, boundary-rule
//   - maintainer history notes §4.1 — result shape + semantics

import { isTestLikePath } from './test-paths.mjs';
import { buildSubmoduleResolver } from './paths.mjs';
import path from 'node:path';

const DOMAIN_CLUSTER_MIN_MATCHES = 2;
const DOMAIN_CLUSTER_MAX_EXAMPLES = 8;
const DOMAIN_CLUSTER_MIN_PREFIX_LEN = 4;
const GENERIC_DOMAIN_PREFIXES = new Set([
  'index',
  'main',
  'test',
  'tests',
  'spec',
  'helper',
  'helpers',
  'utils',
  'util',
  'types',
  'type',
]);

// Normalize to forward-slash for cross-platform comparisons. The caller
// may pass either separator style; topology and defIndex keys are always
// forward-slash because producers use `relPath()` normalization.
function norm(p) {
  return p.replace(/\\/g, '/');
}

function fileExistsInTopology(intentFile, topology) {
  if (!topology || !topology.nodes) return false;
  return intentFile in topology.nodes;
}

function fileExistsInDefIndex(intentFile, symbols) {
  if (!symbols || !symbols.defIndex) return false;
  return intentFile in symbols.defIndex;
}

function fileIsParseError(intentFile, symbols) {
  if (!symbols || !Array.isArray(symbols.filesWithParseErrors)) return false;
  return symbols.filesWithParseErrors.includes(intentFile);
}

function topologyIsComplete(topology) {
  return topology?.meta?.complete === true;
}

function inboundFanIn(intentFile, topology) {
  if (!topology || !Array.isArray(topology.edges)) {
    return { value: null, confidence: 'unavailable' };
  }
  let count = 0;
  for (const e of topology.edges) {
    if (e.to === intentFile) count++;
  }
  return { value: count, confidence: 'grounded' };
}

function stripKnownExtension(fileName) {
  return fileName
    .replace(/\.d\.(?:mts|cts|ts)$/i, '')
    .replace(/\.(?:tsx|ts|jsx|js|mjs|cjs|mts|cts|json)$/i, '');
}

function splitNameTokens(baseName) {
  const spaced = baseName
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.\s]+/g, ' ')
    .trim();
  if (!spaced) return [];
  return spaced.split(/\s+/).filter(Boolean);
}

function normalizeDomainKey(value) {
  return normalizeDomainToken(value);
}

function normalizeDomainToken(value) {
  const raw = String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (raw.length > 4 && raw.endsWith('ies')) return `${raw.slice(0, -3)}y`;
  if (raw.length > 4 && raw.endsWith('s')) return raw.slice(0, -1);
  return raw;
}

function displayPrefixFromTokens(tokens) {
  if (tokens.length === 0) return '';
  return tokens[0] + tokens.slice(1).map((t) => t[0]?.toUpperCase() + t.slice(1)).join('');
}

function domainPrefixCandidates(intentFile) {
  const base = stripKnownExtension(path.posix.basename(intentFile));
  const tokens = splitNameTokens(base);
  const candidates = [];

  for (let count = tokens.length - 1; count >= 1; count--) {
    const prefixTokens = tokens.slice(0, count);
    const display = displayPrefixFromTokens(prefixTokens);
    const key = normalizeDomainKey(display);
    if (key.length < DOMAIN_CLUSTER_MIN_PREFIX_LEN) continue;
    if (GENERIC_DOMAIN_PREFIXES.has(key)) continue;
    candidates.push({ display, key });
  }

  const wholeKey = normalizeDomainKey(base);
  if (
    wholeKey.length >= DOMAIN_CLUSTER_MIN_PREFIX_LEN &&
    !GENERIC_DOMAIN_PREFIXES.has(wholeKey) &&
    !candidates.some((c) => c.key === wholeKey)
  ) {
    candidates.push({ display: base, key: wholeKey });
  }

  return candidates;
}

function domainTokenKeys(fileName) {
  const base = stripKnownExtension(fileName);
  return new Set(
    splitNameTokens(base)
      .map(normalizeDomainToken)
      .filter((key) =>
        key.length >= DOMAIN_CLUSTER_MIN_PREFIX_LEN &&
        !GENERIC_DOMAIN_PREFIXES.has(key)
      )
  );
}

function topologyNodeEntries(topology) {
  if (!topology || !topology.nodes || typeof topology.nodes !== 'object') return [];
  return Object.entries(topology.nodes)
    .filter(([file]) => typeof file === 'string')
    .map(([file, info]) => ({
      file: norm(file),
      loc: info && typeof info === 'object' && typeof info.loc === 'number'
        ? info.loc
        : null,
    }));
}

function findDomainCluster(intentFile, topology) {
  const entries = topologyNodeEntries(topology);
  if (entries.length === 0) return null;

  const dir = path.posix.dirname(intentFile);
  const sameDir = entries.filter((entry) =>
    path.posix.dirname(entry.file) === dir && entry.file !== intentFile
  );
  if (sameDir.length === 0) return null;

  for (const candidate of domainPrefixCandidates(intentFile)) {
    const matches = sameDir
      .filter((entry) => {
        const base = stripKnownExtension(path.posix.basename(entry.file));
        const basenameKey = normalizeDomainKey(base);
        const tokenKeys = domainTokenKeys(base);
        return basenameKey.startsWith(candidate.key) ||
          tokenKeys.has(candidate.key);
      })
      .sort((a, b) => a.file.localeCompare(b.file));

    if (matches.length < DOMAIN_CLUSTER_MIN_MATCHES) continue;

    const totalLoc = matches.reduce((sum, m) => sum + (typeof m.loc === 'number' ? m.loc : 0), 0);
    const locKnown = matches.some((m) => typeof m.loc === 'number');
    const prefixPath = dir === '.' ? candidate.display : `${dir}/${candidate.display}`;
    const examples = matches.slice(0, DOMAIN_CLUSTER_MAX_EXAMPLES);
    const prefixMatchCount = matches.filter((entry) =>
      normalizeDomainKey(stripKnownExtension(path.posix.basename(entry.file))).startsWith(candidate.key)
    ).length;

    return {
      kind: 'DOMAIN_CLUSTER_DETECTED',
      directory: dir,
      basenamePrefix: candidate.display,
      matchKind: prefixMatchCount === matches.length ? 'prefix' : 'domain-token',
      prefixPath,
      matchCount: matches.length,
      totalLoc: locKnown ? totalLoc : null,
      examples,
      omittedCount: Math.max(0, matches.length - examples.length),
      citations: [
        `[grounded, topology.json.nodes matched ${matches.length} files with domain key '${candidate.key}' in '${dir}']`,
      ],
    };
  }

  return null;
}

function resolveSubmodule(intentFile, root) {
  if (!root) return null;
  try {
    const resolver = buildSubmoduleResolver(root, { mode: 'single' });
    return resolver(intentFile) ?? null;
  } catch {
    return null;
  }
}

function computeTags(intentFile) {
  const tags = [];
  if (isTestLikePath(intentFile)) tags.push('test-only');
  return tags;
}

/**
 * @param {string} intentFile  root-relative path (forward slashes preferred;
 *                              backslashes normalized internally)
 * @param {{
 *   topology: object | null,
 *   symbols: object | null,
 *   triage: object | null,
 *   canonicalClaims?: Array,
 *   root: string | null,
 * }} ctx
 */
export function lookupFile(intentFile, ctx) {
  const norm_intent = norm(intentFile);
  const topology = ctx?.topology ?? null;
  const symbols = ctx?.symbols ?? null;
  const triage = ctx?.triage ?? null;
  const root = ctx?.root ?? null;

  const inTopology = fileExistsInTopology(norm_intent, topology);
  const inDefIndex = fileExistsInDefIndex(norm_intent, symbols);
  const isParseError = fileIsParseError(norm_intent, symbols);
  const topoComplete = topologyIsComplete(topology);

  // Inbound fan-in (available only from topology edges).
  const inbound = inboundFanIn(norm_intent, topology);

  const tags = computeTags(norm_intent);
  const submodule = resolveSubmodule(norm_intent, root);
  const citations = [];
  const domainCluster = findDomainCluster(norm_intent, topology);

  // ── Decide result ────────────────────────────────────────

  let result;
  let loc = null;

  if (inTopology) {
    result = 'FILE_EXISTS';
    loc = topology.nodes[norm_intent]?.loc ?? null;
    citations.push(`[grounded, topology.json.nodes['${norm_intent}'] present${loc !== null ? `, loc = ${loc}` : ''}]`);
  } else if (inDefIndex) {
    result = 'FILE_EXISTS';
    citations.push(`[grounded, symbols.json.defIndex['${norm_intent}'] has declared exports — file exists even if topology absent]`);
  } else if (isParseError) {
    // Real file that failed to parse. NOT new; NOT observably classified.
    result = 'FILE_STATUS_UNKNOWN';
    citations.push(`[확인 불가, reason: '${norm_intent}' is in symbols.filesWithParseErrors — file exists on disk but failed to parse; topology.nodes enumeration is non-authoritative here]`);
  } else if (topoComplete) {
    // Topology promises completeness AND the path isn't listed AND no
    // parse-error reason. Safe to claim NEW_FILE.
    result = 'NEW_FILE';
    citations.push(`[grounded, topology.json.nodes does not contain '${norm_intent}'; topology.meta.complete = true; symbols.filesWithParseErrors does not list it]`);
  } else if (topology) {
    // Topology present but completeness unverified.
    result = 'FILE_STATUS_UNKNOWN';
    citations.push(`[확인 불가, reason: topology present but topology.meta.complete is not true; absence-from-nodes is non-authoritative]`);
  } else {
    // No topology at all AND no defIndex entry.
    result = 'FILE_STATUS_UNKNOWN';
    citations.push(`[확인 불가, reason: topology absent and symbols.defIndex has no entry; file existence cannot be grounded]`);
  }

  if (inbound.confidence === 'grounded' && result === 'FILE_EXISTS') {
    citations.push(`[grounded, topology.json.edges inbound count for '${norm_intent}' = ${inbound.value}]`);
  } else if (inbound.confidence === 'unavailable' && result === 'FILE_EXISTS') {
    citations.push(`[확인 불가, reason: topology absent — inbound fan-in not countable]`);
  }

  // ── Boundary: ALWAYS NOT_EVALUATED in P1-2 ────────────────
  //
  // Intent has no planned `from → to` edge. Even when triage is present,
  // we cannot evaluate a rule without endpoints. This is a deliberate
  // P1-2 honesty floor — real ALLOWED / FORBIDDEN verdicts require
  // planned-edge information, deferred to P1-3.

  const boundary = {
    status: 'NOT_EVALUATED',
    rule: null,
  };
  if (!triage) {
    citations.push(`[확인 불가, reason: triage.json absent — boundary evaluation not available]`);
  } else {
    citations.push(`[확인 불가, reason: P1-2 intent carries no planned from→to edge; boundary rules consulted only when endpoints are known (P1-3)]`);
  }

  return {
    kind: 'file',
    intentFile: norm_intent,
    result,
    loc,
    inboundFanIn: inbound.value,
    inboundFanInConfidence: inbound.confidence,
    submodule,
    boundary,
    tags,
    domainCluster,
    citations,
  };
}
