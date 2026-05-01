// _lib/check-canon-topology.mjs
//
// P5-3 — topology drift engine.
//
// Consumes:
//   - canonical/topology.md via loadTopologyCanon (multi-section parser).
//   - topology.json (primary observation source; hard dependency).
//   - triage.json (optional monorepo mode hint).
//
// Produces:
//   - topology-drift records per canon-drift.md v1.1 §3.1 (6 categories):
//     submodule-added / submodule-removed / scc-status-changed /
//     oversize-changed / cross-edge-added / cross-edge-removed.
//   - per-source Markdown report.
//
// Differ algorithm (p5-3.md §4.5):
//   1. Sub-diff 1 — submodules: set diff + scc-status-changed (PF-8 rule).
//   2. Sub-diff 2 — oversize files: set diff + tier-change.
//   3. Sub-diff 3 — cross-edges: top-30 display-scope set diff.
//      Fresh top-30 derived via explicit count-desc sort (p5-3.md §4.5.4 —
//      Finding #4). Engine MUST NOT trust producer ordering.
//
// Identity format varies per category (p5-3.md PF-5 / canon-drift.md §4):
//   - submodule-* / scc-status-changed → submodule path (string)
//   - cross-edge-* → "<from> → <to>" literal
//   - oversize-changed → ownerFile path

import {
  collectTopologyStructure,
  selectTopologyTopCrossEdges,
} from './canon-draft-topology.mjs';
import { loadTopologyCanon } from './check-canon-artifact.mjs';
import { makeDriftRecord } from './check-canon-utils.mjs';

function classifyFreshSubmodules(submodulesByPath) {
  // Convert the collector's submodulesByPath output into a Map keyed by
  // submodule path with the fields the differ needs.
  const fresh = new Map();
  for (const [key, entry] of submodulesByPath) {
    fresh.set(key, {
      submodule: key,
      files: entry.files ?? 0,
      loc: entry.loc ?? 0,
      inEdges: entry.inDegree ?? 0,
      outEdges: entry.outDegree ?? 0,
      sccMember: entry.sccMember === true,
    });
  }
  return fresh;
}

function classifyFreshOversize(oversizeFiles) {
  // collectTopologyStructure returns an array of { file, loc, label, marker }
  // already classified through §11.3. Convert to Map keyed by file path.
  const fresh = new Map();
  for (const o of oversizeFiles ?? []) {
    fresh.set(o.file, { file: o.file, loc: o.loc, label: o.label });
  }
  return fresh;
}

function buildFreshTopEdges(topology) {
  // p5-3.md §4.5.4 — explicit sort before slice. Do NOT trust producer order.
  //
  // Preference order (Finding #1): full structured `crossSubmoduleEdges` list
  // FIRST — it's the most precise source and our top-30 slice is then
  // authoritative. Fall back to `crossSubmoduleTop` (legacy shape) only when
  // no full list is available.
  const rawSource = Array.isArray(topology.crossSubmoduleEdges)
    ? topology.crossSubmoduleEdges
    : (Array.isArray(topology.crossSubmoduleTop) ? topology.crossSubmoduleTop : []);
  const top30 = selectTopologyTopCrossEdges(rawSource);
  const m = new Map();
  for (const e of top30) {
    m.set(`${e.from} → ${e.to}`, { from: e.from, to: e.to, count: e.count });
  }
  return m;
}

function diffSubmodules(canonInventory, freshInventory) {
  const drifts = [];
  for (const [key, canon] of canonInventory) {
    const fresh = freshInventory.get(key);
    if (!fresh) {
      drifts.push(makeDriftRecord({
        kind: 'topology-drift',
        category: 'submodule-removed',
        identity: key,
        canon: {
          file: 'canonical/topology.md',
          line: canon.line,
          label: canon.label,
          files: canon.files,
          loc: canon.loc,
          inEdges: canon.inEdges,
          outEdges: canon.outEdges,
          sccMember: canon.sccMember,
        },
        confidence: 'high',
      }));
      continue;
    }
    if (canon.sccMember !== fresh.sccMember) {
      drifts.push(makeDriftRecord({
        kind: 'topology-drift',
        category: 'scc-status-changed',
        identity: key,
        canon: {
          file: 'canonical/topology.md',
          line: canon.line,
          label: canon.label,
          sccMember: canon.sccMember,
        },
        fresh: {
          sccMember: fresh.sccMember,
        },
        confidence: 'high',
      }));
    }
    // Degree-only label drift is not a v1 category (p5-3.md §4.5 sub-diff 1).
    // No record when sccMember is equal but label differs.
  }
  for (const [key, fresh] of freshInventory) {
    if (!canonInventory.has(key)) {
      drifts.push(makeDriftRecord({
        kind: 'topology-drift',
        category: 'submodule-added',
        identity: key,
        fresh: {
          files: fresh.files,
          loc: fresh.loc,
          inEdges: fresh.inEdges,
          outEdges: fresh.outEdges,
          sccMember: fresh.sccMember,
        },
        confidence: 'high',
      }));
    }
  }
  return drifts;
}

