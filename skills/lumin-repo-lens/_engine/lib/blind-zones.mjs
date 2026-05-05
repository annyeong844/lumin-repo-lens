// Standardized blind-zone detection for audit artifacts.
//
// Motivation (v1.9.9): blind spots used to live only in prose
// documentation — SKILL.md said "Rust not supported," tests/README.md
// said "Python method resolution is blind." These notes didn't reach
// the end user's audit report in any machine-readable form, so Claude
// had to remember them from context rather than read them from the
// run output. That's the exact shape of drift the reviewer called
// out: "blindZones는 문서가 아니라 artifact에 있어야 해."
//
// This module inspects the artifacts produced by a full audit run
// (triage.json, symbols.json, dead-classify.json) and returns a
// structured list the orchestrator can write into manifest.json:
//
//   [
//     { area: 'rust',                     severity: 'scan-gap',
//       files: 18, effect: 'Do not make repo-wide absence claims.' },
//     { area: 'resolver',                 severity: 'confidence-gap',
//       unresolvedInternalRatio: 0.22,
//       effect: 'Tier C dead-export claims must be reviewed.' },
//     { area: 'python-method-resolution', severity: 'precision-gap',
//       effect: 'Method-level dead-code claims are degraded.' },
//   ]
//
// Claude reads manifest.blindZones and naturally produces outputs
// like: "This repo contains 18 Rust files; I am limiting absence
// claims to the TS/JS graph only."

import { JS_FAMILY_LANGS } from './lang.mjs';

// Extractors currently registered in the pipeline. If triage reports
// files in a language NOT in this set, we raise a scan-gap blind zone.
// JS_FAMILY_LANGS shared source: `_lib/lang.mjs` (single truth per v1.8.3).
const SUPPORTED_LANGS = new Set([
  ...JS_FAMILY_LANGS,
  'py', // Python: partial — function/class/__all__ yes, method resolution no
  'go', // Go: tree-sitter-based, limited
]);

const RESOLVER_RATIO_THRESHOLD = 0.15;
const RESOLVER_ABSOLUTE_UNRESOLVED_THRESHOLD = 1000;
const RESOLVER_PREFIX_CONCENTRATION_MIN_UNRESOLVED = 100;
const RESOLVER_PREFIX_CONCENTRATION_MIN_COUNT = 100;
const RESOLVER_PREFIX_CONCENTRATION_SHARE = 0.8;

/**
 * @typedef {Object} BlindZone
 * @property {string} area
 * @property {'scan-gap' | 'precision-gap' | 'confidence-gap'} severity
 * @property {string} effect
 * @property {Object} [details]
 */

/**
 * @param {BlindZone[]} zones
 * @param {string[]} areas
 */
function hasArea(zones, ...areas) {
  return zones.some((z) => areas.includes(z.area));
}

function languageSupportState(symbols) {
  const languageSupport = symbols?.meta?.languageSupport ?? null;
  return {
    languageSupport,
    pythonEnabled: languageSupport?.python ? languageSupport.python.enabled === true : true,
    goEnabled: languageSupport?.go ? languageSupport.go.enabled === true : true,
  };
}

function pythonZone(files, support) {
  if (support.pythonEnabled) {
    return {
      area: 'python-method-resolution',
      severity: 'precision-gap',
      effect: 'Method-level dead-code claims are degraded. ' +
              '__getattr__ / lazy export maps not detected.',
      details: { files },
    };
  }
  return {
    area: 'python-scan-gap',
    severity: 'scan-gap',
    effect: 'Python files were counted by triage but were not included in the symbol graph; do not make Python absence claims.',
    details: {
      files,
      reason: support.languageSupport?.python?.reason ?? 'python extractor unavailable',
    },
  };
}

function goZone(files, support) {
  if (support.goEnabled) {
    return {
      area: 'go-method-resolution',
      severity: 'precision-gap',
      effect: 'Method-level and interface-dispatch claims are degraded.',
      details: { files },
    };
  }
  return {
    area: 'go-scan-gap',
    severity: 'scan-gap',
    effect: 'Go files were counted by triage but were not included in the symbol graph; do not make Go absence claims.',
    details: {
      files,
      reason: support.languageSupport?.go?.reason ?? 'tree-sitter unavailable',
    },
  };
}

