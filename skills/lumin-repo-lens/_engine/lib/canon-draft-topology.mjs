// _lib/canon-draft-topology.mjs — P3-3 topology classifier + aggregator + renderer.
//
// Extracted from `_lib/canon-draft.mjs` during post-P3 cleanup (2026-04-21).
//
// Identity shape: **submodule path** (e.g., `_lib`, `apps/web`). NOT
// `ownerFile::exportedName` — that's type/helper territory.

import {
  escapeMdCell,
  codeCell,
} from './canon-draft-utils.mjs';

const STALE_TOPOLOGY_HOURS = 24;

// ── Submodule classifier (canonical §11.1) ──────────────────

/**
 * @param {{
 *   name: string,
 *   inDegree: number,
 *   outDegree: number,
 *   sccMember: boolean,
 *   crossEdgeSource: 'full-list' | 'top-30-only',
 * }} input
 * @returns {{ label: string, marker: string }}
 */
export function classifyTopologySubmodule({
  name: _name, // accepted for caller-spread compat; classification is name-agnostic
  inDegree,
  outDegree,
  sccMember,
  crossEdgeSource,
}) {
  if (sccMember === true) {
    return { label: 'cyclic-submodule', marker: '❌' };
  }
  if (inDegree === 0 && outDegree === 0 && crossEdgeSource === 'full-list') {
    return { label: 'isolated-submodule', marker: 'ℹ' };
  }
  if (inDegree >= 5) {
    return { label: 'shared-submodule', marker: '✅' };
  }
  if (outDegree > inDegree && inDegree < 5) {
    return { label: 'leaf-submodule', marker: '⚠' };
  }
  return { label: 'scoped-submodule', marker: 'ℹ' };
}

// ── SCC classifier (canonical §11.2) ────────────────────────

export function classifyTopologyScc(_input) {
  return { label: 'forbidden-cycle', marker: '❌' };
}

// ── File size classifier (canonical §11.3) ──────────────────

export function classifyTopologyFile({ loc }) {
  if (typeof loc !== 'number' || loc < 400) return null;
  if (loc >= 1000) return { label: 'extreme-oversize', marker: '❌' };
  return { label: 'oversize', marker: '⚠' };
}

// ── Topology aggregator (maintainer history notes v3 §5.3 + §5.3.1) ───────
//
// Decomposed into module-level helpers during post-P3 cleanup — each
// helper handles one phase of aggregation; `collectTopologyStructure`
// is the orchestrator.

function parseLegacyEdgeLabel(edge) {
  if (typeof edge !== 'string') return null;
  const idx = edge.indexOf(' → ');
  if (idx < 0) return null;
  return { from: edge.slice(0, idx), to: edge.slice(idx + 3) };
}

function normalizeTopologyCrossEdgeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  if (typeof e.from === 'string' && typeof e.to === 'string') {
    return { from: e.from, to: e.to, count: e.count ?? 0 };
  }
  if (typeof e.edge === 'string') {
    const parsed = parseLegacyEdgeLabel(e.edge);
    return parsed ? { from: parsed.from, to: parsed.to, count: e.count ?? 0 } : null;
  }
  return null;
}

function compareTopologyCrossEdges(a, b) {
  const countDelta = (b.count ?? 0) - (a.count ?? 0);
  if (countDelta !== 0) return countDelta;
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  return 0;
}

export function selectTopologyTopCrossEdges(rawEdges, limit = 30) {
  const normalized = [];
  for (const raw of rawEdges ?? []) {
    const edge = normalizeTopologyCrossEdgeEntry(raw);
    if (edge) normalized.push(edge);
  }
  return normalized.sort(compareTopologyCrossEdges).slice(0, limit);
}

function topDir(relFile) {
  const idx = relFile.indexOf('/');
  return idx < 0 ? 'root' : relFile.slice(0, idx);
}

function makeSubmoduleEntry(name) {
  return {
    name, files: 0, loc: 0, inDegree: 0, outDegree: 0, sccMember: false, filesList: [],
  };
}

