// _lib/canon-draft-naming.mjs — P3-4 naming classifier + aggregator + renderer.
//
// Extracted from `_lib/canon-draft.mjs` during post-P3 cleanup (2026-04-21).
//
// Identity shape: **cohort-keyed**. File cohorts keyed on `<submodule>`,
// symbol cohorts keyed on `<submodule>::<kind>`. NOT `ownerFile::exportedName`
// (that's per-item). Per-item rows (§3 outliers) use `<ownerFile>` for file
// items and `<ownerFile>::<exportedName>` for symbol items.

import {
  escapeMdCell,
  codeCell,
} from './canon-draft-utils.mjs';

// ── detectConvention(name) — pure string classifier (§12.5) ──

const RE_CAMEL = /^[a-z][a-zA-Z0-9]*$/;
const RE_PASCAL = /^[A-Z][a-zA-Z0-9]*$/;
const RE_KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const RE_SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const RE_UPPER_SNAKE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
const RE_SINGLE_LOWER = /^[a-z][a-z0-9]*$/;
const RE_SINGLE_UPPER = /^[A-Z][A-Z0-9]*$/;
const RE_SINGLE_MIXED = /^[A-Z][a-z0-9]*$/;

/**
 * Classify a name's casing convention. Returns one of NAMING_CONVENTIONS.
 * @param {string} name
 * @returns {string}
 */
export function detectConvention(name) {
  if (typeof name !== 'string' || name.length === 0) return 'mixed';

  if (RE_KEBAB.test(name)) return 'kebab-case';
  if (RE_UPPER_SNAKE.test(name) && name.includes('_')) return 'UPPER_SNAKE';
  if (RE_SNAKE.test(name)) return 'snake_case';

  if (RE_PASCAL.test(name) && /[A-Z].*[a-z]/.test(name)) return 'PascalCase';
  if (RE_CAMEL.test(name) && /[a-z].*[A-Z]/.test(name)) return 'camelCase';

  // Single-segment defaults. bare-uppercase before mixed.
  if (RE_SINGLE_UPPER.test(name)) return 'UPPER_SNAKE';
  if (RE_SINGLE_MIXED.test(name)) return 'PascalCase';
  if (RE_SINGLE_LOWER.test(name)) return 'camelCase';

  return 'mixed';
}

// ── normalizeFileBasename(filePath) — canonical §12.6 ───────

const LANG_EXTENSIONS = ['.d.ts', '.mjs', '.tsx', '.mts', '.cts', '.cjs', '.jsx', '.ts', '.js'];
const MULTI_PART_SUFFIXES = ['.test', '.spec', '.stories', '.d'];

/**
 * Strip directory, final language extension, and multi-part suffix.
 * @param {string} filePath
 * @returns {string}
 */
export function normalizeFileBasename(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return '';
  const norm = filePath.replace(/\\/g, '/');
  const lastSlash = norm.lastIndexOf('/');
  let basename = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm;
  // Longest-extension-first match (`.d.ts` before `.ts`).
  for (const ext of LANG_EXTENSIONS) {
    if (basename.toLowerCase().endsWith(ext)) {
      basename = basename.slice(0, -ext.length);
      break;
    }
  }
  for (const suffix of MULTI_PART_SUFFIXES) {
    if (basename.toLowerCase().endsWith(suffix)) {
      basename = basename.slice(0, -suffix.length);
      break;
    }
  }
  return basename;
}

// ── Cohort classifier (canonical §12.1) ─────────────────────

export function classifyNamingCohort({ members, kind, lowInfoExclusions }) {
  if (!Array.isArray(members)) {
    throw new Error('classifyNamingCohort requires members: Array<{name}>');
  }
  const exclusions = lowInfoExclusions instanceof Set ? lowInfoExclusions : new Set();

  const observed = members.map((m) => {
    const rawName = m?.name ?? '';
    const nameForDetection = kind === 'file' ? normalizeFileBasename(rawName) : rawName;
    const isLowInfoName = kind === 'file'
      ? exclusions.has(normalizeFileBasename(rawName))
      : exclusions.has(rawName);
    return {
      rawName,
      isLowInfoName,
      convention: detectConvention(nameForDetection),
    };
  });

  const effective = observed.filter((o) => !o.isLowInfoName);

  if (effective.length < 3) {
    return {
      label: 'insufficient-evidence',
      marker: 'ℹ',
      dominantConvention: null,
      effectiveMembers: effective.length,
      totalMembers: members.length,
      consistencyRate: 0,
    };
  }

  const counts = new Map();
  for (const o of effective) {
    counts.set(o.convention, (counts.get(o.convention) ?? 0) + 1);
  }
  let topConv = null;
  let topCount = 0;
  for (const [conv, count] of counts) {
    if (count > topCount) { topConv = conv; topCount = count; }
  }
  const dominance = topCount / effective.length;

  if (dominance >= 0.6 && topConv !== 'mixed') {
    return {
      label: `${topConv}-dominant`,
      marker: '✅',
      dominantConvention: topConv,
      effectiveMembers: effective.length,
      totalMembers: members.length,
      consistencyRate: dominance,
    };
  }
  return {
    label: 'mixed-convention',
    marker: '⚠',
    dominantConvention: null,
    effectiveMembers: effective.length,
    totalMembers: members.length,
    consistencyRate: dominance,
  };
}

