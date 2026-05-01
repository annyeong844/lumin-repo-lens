// _lib/check-canon-markdown.mjs
//
// Shared Markdown-table parsing helpers for check-canon sources.
// NO fs I/O. Source-specific canon parsers stay in check-canon-utils.mjs.

function splitRow(line) {
  // GFM-aware splitter: pipes inside backtick code spans or escaped as `\|`
  // are literal cell content, not column delimiters. This matters for
  // helper-registry's `Signature` column, which often carries TypeScript
  // unions like `(x: string | number) => void`.
  const cells = [];
  let inBackticks = false;
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '`') {
      inBackticks = !inBackticks;
      current += ch;
      continue;
    }
    if (ch === '|' && !inBackticks) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  if (cells.length < 3) return null;
  return cells.slice(1, -1).map((c) => c.trim());
}

function isSeparatorRow(line) {
  return /^\s*\|[\s:|\-]+\|\s*$/.test(line);
}

export function stripBackticks(cell) {
  return cell.replace(/^`+|`+$/g, '').trim();
}

export function parseOptionalNamingCell(cell) {
  const value = stripBackticks(cell);
  return value === '' || value === '—' || value === '-' ? null : value;
}

export function parseFanInCell(cell) {
  const n = Number.parseInt(cell.replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

export function sliceSection(text, startMarker, endMarkers) {
  const startIdx = text.indexOf(startMarker);
  if (startIdx < 0) return null;
  let endIdx = text.length;
  for (const em of endMarkers) {
    const i = text.indexOf(em, startIdx + startMarker.length);
    if (i >= 0 && i < endIdx) endIdx = i;
  }
  return text.slice(startIdx, endIdx);
}

function diagnoseHeader(cells, expectedColumns, expectedColumnSet) {
  // Runs AFTER the cells are confirmed to resemble a known header
  // (>= `strongMatchThreshold` expected column names present). Classifies
  // each deviation. Parameterized over the target column list so all canon
  // source parsers can reuse the same strictness policy.
  const diagnostics = [];
  const observed = new Set(cells);
  for (let i = 0; i < expectedColumns.length; i += 1) {
    const expected = expectedColumns[i];
    const actual = cells[i];
    if (actual === expected) continue;
    if (actual === undefined) {
      diagnostics.push({ reason: 'missing-required-column', column: expected });
    } else if (!observed.has(expected)) {
      if (!expectedColumnSet.has(actual)) {
        diagnostics.push({ reason: 'renamed-column', expected, got: actual });
      } else {
        diagnostics.push({ reason: 'missing-required-column', column: expected });
      }
    } else {
      diagnostics.push({ reason: 'column-order-mismatch', expected, got: actual, slot: i });
    }
  }
  for (const actual of cells) {
    if (!expectedColumnSet.has(actual)) {
      if (!diagnostics.some((d) => d.got === actual)) {
        diagnostics.push({ reason: 'unknown-column', column: actual });
      }
    }
  }
  return diagnostics;
}

// Shared Canon-MD parser. Accepts a target column spec + a row builder.
// Implements the 3-tier strictness policy from canon-drift.md §5.e uniformly.
export function parseCanonMarkdown({ text, expectedColumns, expectedColumnSet, canonLabelSet, buildRecord, schemaTag }) {
  const diagnostics = [];
  if (typeof text !== 'string' || text.length === 0) {
    return { records: new Map(), diagnostics: [{ reason: 'empty-file' }], status: 'skipped-unrecognized-schema', lineCount: 0 };
  }

  const lines = text.split(/\r?\n/);
  const candidates = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trimStart().startsWith('|')) continue;
    if (isSeparatorRow(line)) continue;
    const cells = splitRow(line);
    if (!cells || cells.length < 2) continue;
    const matchCount = cells.filter((c) => expectedColumnSet.has(c)).length;
    candidates.push({ idx: i, cells, matchCount });
  }

  if (candidates.length === 0) {
    return { records: new Map(), diagnostics: [{ reason: 'no-table-header' }], status: 'skipped-unrecognized-schema', lineCount: lines.length };
  }

  // Pass A: exact-match header.
  const exact = candidates.find((c) =>
    c.cells.length === expectedColumns.length &&
    expectedColumns.every((exp, j) => c.cells[j] === exp));

  // Pass B: strong-malformed — threshold is column-count-aware.
  //   3-col tables (topology §2 cross-edges, §4 oversize): 2-of-3 matching
  //     columns is already suggestive of a mangled canonical table; a 2-col
  //     prefix memo can't exceed this, so false-fire is not a real concern
  //     at this size. Reviewer Finding #2 (2026-04-22).
  //   Larger tables: require >= 3 matching OR >= 50%, whichever is larger,
  //     to stay defensive against 2-col prefix memos.
  const strongThreshold = expectedColumns.length <= 3
    ? 2
    : Math.max(3, Math.ceil(expectedColumns.length / 2));
  const malformedCandidate = exact ? null
    : candidates.find((c) => c.matchCount >= strongThreshold);

  if (!exact && !malformedCandidate) {
    return {
      records: new Map(),
      diagnostics: [{ reason: 'unrecognized-schema', observed: candidates[0].cells.join(' | ') }],
      status: 'skipped-unrecognized-schema',
      lineCount: lines.length,
    };
  }

  if (malformedCandidate) {
    const headerDiagnostics = diagnoseHeader(malformedCandidate.cells, expectedColumns, expectedColumnSet);
    return {
      records: new Map(),
      diagnostics: headerDiagnostics.length > 0 ? headerDiagnostics
        : [{ reason: `malformed-${schemaTag}-header`, observed: malformedCandidate.cells.join(' | ') }],
      status: 'parse-error',
      lineCount: lines.length,
    };
  }

  // Exact-match path — parse body rows below the header.
  const headerIdx = exact.idx;
  const records = new Map();
  let rowStatus = 'clean';
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trimStart().startsWith('|')) continue;
    if (isSeparatorRow(line)) continue;
    const cells = splitRow(line);
    if (!cells || cells.length !== expectedColumns.length) {
      diagnostics.push({ reason: 'canon-parse-error', sub: 'row-cell-count', line: i + 1, got: cells?.length ?? 0 });
      rowStatus = 'parse-error';
      continue;
    }
    const row = buildRecord(cells, i + 1);
    if (!row) {
      diagnostics.push({ reason: 'canon-parse-error', sub: 'row-build-failed', line: i + 1 });
      rowStatus = 'parse-error';
      continue;
    }
    // Validate status token against canonical label set.
    if (canonLabelSet && !canonLabelSet.has(row.label)) {
      diagnostics.push({ reason: 'canon-parse-error', sub: 'unknown-status-label', line: i + 1, identity: row.identity, observed: row.label });
      rowStatus = 'parse-error';
      continue;
    }
    records.set(row.identity, row);
  }
  return { records, diagnostics, status: rowStatus, lineCount: lines.length };
}