// Phase 1: meta completeness + staleness → diagnostics + flags.
function checkTopologyMetaHealth(topology, nowMs) {
  const diagnostics = [];
  const topologyComplete = topology.meta?.complete === true;
  if (!topologyComplete) {
    diagnostics.push({
      kind: 'topology-unavailable',
      reason: 'topology-artifact-incomplete',
      note: 'topology.json.meta.complete !== true; some files absent from nodes',
    });
  }
  let topologyStaleness = 'fresh';
  if (typeof topology.meta?.generated === 'string') {
    const ts = Date.parse(topology.meta.generated);
    if (Number.isFinite(ts)) {
      const ageHours = (nowMs - ts) / (1000 * 60 * 60);
      if (ageHours > STALE_TOPOLOGY_HOURS) {
        topologyStaleness = 'stale';
        diagnostics.push({
          kind: 'topology-stale',
          reason: 'topology-artifact-stale',
          note: `topology.json generated ${ageHours.toFixed(0)}h ago (> ${STALE_TOPOLOGY_HOURS}h threshold)`,
        });
      }
    }
  }
  return { diagnostics, topologyComplete, topologyStaleness };
}

// Phase 2: seed inventory from triage (monorepo boundaries OR single-package
// topDirs) OR fall through to topology.nodes top-dir. Returns source label
// + workspaces array (populated only for monorepo modes).
function seedInventoryFromTriage(triage, submodulesByPath) {
  const workspaces = [];
  if (triage && Array.isArray(triage.boundaries) && triage.boundaries.length > 0) {
    for (const b of triage.boundaries) {
      if (!b) continue;
      const name = b.path || b.name;
      if (typeof name !== 'string' || name.length === 0) continue;
      if (!submodulesByPath.has(name)) submodulesByPath.set(name, makeSubmoduleEntry(name));
      workspaces.push({
        name: b.name ?? name,
        path: b.path ?? name,
        files: b.files ?? 0,
        loc: b.loc ?? 0,
      });
    }
    return { inventorySource: 'triage.boundaries', workspaces };
  }
  if (triage && triage.topDirs && typeof triage.topDirs === 'object') {
    for (const [dir, info] of Object.entries(triage.topDirs)) {
      if (!submodulesByPath.has(dir)) submodulesByPath.set(dir, makeSubmoduleEntry(dir));
      const entry = submodulesByPath.get(dir);
      entry.files = info?.files ?? 0;
      entry.loc = info?.loc ?? 0;
    }
    return { inventorySource: 'triage.topDirs', workspaces };
  }
  return { inventorySource: 'topology.nodes', workspaces };
}

// Phase 3: topology.nodes is authoritative for files/loc. Reset triage-sourced
// numbers and re-derive from actual per-file data. Create new inventory
// entries for files under dirs not yet covered (repo root, unlisted top-dirs).
function redistributeFilesFromNodes(nodes, submodulesByPath) {
  for (const entry of submodulesByPath.values()) {
    entry.files = 0;
    entry.loc = 0;
  }
  for (const [file, info] of Object.entries(nodes)) {
    let owningSubmodule = null;
    for (const name of submodulesByPath.keys()) {
      if (file === name || file.startsWith(name + '/')) {
        if (!owningSubmodule || name.length > owningSubmodule.length) owningSubmodule = name;
      }
    }
    if (!owningSubmodule) owningSubmodule = topDir(file);
    if (!submodulesByPath.has(owningSubmodule)) {
      submodulesByPath.set(owningSubmodule, makeSubmoduleEntry(owningSubmodule));
    }
    const entry = submodulesByPath.get(owningSubmodule);
    entry.files += 1;
    entry.loc += info?.loc ?? 0;
    entry.filesList.push(file);
  }
}