function detectShapeZones(triage, support) {
  const shape = triage?.shape ?? null;
  if (!shape || typeof shape.totalFiles !== 'number') return [];

  const zones = [];
  const known =
    (shape.tsFiles   ?? 0) +
    (shape.jsFiles   ?? 0) +
    (shape.pyFiles   ?? 0) +
    (shape.goFiles   ?? 0);
  // Note: testFiles is a SUBSET of the others, so it's already counted.
  const unknown = shape.totalFiles - known;
  if (shape.totalFiles > 0 && unknown > 0 && unknown / shape.totalFiles >= 0.1) {
    zones.push({
      area: 'unclassified-files',
      severity: 'scan-gap',
      effect:
        `Do not make repo-wide absence claims; ${unknown} file(s) ` +
        'are not in a language with a registered extractor ' +
        '(could be Rust, Kotlin, Swift, etc. — or non-source).',
      details: { unknownFiles: unknown, totalFiles: shape.totalFiles },
    });
  }

  if ((shape.pyFiles ?? 0) > 0) zones.push(pythonZone(shape.pyFiles, support));
  if ((shape.goFiles ?? 0) > 0) zones.push(goZone(shape.goFiles, support));
  return zones;
}

function detectByLanguageZones(triage, support, existingZones) {
  const byLang = triage?.byLanguage ?? triage?.languages ?? triage?.summary?.byLanguage ?? null;
  if (!byLang || typeof byLang !== 'object') return [];

  const zones = [];
  for (const [lang, count] of Object.entries(byLang)) {
    const n = typeof count === 'number' ? count : (count?.files ?? 0);
    if (n <= 0) continue;
    const allZones = [...existingZones, ...zones];
    if (!SUPPORTED_LANGS.has(lang) && !hasArea(allZones, 'unclassified-files', lang)) {
      zones.push({
        area: lang,
        severity: 'scan-gap',
        effect: `Do not make repo-wide absence claims; ${n} ${lang} file(s) not analyzed.`,
        details: { files: n, reason: 'extractor-not-registered' },
      });
    }
    if (lang === 'py' && !hasArea(allZones, 'python-method-resolution', 'python-scan-gap')) {
      zones.push(pythonZone(n, support));
    }
    if (lang === 'go' && !hasArea(allZones, 'go-method-resolution', 'go-scan-gap')) {
      zones.push(goZone(n, support));
    }
  }
  return zones;
}

function topUnresolvedReasons(records) {
  const counts = new Map();
  for (const rec of records ?? []) {
    const reason = rec?.reason;
    if (typeof reason !== 'string' || reason.length === 0) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 5);
}

function topUnresolvedReasonsFromSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const reasons = [];
  for (const [reason, group] of Object.entries(summary)) {
    if (!reason || !group || typeof group !== 'object') continue;
    const count = group.count;
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
    reasons.push({
      reason,
      count,
      ...(group.resolverStages && typeof group.resolverStages === 'object'
        ? { resolverStages: group.resolverStages }
        : {}),
      ...(group.hints && typeof group.hints === 'object' ? { hints: group.hints } : {}),
    });
  }
  if (reasons.length === 0) return null;
  return reasons
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 5);
}

