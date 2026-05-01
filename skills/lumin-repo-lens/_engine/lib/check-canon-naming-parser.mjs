// _lib/check-canon-naming-parser.mjs
//
// Pure naming canon parser for check-canon. Kept separate from
// check-canon-utils so the shared drift helpers stay small.

import {
  parseCanonMarkdown,
  parseFanInCell,
  parseOptionalNamingCell,
  sliceSection,
  stripBackticks,
} from './check-canon-markdown.mjs';

// Expected column orders for naming per canon-drift.md v1.1 §5.d.
const NAMING_FILE_COHORT_COLUMNS = ['Cohort (submodule)', 'Files', 'DominantConvention', 'ConsistencyRate', 'OutliersCount', 'Status'];
const NAMING_FILE_COHORT_COLUMN_SET = new Set(NAMING_FILE_COHORT_COLUMNS);
const NAMING_SYMBOL_COHORT_COLUMNS = ['Cohort (submodule::kind)', 'Items', 'DominantConvention', 'ConsistencyRate', 'OutliersCount', 'Status'];
const NAMING_SYMBOL_COHORT_COLUMN_SET = new Set(NAMING_SYMBOL_COHORT_COLUMNS);
const NAMING_OUTLIER_COLUMNS = ['Identity', 'Cohort', 'Name', 'ObservedConvention', 'DominantConvention', 'Status'];
const NAMING_OUTLIER_COLUMN_SET = new Set(NAMING_OUTLIER_COLUMNS);

function buildNamingFileCohortRow(cells, lineNumber) {
  const [cohortCell, filesCell, convCell, rateCell, outliersCell, statusCell] = cells;
  const cohort = stripBackticks(cohortCell);
  if (!cohort) return null;
  return {
    identity: cohort,
    cohort,
    files: parseFanInCell(filesCell),
    dominantConvention: parseOptionalNamingCell(convCell),
    consistencyRate: rateCell.trim(),
    outliersCount: parseFanInCell(outliersCell),
    label: stripBackticks(statusCell).split(/\s+/)[0] ?? '',
    line: lineNumber,
  };
}

function buildNamingSymbolCohortRow(cells, lineNumber) {
  const [cohortCell, itemsCell, convCell, rateCell, outliersCell, statusCell] = cells;
  const cohort = stripBackticks(cohortCell);
  if (!cohort) return null;
  return {
    identity: cohort,
    cohort,
    items: parseFanInCell(itemsCell),
    dominantConvention: parseOptionalNamingCell(convCell),
    consistencyRate: rateCell.trim(),
    outliersCount: parseFanInCell(outliersCell),
    label: stripBackticks(statusCell).split(/\s+/)[0] ?? '',
    line: lineNumber,
  };
}

function buildNamingOutlierRow(cells, lineNumber) {
  const [identityCell, cohortCell, nameCell, observedCell, dominantCell, statusCell] = cells;
  const identity = stripBackticks(identityCell);
  if (!identity) return null;
  return {
    identity,
    cohort: stripBackticks(cohortCell),
    name: stripBackticks(nameCell),
    observedConvention: parseOptionalNamingCell(observedCell),
    dominantConvention: parseOptionalNamingCell(dominantCell),
    label: stripBackticks(statusCell).split(/\s+/)[0] ?? '',
    line: lineNumber,
  };
}

function buildNamingParseResult({
  fileCohorts = new Map(),
  symbolCohorts = new Map(),
  outliers = new Map(),
  diagnostics = [],
  status,
  lineCount,
}) {
  return { fileCohorts, symbolCohorts, outliers, diagnostics, status, lineCount };
}

function parseRequiredNamingFileCohorts({ text, topLevelMarkers, canonLabelSet, lineCount }) {
  const fcSection = sliceSection(text, '## 1. ', topLevelMarkers.slice(1));
  if (!fcSection) {
    return {
      ok: false,
      result: buildNamingParseResult({
        diagnostics: [{ reason: 'no-table-header' }],
        status: 'skipped-unrecognized-schema',
        lineCount,
      }),
    };
  }

  const parsed = parseCanonMarkdown({
    text: fcSection,
    expectedColumns: NAMING_FILE_COHORT_COLUMNS,
    expectedColumnSet: NAMING_FILE_COHORT_COLUMN_SET,
    canonLabelSet,
    buildRecord: buildNamingFileCohortRow,
    schemaTag: 'naming-file-cohorts',
  });

  if (parsed.status === 'parse-error') {
    return {
      ok: false,
      result: buildNamingParseResult({
        diagnostics: parsed.diagnostics,
        status: 'parse-error',
        lineCount,
      }),
    };
  }

  if (parsed.status === 'skipped-unrecognized-schema') {
    const hasTableMarker = /^\s*\|/m.test(fcSection);
    return {
      ok: false,
      result: buildNamingParseResult({
        diagnostics: parsed.diagnostics.length > 0
          ? parsed.diagnostics
          : [{ reason: hasTableMarker ? 'malformed-naming-file-cohorts' : 'no-table-header' }],
        status: hasTableMarker ? 'parse-error' : 'skipped-unrecognized-schema',
        lineCount,
      }),
    };
  }

  return { ok: true, records: parsed.records, diagnostics: parsed.diagnostics ?? [] };
}