// Phase 4: augment in/out degrees from cross-submodule edges. Full list
// when present; legacy top-30 fallback otherwise. Surface boundary
// mismatches when an edge endpoint isn't in triage-sourced inventory.
function augmentDegreesFromEdges(topology, hasFullList, submodulesByPath, inventorySource, diagnostics) {
  const rawEdges = hasFullList
    ? topology.crossSubmoduleEdges
    : (topology.crossSubmoduleTop ?? [])
        .map((e) => {
          const parsed = parseLegacyEdgeLabel(e.edge);
          return parsed ? { from: parsed.from, to: parsed.to, count: e.count ?? 1 } : null;
        })
        .filter(Boolean);

  for (const e of rawEdges) {
    if (!submodulesByPath.has(e.from) || !submodulesByPath.has(e.to)) {
      if (inventorySource !== 'topology.nodes') {
        diagnostics.push({
          kind: 'boundary-mismatch',
          reason: 'submodule-boundary-mismatch',
          target: `${e.from} → ${e.to}`,
          note: `edge endpoint not matched in ${inventorySource}; inventory may lag topology`,
        });
      }
    }
    const fromEntry = submodulesByPath.get(e.from);
    const toEntry = submodulesByPath.get(e.to);
    if (fromEntry) fromEntry.outDegree += e.count ?? 1;
    if (toEntry) toEntry.inDegree += e.count ?? 1;
  }
}

// Phase 5: mark submodules containing SCC members. Returns sccs array
// (sccIndex + members file-paths) for §3 cycle listing.
function attributeSccMembership(topologySccsInput, submodulesByPath) {
  const sccs = [];
  const topologySccs = Array.isArray(topologySccsInput) ? topologySccsInput : [];
  for (let i = 0; i < topologySccs.length; i++) {
    const scc = topologySccs[i];
    const members = Array.isArray(scc?.members) ? scc.members : [];
    sccs.push({ sccIndex: i, members });
    for (const member of members) {
      for (const name of submodulesByPath.keys()) {
        if (member === name || member.startsWith(name + '/')) {
          submodulesByPath.get(name).sccMember = true;
        }
      }
    }
  }
  return sccs;
}

// Phase 6: filter largestFiles through §11.3 classifier. Returns classified
// rows for §4 oversize table.
function pickOversizeFiles(largestFilesInput) {
  const oversizeFiles = [];
  const largestFiles = Array.isArray(largestFilesInput) ? largestFilesInput : [];
  for (const f of largestFiles) {
    if (!f || typeof f.file !== 'string') continue;
    const cls = classifyTopologyFile({ file: f.file, loc: f.loc ?? 0 });
    if (!cls) continue;
    oversizeFiles.push({ file: f.file, loc: f.loc, label: cls.label, marker: cls.marker });
  }
  return oversizeFiles;
}

// Phase 7: build §2 display table. Full `crossSubmoduleEdges` is
// authoritative when present; legacy `crossSubmoduleTop` is only the
// degraded fallback for pre-P3-3-pre producer outputs. Sort-before-slice
// matches the P5 drift engine so P3→P5 round-trips are stable.
function buildCrossEdgesForDisplay(topology, hasFullList) {
  if (hasFullList) return selectTopologyTopCrossEdges(topology.crossSubmoduleEdges);
  if (Array.isArray(topology.crossSubmoduleTop)) {
    return selectTopologyTopCrossEdges(topology.crossSubmoduleTop);
  }
  return [];
}

/**
 * Aggregate topology.json + triage.json into submodule-keyed structure.
 */