export function formatUnresolvedReasonCounts(reasons, limit = 3) {
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  const parts = [];
  for (const item of reasons.slice(0, limit)) {
    if (!item?.reason || typeof item.count !== 'number') continue;
    parts.push(`${item.reason} ${item.count}`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

function detectResolverZone(symbols) {
  const r = symbols?.uses?.unresolvedInternalRatio;
  const unresolvedInternal = symbols?.uses?.unresolvedInternal;
  const top = symbols?.topUnresolvedSpecifiers?.slice(0, 3) ?? [];
  const topCount = top[0]?.count;
  const ratioTrigger = typeof r === 'number' && r >= RESOLVER_RATIO_THRESHOLD;
  const absoluteTrigger =
    typeof unresolvedInternal === 'number' &&
    unresolvedInternal >= RESOLVER_ABSOLUTE_UNRESOLVED_THRESHOLD;
  const prefixTrigger =
    typeof unresolvedInternal === 'number' &&
    unresolvedInternal >= RESOLVER_PREFIX_CONCENTRATION_MIN_UNRESOLVED &&
    typeof topCount === 'number' &&
    topCount >= RESOLVER_PREFIX_CONCENTRATION_MIN_COUNT &&
    topCount / Math.max(unresolvedInternal, 1) >= RESOLVER_PREFIX_CONCENTRATION_SHARE;
  if (!ratioTrigger && !absoluteTrigger && !prefixTrigger) return null;
  const trigger = ratioTrigger
    ? 'ratio'
    : absoluteTrigger
      ? 'absolute-count'
      : 'prefix-concentration';
  return {
    area: 'resolver',
    severity: 'confidence-gap',
    effect: 'Tier C dead-export claims must be reviewed; ' +
            'the resolver failed to resolve a significant fraction, count, or concentrated prefix ' +
            'of internal imports. See FP-36 in references/false-positive-index.md.',
    details: {
      trigger,
      unresolvedInternalRatio: r,
      unresolvedInternal,
      topUnresolvedSpecifiers: top.map((t) => t.specifierPrefix ?? t),
      topUnresolvedReasons:
        topUnresolvedReasonsFromSummary(symbols?.unresolvedInternalSummaryByReason) ??
        topUnresolvedReasons(symbols?.unresolvedInternalSpecifierRecords),
    },
  };
}

function detectParserZone(symbols) {
  const warnings = symbols?.meta?.warnings ?? [];
  const parseWarning = warnings.find((w) => w?.kind === 'parse-errors' ||
                                           w?.type === 'parse-errors' ||
                                           /parse/i.test(w?.message ?? ''));
  if (!parseWarning) return null;
  return {
    area: 'parser',
    severity: 'precision-gap',
    effect: 'Graph is partial — some files failed to parse; ' +
            'their defs and uses are missing from the analysis.',
    details: {
      count: parseWarning.count ?? null,
      message: parseWarning.message ?? null,
    },
  };
}

/**
 * Detect blind zones from available artifacts. Any artifact may be
 * null (the orchestrator passes what's on disk); missing inputs
 * silently skip their detection branch. Never invents blind zones
 * out of missing data — the whole point is honest reporting.
 *
 * @param {{triage?: object | null, symbols?: object | null, deadClassify?: object | null}} artifacts
 * @returns {BlindZone[]}
 */
export function detectBlindZones({ triage, symbols, deadClassify: _deadClassify }) {
  const support = languageSupportState(symbols);
  const zones = [
    ...detectShapeZones(triage, support),
  ];

  zones.push(...detectByLanguageZones(triage, support, zones));
  const resolverZone = detectResolverZone(symbols);
  if (resolverZone) zones.push(resolverZone);
  const parserZone = detectParserZone(symbols);
  if (parserZone) zones.push(parserZone);
  return zones;
}

/**
 * Compact one-line summary suitable for the orchestrator's console
 * output. Empty if no zones detected.
 */
export function formatBlindZonesSummary(zones) {
  if (!zones.length) return null;
  const bySeverity = { 'scan-gap': 0, 'precision-gap': 0, 'confidence-gap': 0 };
  for (const z of zones) bySeverity[z.severity] = (bySeverity[z.severity] ?? 0) + 1;
  const parts = [];
  if (bySeverity['scan-gap']) parts.push(`${bySeverity['scan-gap']} scan-gap`);
  if (bySeverity['precision-gap']) parts.push(`${bySeverity['precision-gap']} precision-gap`);
  if (bySeverity['confidence-gap']) parts.push(`${bySeverity['confidence-gap']} confidence-gap`);
  const resolverZone = zones.find((z) => z?.area === 'resolver');
  const resolverReasons = formatUnresolvedReasonCounts(resolverZone?.details?.topUnresolvedReasons);
  return `blindZones: ${parts.join(', ')}${resolverReasons ? `; resolver reasons: ${resolverReasons}` : ''}`;
}
