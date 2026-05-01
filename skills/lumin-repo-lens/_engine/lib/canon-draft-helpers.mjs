// _lib/canon-draft-helpers.mjs — P3-2 helper-registry classifier + aggregator + renderer.
//
// Extracted from `_lib/canon-draft.mjs` during post-P3 cleanup (2026-04-21).
//
// Per maintainer history notes v2 PF-3/PF-4:
//   - Definition inventory comes from a fresh `extractDefinitionsAndUses`
//     pass on the scan range — NOT from call-graph.json.
//   - Fan-in is consumer-file-count (distinct files that import the
//     helper), NOT aggregated call-site count from call-graph.json.
//   - call-graph.json, when present, is cross-check only.

import {
  HELPER_OWNER_KINDS,
  LOW_INFO_HELPER_NAMES_SET,
  isContaminated,
  isSeverelyContaminated,
  makeIdentity,
  escapeMdCell,
  codeCell,
} from './canon-draft-utils.mjs';

// ── Helper group classification (canonical §10.1) ──────

/**
 * @param {{
 *   name: string,
 *   identities: string[],
 *   fanInByIdentity: Record<string, number>,
 *   contaminationByIdentity: Record<string, {label?: string, labels?: string[]}>,
 * }} input
 * @returns {{ label: string, marker: string }}
 */
export function classifyHelperGroup({
  name,
  identities,
  fanInByIdentity,
  contaminationByIdentity,
}) {
  if (!Array.isArray(identities) || identities.length < 2) {
    throw new Error('classifyHelperGroup requires identities.length >= 2');
  }

  const allContaminated = identities.every((id) =>
    isContaminated(contaminationByIdentity?.[id]));
  if (allContaminated) {
    return { label: 'ANY_COLLISION_HELPER', marker: '⚠' };
  }

  const fanIns = identities.map((id) => fanInByIdentity?.[id] ?? 0);
  const maxFanIn = Math.max(...fanIns);
  const sumFanIn = fanIns.reduce((a, b) => a + b, 0);

  if (maxFanIn >= 3 && sumFanIn >= 3) {
    return { label: 'HELPER_DUPLICATE_STRONG', marker: '❌' };
  }
  if (maxFanIn < 3 && LOW_INFO_HELPER_NAMES_SET.has(name)) {
    return { label: 'HELPER_LOCAL_COMMON', marker: '⚠' };
  }
  return { label: 'HELPER_DUPLICATE_REVIEW', marker: '⚠' };
}

// ── Helper single-identity classification (canonical §10.2) ──

/**
 * @param {{
 *   identity: string,
 *   fanIn: number,
 *   contamination: {label?: string} | null | undefined,
 *   exportedName?: string,
 * }} input
 * @returns {{ label: string, marker: string }}
 */
export function classifyHelperIdentity({
  identity,
  fanIn,
  contamination,
  exportedName,
}) {
  if (isSeverelyContaminated(contamination)) {
    return { label: 'severely-any-contaminated-helper', marker: '⚠' };
  }

  const name = typeof exportedName === 'string' && exportedName.length > 0
    ? exportedName
    : (typeof identity === 'string' ? (identity.split('::').pop() ?? '') : '');

  if (LOW_INFO_HELPER_NAMES_SET.has(name) && fanIn < 3) {
    return { label: 'low-signal-helper-name', marker: '⚠' };
  }
  if (fanIn >= 3) {
    return { label: 'central-helper', marker: '✅' };
  }
  if (fanIn === 1 || fanIn === 2) {
    return { label: 'shared-helper', marker: '⚠' };
  }
  return { label: 'zero-internal-fan-in-helper', marker: '⚠' };
}

// ── Helper-registry aggregation + render (P3-2) ─────────────

const STALE_CALL_GRAPH_HOURS = 24;

/**
 * Aggregate helper ownership from a fresh AST pass.
 *
 * @param {{
 *   files: string[],
 *   root: string,
 *   extractFn: (filePath: string) => {defs, uses, reExports},
 *   resolveSpecifier: (fromFile: string, spec: string) => string | null,
 *   symbols?: object | null,
 *   callGraph?: object | null,
 *   nowMs?: number,
 * }} input
 */