// ── Per-item classifier (canonical §12.2) ───────────────────

export function classifyNamingItem({ convention, dominantConvention, isLowInfo }) {
  if (isLowInfo === true) return { label: 'low-info-excluded', marker: 'ℹ' };
  if (dominantConvention === null || dominantConvention === undefined) {
    return { label: 'convention-match', marker: '✅' };
  }
  if (convention === dominantConvention) return { label: 'convention-match', marker: '✅' };
  return { label: 'convention-outlier', marker: '⚠' };
}

// ── Naming aggregator (maintainer history notes v2 §5.3) ──────────────────

const NAMING_TYPE_KINDS = new Set([
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
]);

function classifySymbolCohortKind(def) {
  if (!def || typeof def.kind !== 'string') return null;
  if (NAMING_TYPE_KINDS.has(def.kind)) return 'type-export';
  if (def.kind === 'FunctionDeclaration') return 'helper-export';
  if (def.kind === 'const-var' || def.kind === 'let-var' || def.kind === 'var-var') {
    if (def.initType === 'ArrowFunctionExpression' || def.initType === 'FunctionExpression') {
      return 'helper-export';
    }
    return 'constant-export';
  }
  return null;
}

/**
 * @param {{
 *   files: string[],
 *   root: string,
 *   extractFn: (filePath: string) => {defs, uses, reExports},
 *   submoduleOf: (absPath: string) => string,
 *   lowInfoNames?: Set<string>,
 *   lowInfoHelperNames?: Set<string>,
 * }} input
 */
// ── collectNamingCohorts passes (extracted during post-P3 cleanup) ──

function makeNamingToRelative(root) {
  const rootNormalized = typeof root === 'string' ? root.replace(/\\/g, '/').replace(/\/$/, '') : '';
  return (abs) => {
    if (!rootNormalized) return abs.replace(/\\/g, '/');
    const norm = abs.replace(/\\/g, '/');
    if (norm.startsWith(rootNormalized + '/')) return norm.slice(rootNormalized.length + 1);
    return norm;
  };
}

// Pass 1: file cohorts (always — canonical P0-6 / §12 requires every scanned
// file to contribute to its submodule's file cohort regardless of whether
// the file has any exports).
function buildFileCohorts(files, submoduleOf, toRelative) {
  const fileCohorts = new Map();
  for (const absFile of files) {
    const submodule = submoduleOf(absFile) ?? 'root';
    if (!fileCohorts.has(submodule)) {
      fileCohorts.set(submodule, { cohortId: submodule, members: [], kind: 'file', submodule });
    }
    fileCohorts.get(submodule).members.push({ name: toRelative(absFile) });
  }
  return fileCohorts;
}

// Pass 2: symbol cohorts via fresh AST extraction. Parse failures surface
// as diagnostics; classifiable exports (§12 kinds) contribute to
// `<submodule>::<kind>` cohorts.
function buildSymbolCohorts(files, extractFn, submoduleOf, toRelative, diagnostics) {
  const symbolCohorts = new Map();
  for (const absFile of files) {
    let parsed;
    try {
      parsed = extractFn(absFile);
    } catch (err) {
      diagnostics.push({
        kind: 'parse-error',
        reason: 'parse-error',
        target: toRelative(absFile),
        note: (err && err.message) || String(err),
      });
      continue;
    }
    const submodule = submoduleOf(absFile) ?? 'root';
    for (const def of (parsed.defs || [])) {
      const cohortKind = classifySymbolCohortKind(def);
      if (!cohortKind) continue;
      const cohortId = `${submodule}::${cohortKind}`;
      if (!symbolCohorts.has(cohortId)) {
        symbolCohorts.set(cohortId, {
          cohortId, members: [], kind: 'symbol', symbolKind: cohortKind, submodule,
        });
      }
      symbolCohorts.get(cohortId).members.push({
        name: def.name,
        ownerFile: toRelative(absFile),
        line: def.line,
      });
    }
  }
  return symbolCohorts;
}