function diffOversize(canonOversize, freshOversize) {
  const drifts = [];
  for (const [key, canon] of canonOversize) {
    const fresh = freshOversize.get(key);
    if (!fresh) {
      drifts.push(makeDriftRecord({
        kind: 'topology-drift',
        category: 'oversize-changed',
        identity: key,
        canon: {
          file: 'canonical/topology.md',
          line: canon.line,
          label: canon.label,
          loc: canon.loc,
        },
        fresh: { label: null },
        confidence: 'high',
      }));
      continue;
    }
    if (canon.label !== fresh.label) {
      drifts.push(makeDriftRecord({
        kind: 'topology-drift',
        category: 'oversize-changed',
        identity: key,
        canon: {
          file: 'canonical/topology.md',
          line: canon.line,
          label: canon.label,
          loc: canon.loc,
        },
        fresh: { label: fresh.label, loc: fresh.loc },
        confidence: 'high',
      }));
    }
  }
  for (const [key, fresh] of freshOversize) {
    if (!canonOversize.has(key)) {
      drifts.push(makeDriftRecord({
        kind: 'topology-drift',
        category: 'oversize-changed',
        identity: key,
        canon: { label: null },
        fresh: { label: fresh.label, loc: fresh.loc },
        confidence: 'high',
      }));
    }
  }
  return drifts;
}

function diffCrossEdges(canonEdges, freshEdges) {
  const drifts = [];
  for (const [key, canon] of canonEdges) {
    if (!freshEdges.has(key)) {
      drifts.push(makeDriftRecord({
        kind: 'topology-drift',
        category: 'cross-edge-removed',
        identity: key,
        canon: {
          file: 'canonical/topology.md',
          line: canon.line,
          count: canon.count,
          from: canon.from,
          to: canon.to,
        },
        confidence: 'high',
      }));
    }
  }
  for (const [key, fresh] of freshEdges) {
    if (!canonEdges.has(key)) {
      drifts.push(makeDriftRecord({
        kind: 'topology-drift',
        category: 'cross-edge-added',
        identity: key,
        fresh: { from: fresh.from, to: fresh.to, count: fresh.count },
        confidence: 'high',
      }));
    }
  }
  return drifts;
}