function parseRequiredNamingSymbolCohorts({ text, topLevelMarkers, fileCohorts, canonLabelSet, lineCount }) {
  const scSection = sliceSection(text, '## 2. ', topLevelMarkers.slice(2));
  if (!scSection) {
    return {
      ok: false,
      result: buildNamingParseResult({
        fileCohorts,
        diagnostics: [{ reason: 'missing-required-section', section: '2. Symbol-naming cohorts' }],
        status: 'parse-error',
        lineCount,
      }),
    };
  }

  if (!/^\s*\|/m.test(scSection)) return { ok: true, records: new Map() };

  const parsed = parseCanonMarkdown({
    text: scSection,
    expectedColumns: NAMING_SYMBOL_COHORT_COLUMNS,
    expectedColumnSet: NAMING_SYMBOL_COHORT_COLUMN_SET,
    canonLabelSet,
    buildRecord: buildNamingSymbolCohortRow,
    schemaTag: 'naming-symbol-cohorts',
  });
  if (parsed.status === 'parse-error' || parsed.status === 'skipped-unrecognized-schema') {
    return {
      ok: false,
      result: buildNamingParseResult({
        fileCohorts,
        diagnostics: parsed.diagnostics.length > 0
          ? parsed.diagnostics
          : [{ reason: 'malformed-naming-symbol-cohorts' }],
        status: 'parse-error',
        lineCount,
      }),
    };
  }

  return { ok: true, records: parsed.records };
}

function parseOptionalNamingOutliers({ text, topLevelMarkers, fileCohorts, symbolCohorts, canonLabelSet, lineCount }) {
  const ouSection = sliceSection(text, '## 3. ', topLevelMarkers.slice(3));
  if (!ouSection || !/^\s*\|/m.test(ouSection)) return { ok: true, records: new Map() };

  const parsed = parseCanonMarkdown({
    text: ouSection,
    expectedColumns: NAMING_OUTLIER_COLUMNS,
    expectedColumnSet: NAMING_OUTLIER_COLUMN_SET,
    canonLabelSet,
    buildRecord: buildNamingOutlierRow,
    schemaTag: 'naming-outliers',
  });
  if (parsed.status === 'parse-error' || parsed.status === 'skipped-unrecognized-schema') {
    return {
      ok: false,
      result: buildNamingParseResult({
        fileCohorts,
        symbolCohorts,
        diagnostics: parsed.diagnostics.length > 0
          ? parsed.diagnostics
          : [{ reason: 'malformed-naming-outliers' }],
        status: 'parse-error',
        lineCount,
      }),
    };
  }

  const outliers = new Map();
  for (const [id, row] of parsed.records) {
    if (row.label === 'convention-outlier') outliers.set(id, row);
  }
  return { ok: true, records: outliers };
}

export function parseNamingCanonText({ text, canonLabelSet }) {
  if (typeof text !== 'string' || text.length === 0) {
    return buildNamingParseResult({
      diagnostics: [{ reason: 'empty-file' }],
      status: 'skipped-unrecognized-schema',
      lineCount: 0,
    });
  }

  const topLevelMarkers = ['## 1. ', '## 2. ', '## 3. ', '## 4. '];
  const lineCount = text.split(/\r?\n/).length;

  const fileCohorts = parseRequiredNamingFileCohorts({
    text,
    topLevelMarkers,
    canonLabelSet,
    lineCount,
  });
  if (!fileCohorts.ok) return fileCohorts.result;

  const symbolCohorts = parseRequiredNamingSymbolCohorts({
    text,
    topLevelMarkers,
    fileCohorts: fileCohorts.records,
    canonLabelSet,
    lineCount,
  });
  if (!symbolCohorts.ok) return symbolCohorts.result;

  const outliers = parseOptionalNamingOutliers({
    text,
    topLevelMarkers,
    fileCohorts: fileCohorts.records,
    symbolCohorts: symbolCohorts.records,
    canonLabelSet,
    lineCount,
  });
  if (!outliers.ok) return outliers.result;

  return buildNamingParseResult({
    fileCohorts: fileCohorts.records,
    symbolCohorts: symbolCohorts.records,
    outliers: outliers.records,
    diagnostics: fileCohorts.diagnostics,
    status: 'clean',
    lineCount,
  });
}