// ── collectHelperIdentities passes (extracted during post-P3 cleanup) ──

function makeToRelative(root) {
  const rootNormalized = typeof root === 'string' ? root.replace(/\\/g, '/').replace(/\/$/, '') : '';
  return (abs) => {
    if (!rootNormalized) return abs.replace(/\\/g, '/');
    const norm = abs.replace(/\\/g, '/');
    if (norm.startsWith(rootNormalized + '/')) return norm.slice(rootNormalized.length + 1);
    return norm;
  };
}

// Pass 1a: run extractor per file; capture parse errors as diagnostics.
// Returns {perFileDefs, perFileUses} maps keyed by absolute file path.
function extractPerFile(files, extractFn, toRelative, diagnostics) {
  const perFileDefs = new Map();
  const perFileUses = new Map();
  for (const absFile of files) {
    let parsed;
    try {
      parsed = extractFn(absFile);
    } catch (err) {
      diagnostics.push({
        kind: 'parse-error',
        reason: 'extractor-threw',
        target: toRelative(absFile),
        note: (err && err.message) || String(err),
      });
      continue;
    }
    perFileDefs.set(absFile, parsed.defs || []);
    perFileUses.set(absFile, parsed.uses || []);
  }
  return { perFileDefs, perFileUses };
}

// Pass 1b: build the helper inventory (Map<identity, def>) + helpersByName
// index + distinctConsumerFiles seed Map. Mutates the three passed maps.
function buildHelperInventory(perFileDefs, toRelative, helperDefsByIdentity, helpersByName, distinctConsumerFiles) {
  for (const [absFile, defs] of perFileDefs) {
    const relFile = toRelative(absFile);
    for (const def of defs) {
      if (!def || !HELPER_OWNER_KINDS.has(def.kind)) continue;
      const identity = makeIdentity(relFile, def.name);
      helperDefsByIdentity.set(identity, {
        name: def.name,
        kind: def.kind,
        line: def.line,
        ownerFile: relFile,
        fanIn: 0,
        anyContamination: null,
        signature: null,
      });
      if (!helpersByName.has(def.name)) helpersByName.set(def.name, []);
      helpersByName.get(def.name).push(identity);
      distinctConsumerFiles.set(identity, new Set());
    }
  }
}

// Pass 2: consumer-file fan-in (PF-4 — distinct consumer files per owner).
function computeConsumerFileFanIn(perFileUses, toRelative, resolveSpecifier, helperDefsByIdentity, distinctConsumerFiles) {
  for (const [consumerAbs, uses] of perFileUses) {
    const consumerRel = toRelative(consumerAbs);
    for (const use of uses) {
      if (!use || typeof use.fromSpec !== 'string') continue;
      if (use.typeOnly) continue;
      if (use.kind === 'reExport') continue;
      const resolved = resolveSpecifier(consumerAbs, use.fromSpec);
      if (!resolved) continue;
      const resolvedRel = toRelative(resolved);
      const importedName = use.name;
      if (typeof importedName !== 'string' || importedName.length === 0) continue;
      if (importedName === '*' || importedName === 'default') continue;
      const identity = makeIdentity(resolvedRel, importedName);
      if (!helperDefsByIdentity.has(identity)) continue;
      if (consumerRel === resolvedRel) continue;
      distinctConsumerFiles.get(identity).add(consumerRel);
    }
  }
  for (const [identity, def] of helperDefsByIdentity) {
    def.fanIn = distinctConsumerFiles.get(identity)?.size ?? 0;
  }
}

// Pass 3: enrich helper defs with producer-emitted helper-owner facts
// (contamination annotation + signature). Returns 'available' iff at
// least one helper-owner fact was found.
function enrichFromHelperOwners(symbols, helperDefsByIdentity) {
  const helperOwnersByIdentity = symbols && typeof symbols === 'object'
    ? (symbols.helperOwnersByIdentity ?? null)
    : null;
  if (!helperOwnersByIdentity || Object.keys(helperOwnersByIdentity).length === 0) {
    return 'unavailable';
  }
  for (const [identity, def] of helperDefsByIdentity) {
    const owner = helperOwnersByIdentity[identity];
    if (!owner) continue;
    if (owner.anyContamination) def.anyContamination = owner.anyContamination;
    if (typeof owner.signature === 'string') def.signature = owner.signature;
  }
  return 'available';
}