function renderDriftMarkdown({ drifts, canonPath, canonLineCount }) {
  const lines = [];
  lines.push('# Topology canon drift');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Canon file: ${canonPath}`);
  lines.push(`Canon line count: ${canonLineCount}`);
  lines.push(`Drift count: ${drifts.length}`);
  lines.push('');

  const byCat = {
    'submodule-added':     drifts.filter((d) => d.category === 'submodule-added'),
    'submodule-removed':   drifts.filter((d) => d.category === 'submodule-removed'),
    'scc-status-changed':  drifts.filter((d) => d.category === 'scc-status-changed'),
    'oversize-changed':    drifts.filter((d) => d.category === 'oversize-changed'),
    'cross-edge-added':    drifts.filter((d) => d.category === 'cross-edge-added'),
    'cross-edge-removed':  drifts.filter((d) => d.category === 'cross-edge-removed'),
  };

  lines.push('## 1. Summary');
  lines.push('');
  lines.push('| Category | Family | Count |');
  lines.push('|----------|--------|------:|');
  lines.push(`| submodule-added     | added                     | ${byCat['submodule-added'].length} |`);
  lines.push(`| submodule-removed   | removed                   | ${byCat['submodule-removed'].length} |`);
  lines.push(`| scc-status-changed  | structural-status-changed | ${byCat['scc-status-changed'].length} |`);
  lines.push(`| oversize-changed    | content-shifted           | ${byCat['oversize-changed'].length} |`);
  lines.push(`| cross-edge-added    | added                     | ${byCat['cross-edge-added'].length} |`);
  lines.push(`| cross-edge-removed  | removed                   | ${byCat['cross-edge-removed'].length} |`);
  lines.push('');

  let section = 2;
  if (byCat['submodule-added'].length > 0) {
    lines.push(`## ${section}. submodule-added`);
    lines.push('');
    lines.push('| Submodule | Fresh files | Fresh LOC | In-edges | Out-edges |');
    lines.push('|-----------|------------:|----------:|---------:|----------:|');
    for (const d of byCat['submodule-added']) {
      lines.push(`| \`${d.identity}\` | ${d.fresh.files} | ${d.fresh.loc} | ${d.fresh.inEdges} | ${d.fresh.outEdges} |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['submodule-removed'].length > 0) {
    lines.push(`## ${section}. submodule-removed`);
    lines.push('');
    lines.push('| Submodule | Canon label | Canon files | Canon LOC | Canon line |');
    lines.push('|-----------|-------------|------------:|----------:|-----------:|');
    for (const d of byCat['submodule-removed']) {
      lines.push(`| \`${d.identity}\` | \`${d.canon.label}\` | ${d.canon.files} | ${d.canon.loc} | ${d.canon.line} |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['scc-status-changed'].length > 0) {
    lines.push(`## ${section}. scc-status-changed`);
    lines.push('');
    lines.push('| Submodule | Canon SCC | Fresh SCC | Canon label | Canon line |');
    lines.push('|-----------|-----------|-----------|-------------|-----------:|');
    for (const d of byCat['scc-status-changed']) {
      lines.push(`| \`${d.identity}\` | ${d.canon.sccMember ? '●' : '—'} | ${d.fresh.sccMember ? '●' : '—'} | \`${d.canon.label}\` | ${d.canon.line} |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['oversize-changed'].length > 0) {
    lines.push(`## ${section}. oversize-changed`);
    lines.push('');
    lines.push('| File | Canon label | Fresh label | Canon LOC | Fresh LOC | Canon line |');
    lines.push('|------|-------------|-------------|----------:|----------:|-----------:|');
    for (const d of byCat['oversize-changed']) {
      const canonLabel = d.canon.label ?? '—';
      const freshLabel = d.fresh.label ?? '—';
      const canonLoc = d.canon.loc ?? '—';
      const freshLoc = d.fresh.loc ?? '—';
      const canonLine = d.canon.line ?? '—';
      lines.push(`| \`${d.identity}\` | \`${canonLabel}\` | \`${freshLabel}\` | ${canonLoc} | ${freshLoc} | ${canonLine} |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['cross-edge-added'].length > 0) {
    lines.push(`## ${section}. cross-edge-added`);
    lines.push('');
    lines.push('| Edge (from → to) | Fresh count | Display scope |');
    lines.push('|------------------|------------:|---------------|');
    for (const d of byCat['cross-edge-added']) {
      lines.push(`| \`${d.identity}\` | ${d.fresh.count} | top-30 |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['cross-edge-removed'].length > 0) {
    lines.push(`## ${section}. cross-edge-removed`);
    lines.push('');
    lines.push('| Edge (from → to) | Canon count | Canon line | Display scope |');
    lines.push('|------------------|------------:|-----------:|---------------|');
    for (const d of byCat['cross-edge-removed']) {
      lines.push(`| \`${d.identity}\` | ${d.canon.count} | ${d.canon.line} | top-30 |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function detectTopologyDrift({ canonPath, topology, triage, canonLabelSet, loader }) {
  const load = loader ?? loadTopologyCanon;
  const canonResult = load({ canonPath, canonLabelSet });
  if (canonResult.status !== 'clean') {
    return {
      drifts: [],
      status: canonResult.status,
      diagnostics: canonResult.diagnostics ?? [],
      reportMarkdown: null,
      canonLineCount: canonResult.lineCount ?? 0,
    };
  }

  if (!topology || typeof topology !== 'object') {
    return {
      drifts: [],
      status: 'parse-error',
      diagnostics: [
        ...(canonResult.diagnostics ?? []),
        { reason: 'topology-input-missing', detail: 'topology.json required for --source topology' },
      ],
      reportMarkdown: null,
      canonLineCount: canonResult.lineCount ?? 0,
    };
  }

  const collected = collectTopologyStructure({ topology, triage: triage ?? null });
  const freshSubmodules = classifyFreshSubmodules(collected.submodulesByPath);
  const freshOversize = classifyFreshOversize(collected.oversizeFiles);
  const freshTopEdges = buildFreshTopEdges(topology);

  const drifts = [
    ...diffSubmodules(canonResult.inventory, freshSubmodules),
    ...diffOversize(canonResult.oversize, freshOversize),
    ...diffCrossEdges(canonResult.crossEdges, freshTopEdges),
  ];

  const reportMarkdown = renderDriftMarkdown({
    drifts,
    canonPath,
    canonLineCount: canonResult.lineCount ?? 0,
  });

  return {
    drifts,
    status: drifts.length > 0 ? 'drift' : 'clean',
    diagnostics: [
      ...(canonResult.diagnostics ?? []),
      ...(collected.diagnostics ?? []),
    ],
    reportMarkdown,
    canonLineCount: canonResult.lineCount ?? 0,
  };
}
