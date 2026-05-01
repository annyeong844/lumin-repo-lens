// _lib/check-canon-topology-parser.mjs
//
// Pure topology canon parser for check-canon. Kept separate from
// check-canon-utils so the shared drift helpers stay small.

import {
  parseCanonMarkdown,
  parseFanInCell,
  sliceSection,
  stripBackticks,
} from './check-canon-markdown.mjs';

// Expected column orders for topology per canon-drift.md v1.1 §5.c.
const TOPOLOGY_INVENTORY_COLUMNS = ['Submodule', 'Files', 'LOC', 'In-edges', 'Out-edges', 'SCC', 'Status', 'Tags'];
const TOPOLOGY_INVENTORY_COLUMN_SET = new Set(TOPOLOGY_INVENTORY_COLUMNS);
const TOPOLOGY_CROSS_EDGE_COLUMNS = ['From', 'To', 'Count'];
const TOPOLOGY_CROSS_EDGE_COLUMN_SET = new Set(TOPOLOGY_CROSS_EDGE_COLUMNS);
const TOPOLOGY_OVERSIZE_COLUMNS = ['File', 'LOC', 'Status'];
const TOPOLOGY_OVERSIZE_COLUMN_SET = new Set(TOPOLOGY_OVERSIZE_COLUMNS);

// Oversize-row labels (§11.3 subset — only these two apply to §4 rows).
const OVERSIZE_LABEL_SET = new Set(['oversize', 'extreme-oversize']);

function buildTopologyInventoryRow(cells, lineNumber) {
  const [submoduleCell, filesCell, locCell, inCell, outCell, sccCell, statusCell, tagsCell] = cells;
  const submodule = stripBackticks(submoduleCell);
  if (!submodule) return null;
  const sccMarker = sccCell.trim();
  const sccMember = sccMarker.length > 0 && sccMarker !== '—' && sccMarker !== '-';
  return {
    submodule,
    files: parseFanInCell(filesCell),
    loc: parseFanInCell(locCell),
    inEdges: parseFanInCell(inCell),
    outEdges: parseFanInCell(outCell),
    sccMember,
    label: stripBackticks(statusCell).split(/\s+/)[0] ?? '',
    tags: tagsCell,
    line: lineNumber,
    identity: submodule,
  };
}

function buildTopologyCrossEdgeRow(cells, lineNumber) {
  const [fromCell, toCell, countCell] = cells;
  const from = stripBackticks(fromCell);
  const to = stripBackticks(toCell);
  if (!from || !to) return null;
  return {
    identity: `${from} → ${to}`,
    from,
    to,
    count: parseFanInCell(countCell),
    line: lineNumber,
    label: '__no-status-column__',
  };
}

function buildTopologyOversizeRow(cells, lineNumber) {
  const [fileCell, locCell, statusCell] = cells;
  const file = stripBackticks(fileCell);
  if (!file) return null;
  return {
    identity: file,
    file,
    loc: parseFanInCell(locCell),
    label: stripBackticks(statusCell).split(/\s+/)[0] ?? '',
    line: lineNumber,
  };
}