// Pass 3a: classify file cohorts + attribute per-item outliers. Mutates
// `cohort.classification`; returns outlier/low-info per-item rows.
function classifyFileCohortsInPlace(fileCohorts, lowInfoAll) {
  const rows = [];
  for (const [cohortId, cohort] of fileCohorts) {
    const classification = classifyNamingCohort({
      cohortId, members: cohort.members, kind: 'file',
      lowInfoExclusions: lowInfoAll,
    });
    cohort.classification = classification;
    for (const m of cohort.members) {
      const normBase = normalizeFileBasename(m.name);
      const observedConvention = detectConvention(normBase);
      const isLowInfo = lowInfoAll.has(normBase);
      const itemClassification = classifyNamingItem({
        convention: observedConvention,
        dominantConvention: classification.dominantConvention,
        isLowInfo,
      });
      if (itemClassification.label === 'convention-match') continue;
      rows.push({
        identity: m.name,  // file item: <ownerFile>
        cohortId,
        cohortKind: 'file',
        name: normBase,
        observedConvention,
        dominantConvention: classification.dominantConvention,
        itemLabel: itemClassification.label,
        itemMarker: itemClassification.marker,
      });
    }
  }
  return rows;
}

// Pass 3b: classify symbol cohorts + attribute per-item outliers.
function classifySymbolCohortsInPlace(symbolCohorts, lowInfoAll) {
  const rows = [];
  for (const [cohortId, cohort] of symbolCohorts) {
    const classification = classifyNamingCohort({
      cohortId, members: cohort.members, kind: 'symbol',
      lowInfoExclusions: lowInfoAll,
    });
    cohort.classification = classification;
    for (const m of cohort.members) {
      const observedConvention = detectConvention(m.name);
      const isLowInfo = lowInfoAll.has(m.name);
      const itemClassification = classifyNamingItem({
        convention: observedConvention,
        dominantConvention: classification.dominantConvention,
        isLowInfo,
      });
      if (itemClassification.label === 'convention-match') continue;
      rows.push({
        identity: `${m.ownerFile}::${m.name}`,  // symbol item: <ownerFile>::<exportedName>
        cohortId,
        cohortKind: 'symbol',
        name: m.name,
        observedConvention,
        dominantConvention: classification.dominantConvention,
        itemLabel: itemClassification.label,
        itemMarker: itemClassification.marker,
      });
    }
  }
  return rows;
}

export function collectNamingCohorts({
  files,
  root,
  extractFn,
  submoduleOf,
  lowInfoNames,
  lowInfoHelperNames,
}) {
  if (!Array.isArray(files)) throw new Error('collectNamingCohorts requires files: string[]');
  if (typeof extractFn !== 'function' || typeof submoduleOf !== 'function') {
    throw new Error('collectNamingCohorts requires extractFn + submoduleOf');
  }

  const lowInfoAll = new Set([
    ...(lowInfoNames instanceof Set ? lowInfoNames : []),
    ...(lowInfoHelperNames instanceof Set ? lowInfoHelperNames : []),
  ]);
  const toRelative = makeNamingToRelative(root);
  const diagnostics = [];

  // Pass 1: file cohorts.
  const fileCohorts = buildFileCohorts(files, submoduleOf, toRelative);

  // Pass 2: symbol cohorts.
  const symbolCohorts = buildSymbolCohorts(files, extractFn, submoduleOf, toRelative, diagnostics);

  // Pass 3: classify + attribute per-item.
  const perItemRows = [
    ...classifyFileCohortsInPlace(fileCohorts, lowInfoAll),
    ...classifySymbolCohortsInPlace(symbolCohorts, lowInfoAll),
  ];

  const meta = {
    filesScanned: files.length,
    fileCohortCount: fileCohorts.size,
    symbolCohortCount: symbolCohorts.size,
    outlierCount: perItemRows.filter((r) => r.itemLabel === 'convention-outlier').length,
    lowInfoExcludedCount: perItemRows.filter((r) => r.itemLabel === 'low-info-excluded').length,
  };

  return { fileCohorts, symbolCohorts, perItemRows, diagnostics, meta };
}

/**
 * Render naming cohorts to Markdown per `maintainer history notes` v2 §4.1.
 */