export function collectTopologyStructure({
  topology,
  triage = null,
  nowMs = Date.now(),
}) {
  if (!topology || typeof topology !== 'object') {
    throw new Error('collectTopologyStructure requires topology: object');
  }

  // Phase 1: meta health (completeness + staleness).
  const { diagnostics, topologyComplete, topologyStaleness } =
    checkTopologyMetaHealth(topology, nowMs);

  const hasFullList = Array.isArray(topology.crossSubmoduleEdges);
  const crossEdgeSource = hasFullList ? 'full-list' : 'top-30-only';
  const classificationConfidence = hasFullList ? 'high' : 'medium';

  const mode = triage?.mode ?? 'single-package';
  const submodulesByPath = new Map();

  // Phase 2: seed inventory from triage.
  const { inventorySource, workspaces } = seedInventoryFromTriage(triage, submodulesByPath);

  // Phase 3: topology.nodes is authoritative for files/loc.
  redistributeFilesFromNodes(topology.nodes ?? {}, submodulesByPath);

  // Phase 4: augment degrees from cross-edges.
  augmentDegreesFromEdges(topology, hasFullList, submodulesByPath, inventorySource, diagnostics);

  // Phase 5: SCC membership.
  const sccs = attributeSccMembership(topology.sccs, submodulesByPath);

  // Phase 6: oversize files.
  const oversizeFiles = pickOversizeFiles(topology.largestFiles);

  // Phase 7: cross-edges for §2 display table.
  const crossEdgesForDisplay = buildCrossEdgesForDisplay(topology, hasFullList);

  const meta = {
    mode,
    lens: topology.summary?.lens ?? 'runtime',
    topologyComplete,
    crossEdgeSource,
    classificationConfidence,
    topologyStaleness,
  };

  return {
    submodulesByPath,
    crossEdgesForDisplay,
    sccs,
    oversizeFiles,
    workspaces: workspaces.length > 0 ? workspaces : null,
    diagnostics,
    meta,
  };
}

// ── renderTopology section helpers ──────────────────────────

function renderHeaderBlock(meta) {
  const lines = ['# Topology draft', ''];
  if (meta?.existingCanon === true) {
    lines.push(
      '> ⚠ Existing canon detected: `canonical/topology.md`.',
      '> This draft is OBSERVATIONAL ONLY — it reports what AST shows, not what canon',
      '> declares. Full drift detection is the job of `check-canon.mjs` (Post-P3).',
      '> Do not promote this file over the existing canon without manual review.',
      '',
    );
  }
  if (meta?.topologyComplete === false) {
    lines.push(
      '> ⚠ topology.json incomplete — some files absent from `nodes` (parse gaps).',
      '> Classification claims may under-report cycles or edges in the missing files.',
      '',
    );
  }
  if (meta?.topologyStaleness === 'stale') {
    lines.push(
      `> ⚠ topology.json is stale (> ${STALE_TOPOLOGY_HOURS}h old). Re-run \`measure-topology.mjs\` for a fresh snapshot.`,
      '',
    );
  }
  if (meta?.crossEdgeSource === 'top-30-only') {
    lines.push(
      '> ⚠ Submodule classification derived from top-30 cross-edge lens.',
      '> `isolated-submodule` suppressed in this degraded mode. Upgrade `measure-topology.mjs`',
      '> to emit full `crossSubmoduleEdges` for high-confidence classification.',
      '',
    );
  }
  lines.push(
    `Generated: ${meta?.generatedAt ?? meta?.generated ?? new Date().toISOString()}`,
    `Scope: ${meta?.scope ?? 'unspecified'}`,
    `Source: ${meta?.source ?? 'topology.json'}`,
    `Lens: ${meta?.lens ?? 'runtime'}`,
    `Mode: ${meta?.mode ?? 'single-package'}`,
    `TopologyComplete: ${meta?.topologyComplete === false ? 'false' : 'true'}`,
    `CrossEdgeSource: ${meta?.crossEdgeSource ?? 'full-list'}`,
    `ClassificationConfidence: ${meta?.classificationConfidence ?? 'high'}`,
    '',
  );
  return lines;
}

function renderSubmoduleInventory(submodulesByPath, meta) {
  const lines = [
    '## 1. Submodule inventory',
    '',
    '| Submodule | Files | LOC | In-edges | Out-edges | SCC | Status | Tags |',
    '|-----------|------:|----:|---------:|----------:|-----|--------|------|',
  ];
  const sorted = [...submodulesByPath.values()].sort((a, b) => a.name < b.name ? -1 : 1);
  for (const entry of sorted) {
    const cls = classifyTopologySubmodule({
      name: entry.name,
      inDegree: entry.inDegree,
      outDegree: entry.outDegree,
      sccMember: entry.sccMember,
      crossEdgeSource: meta?.crossEdgeSource ?? 'full-list',
    });
    const sccCell = entry.sccMember ? '●' : '—';
    lines.push(
      `| ${codeCell(entry.name)} | ${entry.files} | ${entry.loc} | ${entry.inDegree} ` +
      `| ${entry.outDegree} | ${sccCell} | ${escapeMdCell(cls.label + ' ' + cls.marker)} |  |`
    );
  }
  lines.push('');
  return lines;
}