function parseTopologyCyclesSection(sectionText) {
  const lines = sectionText.split(/\r?\n/);
  const acyclic = lines.some((l) => l.includes('No submodule-level cycles observed'));
  if (acyclic) return { acyclic: true, cycles: [] };
  const hasCycleMarker = lines.some((l) => l.startsWith('### Cycle'));
  if (!hasCycleMarker) return { acyclic: true, cycles: [] };

  const cycles = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('### Cycle')) {
      if (current) cycles.push(current);
      current = { members: [] };
    } else if (current) {
      const m = line.match(/^\s*-\s+`([^`]+)`/);
      if (m) current.members.push(m[1]);
    }
  }
  if (current) cycles.push(current);
  return { acyclic: false, cycles };
}

function validateSccAgreement(inventory, cyclesInfo) {
  const diagnostics = [];
  const inventorySccSet = new Set();
  for (const [key, row] of inventory) {
    if (row.sccMember) inventorySccSet.add(key);
  }
  const cycleMemberSet = new Set();
  for (const c of cyclesInfo.cycles ?? []) {
    for (const m of c.members ?? []) {
      let owning = null;
      for (const key of inventory.keys()) {
        if (m === key || m.startsWith(key + '/')) {
          if (!owning || key.length > owning.length) owning = key;
        }
      }
      if (owning) cycleMemberSet.add(owning);
    }
  }

  const missingInCycles = [...inventorySccSet].filter((k) => !cycleMemberSet.has(k));
  const extraInCycles = [...cycleMemberSet].filter((k) => !inventorySccSet.has(k));
  if (missingInCycles.length > 0 || extraInCycles.length > 0) {
    diagnostics.push({
      reason: 'canon-parse-error',
      sub: 'scc-inventory-cycle-disagreement',
      missingFromCycles: missingInCycles,
      missingFromInventory: extraInCycles,
    });
  }
  return diagnostics;
}

function acyclicTopologyCycles() {
  return { acyclic: true, cycles: [] };
}

function buildTopologyParseResult({
  inventory = new Map(),
  crossEdges = new Map(),
  cycles = acyclicTopologyCycles(),
  oversize = new Map(),
  workspaces = null,
  diagnostics = [],
  status,
  lineCount,
}) {
  return { inventory, crossEdges, cycles, oversize, workspaces, diagnostics, status, lineCount };
}

function parseRequiredTopologyInventory({ text, topLevelMarkers, canonLabelSet, lineCount }) {
  const inv = sliceSection(text, '## 1. ', topLevelMarkers.slice(1));
  if (!inv) {
    return {
      ok: false,
      result: buildTopologyParseResult({
        diagnostics: [{ reason: 'no-table-header' }],
        status: 'skipped-unrecognized-schema',
        lineCount,
      }),
    };
  }

  const parsed = parseCanonMarkdown({
    text: inv,
    expectedColumns: TOPOLOGY_INVENTORY_COLUMNS,
    expectedColumnSet: TOPOLOGY_INVENTORY_COLUMN_SET,
    canonLabelSet,
    buildRecord: buildTopologyInventoryRow,
    schemaTag: 'topology-inventory',
  });
  if (parsed.status === 'skipped-unrecognized-schema' || parsed.status === 'parse-error') {
    return {
      ok: false,
      result: buildTopologyParseResult({
        diagnostics: parsed.diagnostics,
        status: parsed.status,
        lineCount,
      }),
    };
  }

  return { ok: true, records: parsed.records, diagnostics: parsed.diagnostics ?? [] };
}

function parseOptionalTopologyCrossEdges({ text, topLevelMarkers, inventory, lineCount }) {
  const xs = sliceSection(text, '## 2. ', topLevelMarkers.slice(2));
  if (!xs || !/^\s*\|/m.test(xs)) return { ok: true, records: new Map(), diagnostics: [] };

  const parsed = parseCanonMarkdown({
    text: xs,
    expectedColumns: TOPOLOGY_CROSS_EDGE_COLUMNS,
    expectedColumnSet: TOPOLOGY_CROSS_EDGE_COLUMN_SET,
    canonLabelSet: null,
    buildRecord: buildTopologyCrossEdgeRow,
    schemaTag: 'topology-cross-edges',
  });
  if (parsed.status === 'parse-error' || parsed.status === 'skipped-unrecognized-schema') {
    return {
      ok: false,
      result: buildTopologyParseResult({
        inventory,
        diagnostics: parsed.diagnostics.length > 0
          ? parsed.diagnostics
          : [{ reason: 'malformed-topology-cross-edges' }],
        status: 'parse-error',
        lineCount,
      }),
    };
  }

  return { ok: true, records: parsed.records, diagnostics: parsed.diagnostics ?? [] };
}

function parseTopologyCyclesInfo(text, topLevelMarkers) {
  const cyclesSection = sliceSection(text, '## 3. ', topLevelMarkers.slice(3));
  return cyclesSection ? parseTopologyCyclesSection(cyclesSection) : acyclicTopologyCycles();
}

function buildTopologySccDisagreementResult({ inventory, crossEdges, cycles, diagnostics, lineCount }) {
  return buildTopologyParseResult({
    inventory,
    crossEdges,
    cycles,
    diagnostics,
    status: 'parse-error',
    lineCount,
  });
}

function parseOptionalTopologyOversize({ text, topLevelMarkers, inventory, crossEdges, cycles, lineCount }) {
  const ovSection = sliceSection(text, '## 4. ', topLevelMarkers.slice(4));
  if (!ovSection || !/^\s*\|/m.test(ovSection)) return { ok: true, records: new Map() };

  const parsed = parseCanonMarkdown({
    text: ovSection,
    expectedColumns: TOPOLOGY_OVERSIZE_COLUMNS,
    expectedColumnSet: TOPOLOGY_OVERSIZE_COLUMN_SET,
    canonLabelSet: OVERSIZE_LABEL_SET,
    buildRecord: buildTopologyOversizeRow,
    schemaTag: 'topology-oversize',
  });
  if (parsed.status === 'parse-error' || parsed.status === 'skipped-unrecognized-schema') {
    return {
      ok: false,
      result: buildTopologyParseResult({
        inventory,
        crossEdges,
        cycles,
        diagnostics: parsed.diagnostics.length > 0
          ? parsed.diagnostics
          : [{ reason: 'malformed-topology-oversize' }],
        status: 'parse-error',
        lineCount,
      }),
    };
  }

  return { ok: true, records: parsed.records };
}

export function parseTopologyCanonText({ text, canonLabelSet }) {
  if (typeof text !== 'string' || text.length === 0) {
    return buildTopologyParseResult({
      diagnostics: [{ reason: 'empty-file' }],
      status: 'skipped-unrecognized-schema',
      lineCount: 0,
    });
  }

  const topLevelMarkers = ['## 1. ', '## 2. ', '## 3. ', '## 4. ', '## 5. ', '## 6. '];
  const lineCount = text.split(/\r?\n/).length;

  const inventory = parseRequiredTopologyInventory({ text, topLevelMarkers, canonLabelSet, lineCount });
  if (!inventory.ok) return inventory.result;

  const crossEdges = parseOptionalTopologyCrossEdges({
    text,
    topLevelMarkers,
    inventory: inventory.records,
    lineCount,
  });
  if (!crossEdges.ok) return crossEdges.result;

  const cyclesInfo = parseTopologyCyclesInfo(text, topLevelMarkers);
  const agreementDiagnostics = validateSccAgreement(inventory.records, cyclesInfo);
  if (agreementDiagnostics.length > 0) {
    return buildTopologySccDisagreementResult({
      inventory: inventory.records,
      crossEdges: crossEdges.records,
      cycles: cyclesInfo,
      diagnostics: agreementDiagnostics,
      lineCount,
    });
  }

  const oversize = parseOptionalTopologyOversize({
    text,
    topLevelMarkers,
    inventory: inventory.records,
    crossEdges: crossEdges.records,
    cycles: cyclesInfo,
    lineCount,
  });
  if (!oversize.ok) return oversize.result;

  return buildTopologyParseResult({
    inventory: inventory.records,
    crossEdges: crossEdges.records,
    cycles: cyclesInfo,
    oversize: oversize.records,
    diagnostics: [...inventory.diagnostics, ...crossEdges.diagnostics],
    status: 'clean',
    lineCount,
  });
}