export function renderNaming({
  fileCohorts,
  symbolCohorts,
  perItemRows,
  diagnostics,
  meta,
}) {
  const lines = [];
  lines.push('# Naming conventions draft');
  lines.push('');

  if (meta?.existingCanon === true) {
    lines.push('> ⚠ Existing canon detected: `canonical/naming.md`.');
    lines.push('> This draft is OBSERVATIONAL ONLY — it reports what AST shows, not what canon');
    lines.push('> declares. Full drift detection is the job of `check-canon.mjs` (Post-P3).');
    lines.push('> Do not promote this file over the existing canon without manual review.');
    lines.push('');
  }

  lines.push(`Generated: ${meta?.generatedAt ?? meta?.generated ?? new Date().toISOString()}`);
  lines.push(`Scope: ${meta?.scope ?? 'unspecified'}`);
  lines.push(`Source: ${meta?.source ?? 'fresh-ast-pass'}`);
  lines.push('CohortIdentityShape: submodule | submodule::kind');
  lines.push('');

  // §1. File-naming cohorts
  lines.push('## 1. File-naming cohorts');
  lines.push('');
  if (fileCohorts.size === 0) {
    lines.push('_No file-naming cohorts observed._');
    lines.push('');
  } else {
    lines.push('| Cohort (submodule) | Files | DominantConvention | ConsistencyRate | OutliersCount | Status |');
    lines.push('|--------------------|------:|--------------------|----------------:|--------------:|--------|');
    const sorted = [...fileCohorts.values()].sort((a, b) => a.cohortId < b.cohortId ? -1 : 1);
    for (const cohort of sorted) {
      const cls = cohort.classification;
      const rate = cls.label === 'insufficient-evidence' ? '—' : `${Math.round(cls.consistencyRate * 100)}%`;
      const outlierCount = perItemRows
        .filter((r) => r.cohortId === cohort.cohortId && r.itemLabel === 'convention-outlier').length;
      const outlierCell = cls.label === 'insufficient-evidence' ? '—' : String(outlierCount);
      lines.push(
        `| ${codeCell(cohort.cohortId)} | ${cohort.members.length} ` +
        `| ${cls.dominantConvention ? codeCell(cls.dominantConvention) : '—'} ` +
        `| ${rate} | ${outlierCell} | ${escapeMdCell(cls.label + ' ' + cls.marker)} |`
      );
    }
    lines.push('');
  }

  // §2. Symbol-naming cohorts
  lines.push('## 2. Symbol-naming cohorts');
  lines.push('');
  if (symbolCohorts.size === 0) {
    lines.push('_No symbol-naming cohorts observed._');
    lines.push('');
  } else {
    lines.push('| Cohort (submodule::kind) | Items | DominantConvention | ConsistencyRate | OutliersCount | Status |');
    lines.push('|--------------------------|------:|--------------------|----------------:|--------------:|--------|');
    const sorted = [...symbolCohorts.values()].sort((a, b) => a.cohortId < b.cohortId ? -1 : 1);
    for (const cohort of sorted) {
      const cls = cohort.classification;
      const rate = cls.label === 'insufficient-evidence' ? '—' : `${Math.round(cls.consistencyRate * 100)}%`;
      const outlierCount = perItemRows
        .filter((r) => r.cohortId === cohort.cohortId && r.itemLabel === 'convention-outlier').length;
      const outlierCell = cls.label === 'insufficient-evidence' ? '—' : String(outlierCount);
      lines.push(
        `| ${codeCell(cohort.cohortId)} | ${cohort.members.length} ` +
        `| ${cls.dominantConvention ? codeCell(cls.dominantConvention) : '—'} ` +
        `| ${rate} | ${outlierCell} | ${escapeMdCell(cls.label + ' ' + cls.marker)} |`
      );
    }
    lines.push('');
  }

  // §3. Outliers (outlier-only per P0-5) — OMITTED when zero.
  const sectionRows = perItemRows.filter((r) =>
    r.itemLabel === 'convention-outlier' || r.itemLabel === 'low-info-excluded');
  if (sectionRows.length > 0) {
    lines.push('## 3. Outliers');
    lines.push('');
    lines.push('| Identity | Cohort | Name | ObservedConvention | DominantConvention | Status |');
    lines.push('|----------|--------|------|--------------------|--------------------|--------|');
    const sorted = [...sectionRows].sort((a, b) =>
      (a.cohortId + a.identity) < (b.cohortId + b.identity) ? -1 : 1);
    for (const r of sorted) {
      lines.push(
        `| ${codeCell(r.identity)} | ${codeCell(r.cohortId)} | ${codeCell(r.name)} ` +
        `| ${codeCell(r.observedConvention)} | ${r.dominantConvention ? codeCell(r.dominantConvention) : '—'} ` +
        `| ${escapeMdCell(r.itemLabel + ' ' + r.itemMarker)} |`
      );
    }
    lines.push('');
  }

  if (diagnostics.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const d of diagnostics) {
      const targetPart = d.target ? ` target: ${codeCell(d.target)}` : '';
      const notePart = d.note ? ` — ${escapeMdCell(d.note)}` : '';
      lines.push(`- [확인 불가] reason: ${escapeMdCell(d.reason)}${targetPart}${notePart}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