// Pass 4: cross-check call-graph.json against our AST-derived fan-in.
// Surfaces 'possible reflection/callback' diagnostics. Returns staleness
// label ('fresh' | 'stale' | 'absent').
function crossCheckCallGraph(callGraph, nowMs, helperDefsByIdentity, distinctConsumerFiles, diagnostics) {
  if (!callGraph || typeof callGraph !== 'object') return 'absent';
  let callGraphStaleness = 'fresh';
  const generated = callGraph.meta?.generated;
  if (typeof generated === 'string') {
    const ts = Date.parse(generated);
    if (Number.isFinite(ts)) {
      const ageHours = (nowMs - ts) / (1000 * 60 * 60);
      callGraphStaleness = ageHours > STALE_CALL_GRAPH_HOURS ? 'stale' : 'fresh';
    }
  }
  const topCallees = Array.isArray(callGraph.topCallees) ? callGraph.topCallees : [];
  for (const tc of topCallees) {
    if (!tc || typeof tc.file !== 'string' || typeof tc.name !== 'string') continue;
    const identity = makeIdentity(tc.file, tc.name);
    if (!helperDefsByIdentity.has(identity)) continue;
    const astFanIn = distinctConsumerFiles.get(identity)?.size ?? 0;
    if ((tc.count ?? 0) > 0 && astFanIn === 0) {
      diagnostics.push({
        kind: 'call-graph-cross-check',
        reason: 'call-graph-evidence-but-no-ast-consumers',
        target: identity,
        note: `topCallees.count=${tc.count} but import-resolve fan-in=0; possible reflection/callback${callGraphStaleness === 'stale' ? ' (stale source)' : ''}`,
      });
    }
  }
  return callGraphStaleness;
}

export function collectHelperIdentities({
  files,
  root,
  extractFn,
  resolveSpecifier,
  symbols = null,
  callGraph = null,
  nowMs = Date.now(),
}) {
  if (!Array.isArray(files)) throw new Error('collectHelperIdentities requires files: string[]');
  if (typeof extractFn !== 'function') throw new Error('collectHelperIdentities requires extractFn');
  if (typeof resolveSpecifier !== 'function') {
    throw new Error('collectHelperIdentities requires resolveSpecifier');
  }

  const helperDefsByIdentity = new Map();
  const helpersByName = new Map();
  const distinctConsumerFiles = new Map();
  const diagnostics = [];
  const toRelative = makeToRelative(root);

  // Pass 1: extract + inventory.
  const { perFileDefs, perFileUses } = extractPerFile(files, extractFn, toRelative, diagnostics);
  buildHelperInventory(perFileDefs, toRelative, helperDefsByIdentity, helpersByName, distinctConsumerFiles);

  // Pass 2: consumer-file fan-in.
  computeConsumerFileFanIn(perFileUses, toRelative, resolveSpecifier, helperDefsByIdentity, distinctConsumerFiles);

  // Pass 3: optional enrichment from helper-owner facts.
  const helperContamination = enrichFromHelperOwners(symbols, helperDefsByIdentity);

  // Pass 4: call-graph cross-check.
  const callGraphStaleness = crossCheckCallGraph(
    callGraph, nowMs, helperDefsByIdentity, distinctConsumerFiles, diagnostics,
  );

  const meta = {
    helperContamination,
    callGraphStaleness,
    filesScanned: perFileDefs.size,
  };

  return { helperDefsByIdentity, helpersByName, distinctConsumerFiles, diagnostics, meta };
}

/**
 * Render helper-registry Markdown per maintainer history notes v2 §4.1.
 */
