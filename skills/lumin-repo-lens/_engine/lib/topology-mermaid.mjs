const DEFAULT_EDGE_LIMIT = 30;
const DEFAULT_CYCLE_LIMIT = 5;
const DEFAULT_HUB_LIMIT = 10;

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function n(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function limit(value, fallback) {
  return Math.max(0, Math.trunc(n(value, fallback)));
}

function escapeLabel(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function normalizeCrossEdge(edge) {
  if (!edge || typeof edge !== 'object') return null;
  if (typeof edge.from === 'string' && typeof edge.to === 'string') {
    return { from: edge.from, to: edge.to, count: n(edge.count, 1) };
  }
  if (typeof edge.edge === 'string') {
    const idx = edge.edge.indexOf(' -> ');
    const prettyIdx = edge.edge.indexOf(' → ');
    const splitAt = prettyIdx >= 0 ? prettyIdx : idx;
    const width = prettyIdx >= 0 ? 3 : 4;
    if (splitAt >= 0) {
      return {
        from: edge.edge.slice(0, splitAt),
        to: edge.edge.slice(splitAt + width),
        count: n(edge.count, 1),
      };
    }
  }
  return null;
}

function crossEdgeSource(topology) {
  if (Array.isArray(topology?.crossSubmoduleEdges)) {
    return {
      path: 'topology.json.crossSubmoduleEdges',
      edges: topology.crossSubmoduleEdges,
    };
  }
  return {
    path: 'topology.json.crossSubmoduleTop',
    edges: arr(topology?.crossSubmoduleTop),
  };
}

function sortedCrossEdges(topology) {
  const source = crossEdgeSource(topology);
  const edges = arr(source.edges)
    .map(normalizeCrossEdge)
    .filter(Boolean)
    .sort((a, b) =>
      (b.count - a.count) ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to)
    );
  return { ...source, edges };
}

function renderCrossSubmoduleGraph(topology, limit) {
  const source = sortedCrossEdges(topology);
  const shown = source.edges.slice(0, limit);
  if (source.edges.length === 0) {
    return [
      '## Cross-Submodule Edges',
      '',
      `- No cross-submodule edges were observed in \`${source.path}\`.`,
      '',
    ];
  }

  const ids = new Map();
  const emitted = new Set();
  function idFor(name) {
    if (!ids.has(name)) ids.set(name, `sub${ids.size}`);
    return ids.get(name);
  }
  function emitNode(lines, id, label) {
    if (emitted.has(id)) return;
    lines.push(`  ${id}["${escapeLabel(label)}"]`);
    emitted.add(id);
  }

  const lines = [
    '## Cross-Submodule Edges',
    '',
    `Showing ${shown.length} of ${source.edges.length} cross-submodule edge${source.edges.length === 1 ? '' : 's'} (cap: ${limit}). Source: \`${source.path}\`.`,
    '',
    '```mermaid',
    'flowchart LR',
  ];
  for (const edge of shown) {
    const from = idFor(edge.from);
    const to = idFor(edge.to);
    emitNode(lines, from, edge.from);
    emitNode(lines, to, edge.to);
    lines.push(`  ${from} -->|${edge.count}| ${to}`);
  }
  lines.push('```', '');
  return lines;
}

function cycleEdges(topology, members) {
  const memberSet = new Set(members);
  return arr(topology?.edges)
    .filter((edge) =>
      edge &&
      typeof edge.from === 'string' &&
      typeof edge.to === 'string' &&
      memberSet.has(edge.from) &&
      memberSet.has(edge.to) &&
      edge.typeOnly !== true
    );
}

function renderCycleGraph(topology, limit) {
  const allSccs = arr(topology?.sccs);
  const sccs = allSccs.slice(0, limit);
  const lens = topology?.summary?.lens ?? 'runtime';
  if (allSccs.length === 0) {
    return [
      '## Runtime Cycles',
      '',
      `- No runtime cycles were observed in \`topology.json.sccs[]\` (lens: ${lens}).`,
      '',
    ];
  }

  const lines = [
    '## Runtime Cycles',
    '',
    `Showing ${sccs.length} of ${allSccs.length} runtime cycle${allSccs.length === 1 ? '' : 's'} (cap: ${limit}). Source: \`topology.json.sccs[]\` (lens: ${lens}).`,
    '',
    '```mermaid',
    'flowchart LR',
  ];

  for (let i = 0; i < sccs.length; i++) {
    const members = arr(sccs[i]?.members).filter((member) => typeof member === 'string');
    const ids = new Map(members.map((member, index) => [member, `scc${i}_${index}`]));
    lines.push(`  subgraph cluster${i}["SCC ${i + 1} (${members.length} files)"]`);
    for (const member of members) {
      lines.push(`    ${ids.get(member)}["${escapeLabel(member)}"]`);
    }
    for (const edge of cycleEdges(topology, members)) {
      lines.push(`    ${ids.get(edge.from)} --> ${ids.get(edge.to)}`);
    }
    lines.push('  end');
  }
  lines.push('```', '');
  return lines;
}

function normalizeHub(row) {
  if (!row || typeof row !== 'object' || typeof row.file !== 'string') return null;
  return { file: row.file, count: n(row.count, 0) };
}

function sortedHubs(rows) {
  return arr(rows)
    .map(normalizeHub)
    .filter(Boolean)
    .sort((a, b) => (b.count - a.count) || a.file.localeCompare(b.file));
}

function renderHubFiles(topology, limit) {
  const fanIn = sortedHubs(topology?.topFanIn);
  const fanOut = sortedHubs(topology?.topFanOut);
  const shownIn = fanIn.slice(0, limit);
  const shownOut = fanOut.slice(0, limit);
  const lines = [
    '## Hub Files',
    '',
  ];

  if (fanIn.length === 0 && fanOut.length === 0) {
    lines.push('- No hub files were available from `topology.json.topFanIn` or `topology.json.topFanOut`.', '');
    return lines;
  }

  lines.push(`Showing ${shownIn.length} of ${fanIn.length} fan-in files from \`topology.json.topFanIn\` (cap: ${limit}).`);
  for (const row of shownIn) {
    lines.push(`- \`${row.file}\` — ${row.count} inbound`);
  }
  if (fanIn.length === 0) {
    lines.push('- No fan-in rows were available from `topology.json.topFanIn`.');
  }
  lines.push('');

  lines.push(`Showing ${shownOut.length} of ${fanOut.length} fan-out files from \`topology.json.topFanOut\` (cap: ${limit}).`);
  for (const row of shownOut) {
    lines.push(`- \`${row.file}\` — ${row.count} outbound`);
  }
  if (fanOut.length === 0) {
    lines.push('- No fan-out rows were available from `topology.json.topFanOut`.');
  }
  lines.push('');
  return lines;
}

function renderLimits(topology, { edgeLimit, cycleLimit, hubLimit }) {
  const cross = sortedCrossEdges(topology);
  const sccs = arr(topology?.sccs);
  const fanIn = sortedHubs(topology?.topFanIn);
  const fanOut = sortedHubs(topology?.topFanOut);
  return [
    '## Omitted Detail / Limits',
    '',
    `- Cross-submodule edges: showing ${Math.min(edgeLimit, cross.edges.length)} of ${cross.edges.length}; cap ${edgeLimit}; source \`${cross.path}\`.`,
    `- Runtime cycles: showing ${Math.min(cycleLimit, sccs.length)} of ${sccs.length}; cap ${cycleLimit}; source \`topology.json.sccs[]\`.`,
    `- Hub fan-in files: showing ${Math.min(hubLimit, fanIn.length)} of ${fanIn.length}; cap ${hubLimit}; source \`topology.json.topFanIn\`.`,
    `- Hub fan-out files: showing ${Math.min(hubLimit, fanOut.length)} of ${fanOut.length}; cap ${hubLimit}; source \`topology.json.topFanOut\`.`,
    '',
  ];
}

export function renderTopologyMermaid(topology, options = {}) {
  const edgeLimit = limit(options.edgeLimit, DEFAULT_EDGE_LIMIT);
  const cycleLimit = limit(options.cycleLimit, DEFAULT_CYCLE_LIMIT);
  const hubLimit = limit(options.hubLimit, DEFAULT_HUB_LIMIT);
  const generated = topology?.meta?.generated ?? 'unknown';
  const lens = topology?.summary?.lens ?? 'runtime';

  const lines = [
    '# Topology Mermaid',
    '',
    'This document is a visual companion for `topology.json`, not citation authority.',
    '',
    `Generated: ${generated}`,
    `Lens: ${lens}`,
    '',
    '## How To Read This',
    '',
    '- Use the Mermaid blocks to understand the shape of cross-submodule flow and runtime cycles.',
    '- Use the hub lists to find high-degree files before opening raw JSON.',
    '- For exact counts, complete lists, or grounded claims, cite `topology.json` path/value evidence.',
    '',
    ...renderCrossSubmoduleGraph(topology, edgeLimit),
    ...renderCycleGraph(topology, cycleLimit),
    ...renderHubFiles(topology, hubLimit),
    ...renderLimits(topology, { edgeLimit, cycleLimit, hubLimit }),
    '## Citation Contract',
    '',
    '- This artifact is a visual companion, not citation authority.',
    '- Cite `topology.json` for topology claims, including counts, absence claims, SCC membership, and complete edge lists.',
    '- Mermaid blocks and hub lists are capped so large repositories stay readable.',
    '',
  ];
  return lines.join('\n');
}