function renderCrossEdges(crossEdgesForDisplay) {
  const lines = ['## 2. Cross-submodule edges (top 30)', ''];
  if (crossEdgesForDisplay.length === 0) {
    lines.push('_No cross-submodule edges observed._', '');
    return lines;
  }
  lines.push('| From | To | Count |', '|------|----|------:|');
  for (const e of crossEdgesForDisplay.slice(0, 30)) {
    lines.push(`| ${codeCell(e.from)} | ${codeCell(e.to)} | ${e.count} |`);
  }
  lines.push('');
  return lines;
}

function renderCyclesSection(sccs) {
  const lines = ['## 3. Cycles (SCCs)', ''];
  if (sccs.length === 0) {
    lines.push('✅ No submodule-level cycles observed. Repo is acyclic at submodule granularity.', '');
    return lines;
  }
  lines.push('❌ Cycles observed — canon invariant violation:', '');
  for (const scc of sccs) {
    const cls = classifyTopologyScc(scc);
    lines.push(`### Cycle ${scc.sccIndex + 1} (size ${scc.members.length}) — ${cls.label} ${cls.marker}`, '');
    for (const member of scc.members) {
      lines.push(`- ${codeCell(member)}`);
    }
    lines.push('');
  }
  return lines;
}

function renderOversizeSection(oversizeFiles) {
  const lines = ['## 4. Oversize files (≥ 400 LOC)', ''];
  if (oversizeFiles.length === 0) {
    lines.push('_No oversize files observed._', '');
    return lines;
  }
  lines.push('| File | LOC | Status |', '|------|----:|--------|');
  for (const f of oversizeFiles) {
    lines.push(`| ${codeCell(f.file)} | ${f.loc} | ${escapeMdCell(f.label + ' ' + f.marker)} |`);
  }
  lines.push('');
  return lines;
}

function renderWorkspaceSection(workspaces) {
  if (!workspaces || workspaces.length === 0) return [];
  const lines = [
    '## 5. Workspace boundaries',
    '',
    '| Package | Path | Files | LOC |',
    '|---------|------|------:|----:|',
  ];
  for (const w of workspaces) {
    lines.push(`| ${codeCell(w.name)} | ${codeCell(w.path)} | ${w.files} | ${w.loc} |`);
  }
  lines.push('');
  return lines;
}

function renderNotesSection(diagnostics) {
  if (diagnostics.length === 0) return [];
  const lines = ['## Notes', ''];
  for (const d of diagnostics) {
    const prefix = d.kind === 'boundary-mismatch' ? '[diagnostic]' : '[확인 불가]';
    const targetPart = d.target ? ` target: ${codeCell(d.target)}` : '';
    const notePart = d.note ? ` — ${escapeMdCell(d.note)}` : '';
    lines.push(`- ${prefix} reason: ${escapeMdCell(d.reason)}${targetPart}${notePart}`);
  }
  lines.push('');
  return lines;
}

/**
 * Render aggregated topology to multi-section Markdown. Thin orchestrator —
 * each section is a dedicated renderer above.
 */
export function renderTopology({
  submodulesByPath,
  crossEdgesForDisplay,
  sccs,
  oversizeFiles,
  workspaces,
  diagnostics,
  meta,
}) {
  return [
    ...renderHeaderBlock(meta),
    ...renderSubmoduleInventory(submodulesByPath, meta),
    ...renderCrossEdges(crossEdgesForDisplay),
    ...renderCyclesSection(sccs),
    ...renderOversizeSection(oversizeFiles),
    ...renderWorkspaceSection(workspaces),
    ...renderNotesSection(diagnostics),
  ].join('\n');
}