export function renderHelperRegistry({
  helperDefsByIdentity,
  helpersByName,
  distinctConsumerFiles: _distinctConsumerFiles, // accepted for caller-spread compat; not read here
  diagnostics,
  meta,
}) {
  const lines = [];
  lines.push('# Helper registry draft');
  lines.push('');

  if (meta?.existingCanon === true) {
    lines.push('> ⚠ Existing canon detected: `canonical/helper-registry.md`.');
    lines.push('> This draft is OBSERVATIONAL ONLY — it reports what AST shows, not what canon');
    lines.push('> declares. Full drift detection is the job of `check-canon.mjs` (Post-P3).');
    lines.push('> Do not promote this file over the existing canon without manual review.');
    lines.push('');
  }

  if (meta?.callGraphStaleness === 'stale') {
    const ageHours = typeof meta?.callGraphAgeHours === 'number'
      ? meta.callGraphAgeHours.toFixed(0) : '>24';
    lines.push(`> ⚠ Source call-graph.json is ${ageHours} hours stale. Cross-check diagnostics may under-report.`);
    lines.push('');
  }

  lines.push(`Generated: ${meta?.generatedAt ?? meta?.generated ?? new Date().toISOString()}`);
  lines.push(`Scope: ${meta?.scope ?? 'unspecified'}`);
  lines.push(`Source: ${meta?.source ?? 'fresh-ast-pass'}`);
  lines.push(`FanInKind: consumer-file-count`);
  const modeLabel = meta?.helperContamination === 'available'
    ? 'fresh-ast + helper-owner enrichment'
    : 'fresh-ast';
  lines.push(`Mode: ${modeLabel}`);
  lines.push('');

  const entryRows = [];
  for (const [name, identities] of helpersByName) {
    if (identities.length >= 2) {
      const fanInByIdentity = {};
      const contaminationByIdentity = {};
      for (const id of identities) {
        const def = helperDefsByIdentity.get(id);
        fanInByIdentity[id] = def.fanIn;
        if (def.anyContamination) contaminationByIdentity[id] = def.anyContamination;
      }
      const group = classifyHelperGroup({
        name, identities, fanInByIdentity, contaminationByIdentity,
      });
      for (const id of identities) {
        const def = helperDefsByIdentity.get(id);
        entryRows.push(buildHelperRow(def, id, group.label, group.marker));
      }
    } else {
      const id = identities[0];
      const def = helperDefsByIdentity.get(id);
      const single = classifyHelperIdentity({
        identity: id, fanIn: def.fanIn, contamination: def.anyContamination, exportedName: def.name,
      });
      entryRows.push(buildHelperRow(def, id, single.label, single.marker));
    }
  }

  entryRows.sort((a, b) => {
    if (a.ownerFile !== b.ownerFile) return a.ownerFile < b.ownerFile ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });

  lines.push('| Name | Identity | Owner | Signature | Fan-in | Status | Tags | Any / unknown signal |');
  lines.push('|------|----------|-------|-----------|-------:|--------|------|----------------------|');
  for (const row of entryRows) {
    lines.push(
      `| ${codeCell(row.name)} | ${codeCell(row.identity)} | ${codeCell(row.ownerLine)} ` +
      `| ${row.signatureCell} | ${row.fanIn} | ${escapeMdCell(row.status + ' ' + row.marker)} ` +
      `| ${escapeMdCell(row.tags)} | ${row.contaminationCell} |`
    );
  }
  lines.push('');

  if (diagnostics.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const d of diagnostics) {
      const prefix = d.kind === 'call-graph-cross-check' ? '[diagnostic]' : '[확인 불가]';
      const targetPart = d.target ? ` target: ${codeCell(d.target)}` : '';
      const notePart = d.note ? ` — ${escapeMdCell(d.note)}` : '';
      lines.push(`- ${prefix} reason: ${escapeMdCell(d.reason)}${targetPart}${notePart}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function buildHelperRow(def, identity, label, marker) {
  const tags = [];
  return {
    name: def.name,
    identity,
    ownerFile: def.ownerFile,
    ownerLine: `${def.ownerFile}:${def.line}`,
    line: def.line,
    fanIn: def.fanIn,
    signatureCell: def.signature ? codeCell(def.signature) : '—',
    status: label,
    marker,
    tags: tags.join(' '),
    contaminationCell: def.anyContamination?.label
      ? escapeMdCell(def.anyContamination.label)
      : '—',
  };
}
