// _lib/canon-draft-types.mjs — P3-1 type-ownership classifier + aggregator + renderer.
//
// Extracted from `_lib/canon-draft.mjs` during post-P3 cleanup (2026-04-21).
// Consumes shared primitives from `canon-draft-utils.mjs`.

import {
  LOW_INFO_NAMES_SET,
  isContaminated,
  isSeverelyContaminated,
  makeIdentity,
  escapeMdCell,
  codeCell,
} from './canon-draft-utils.mjs';
import { parseShapeIndexArtifact } from './shape-index-schema.mjs';

// ── Group classification (canonical §2) ────────────────
//
// Applies when `identities.length >= 2` (duplicate name). Evaluation
// order — first match wins:
//   Rule 0 — all members contaminated → ANY_COLLISION
//   Rule 1 — max(fanIn) ≥ 3 AND sum(fanIn) ≥ 3 → DUPLICATE_STRONG
//   Rule 2 — name ∈ LOW_INFO_NAMES AND max(fanIn) < 3 → LOCAL_COMMON_NAME
//   Rule 3 — else → DUPLICATE_REVIEW

/**
 * @param {{
 *   name: string,
 *   identities: string[],
 *   fanInByIdentity: Record<string, number>,
 *   contaminationByIdentity: Record<string, {label?: string, labels?: string[]}>,
 * }} input
 * @returns {{ label: string, marker: string }}
 */
export function classifyTypeNameGroup({
  name,
  identities,
  fanInByIdentity,
  contaminationByIdentity,
}) {
  if (!Array.isArray(identities) || identities.length < 2) {
    throw new Error('classifyTypeNameGroup requires identities.length >= 2');
  }

  // Rule 0: every identity contaminated.
  const allContaminated = identities.every((id) =>
    isContaminated(contaminationByIdentity?.[id]));
  if (allContaminated) {
    return { label: 'ANY_COLLISION', marker: '⚠' };
  }

  const fanIns = identities.map((id) => fanInByIdentity?.[id] ?? 0);
  const maxFanIn = Math.max(...fanIns);
  const sumFanIn = fanIns.reduce((a, b) => a + b, 0);

  // Rule 1: DUPLICATE_STRONG.
  if (maxFanIn >= 3 && sumFanIn >= 3) {
    return { label: 'DUPLICATE_STRONG', marker: '❌' };
  }

  // Rule 2: LOCAL_COMMON_NAME — fires ONLY when Rule 1 did not.
  if (maxFanIn < 3 && LOW_INFO_NAMES_SET.has(name)) {
    return { label: 'LOCAL_COMMON_NAME', marker: '⚠' };
  }

  // Rule 3: fallback.
  return { label: 'DUPLICATE_REVIEW', marker: '⚠' };
}

// ── Single-identity classification (canonical §4) ─────
//
// Applies when `group.size == 1`. First match wins:
//   Rule 0 — severely-contaminated → severely-any-contaminated
//   Rule 1 — TSTypeAliasDeclaration + name-len 1 + fanIn < 3 → low-signal-type-name
//   Rule 2 — fanIn ≥ 3 → single-owner-strong
//   Rule 3 — fanIn ∈ {1, 2} → single-owner-weak
//   Rule 4 — fanIn == 0 → zero-internal-fan-in

/**
 * @param {{
 *   identity: string,
 *   fanIn: number,
 *   kind: string,
 *   contamination: {label?: string, labels?: string[]} | null,
 * }} input
 * @returns {{ label: string, marker: string }}
 */
export function classifySingleIdentity({ identity, fanIn, kind, contamination }) {
  if (isSeverelyContaminated(contamination)) {
    return { label: 'severely-any-contaminated', marker: '⚠' };
  }

  const name = typeof identity === 'string'
    ? (identity.split('::').pop() ?? identity)
    : '';
  if (kind === 'TSTypeAliasDeclaration' && name.length === 1 && fanIn < 3) {
    return { label: 'low-signal-type-name', marker: '⚠' };
  }
  if (fanIn >= 3) {
    return { label: 'single-owner-strong', marker: '✅' };
  }
  if (fanIn === 1 || fanIn === 2) {
    return { label: 'single-owner-weak', marker: '⚠' };
  }
  return { label: 'zero-internal-fan-in', marker: '⚠' };
}

// ── Type-ownership aggregation + render (P3-1) ──────────────

// Exported top-level type declarations per maintainer spec notes §2.1.
const TYPE_OWNER_KINDS = new Set([
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
]);

function normalizeFanInSpace(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    value: Number.isFinite(record.value) ? record.value : 0,
    type: Number.isFinite(record.type) ? record.type : 0,
    broad: Number.isFinite(record.broad) ? record.broad : 0,
  };
}

function formatFanInSpace(space) {
  if (!space) return '—';
  return `value ${space.value}, type ${space.type}, broad ${space.broad}`;
}

// Heuristic path match for reExportsByFile → owner-file attribution.
// Conservative over-approximation — always correct in direction.
function barrelReExportsFile(reExportSource, ownerFile) {
  if (typeof reExportSource !== 'string' || typeof ownerFile !== 'string') return false;
  const src = reExportSource.replace(/^\.\//, '').replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, '');
  if (src.length === 0) return false;
  const re = new RegExp(
    `(^|[/\\\\])${src.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$`
  );
  return re.test(ownerFile);
}

/**
 * Aggregate type ownership from a symbols.json snapshot.
 *
 * @param {{ symbols: object | null }} input
 * @returns {{
 *   typeDefsByIdentity: Map,
 *   identitiesByName: Map,
 *   typeUsesByIdentity: Map,
 *   diagnostics: Array,
 * }}
 */
export function collectTypeIdentities({ symbols }) {
  const typeDefsByIdentity = new Map();
  const identitiesByName = new Map();
  const typeUsesByIdentity = new Map();
  const diagnostics = [];

  if (!symbols || typeof symbols !== 'object') {
    diagnostics.push({
      kind: 'symbols-missing',
      reason: 'symbols argument absent; fresh AST pass not wired in P3-1 v1 — draft will be empty',
    });
    return { typeDefsByIdentity, identitiesByName, typeUsesByIdentity, diagnostics };
  }

  const defIndex = symbols.defIndex ?? {};
  const fanInByIdentity = symbols.fanInByIdentity ?? {};
  const fanInByIdentitySpace = symbols.fanInByIdentitySpace ?? {};
  const reExportsByFile = symbols.reExportsByFile ?? {};

  for (const [file, defs] of Object.entries(defIndex)) {
    for (const [exportedName, info] of Object.entries(defs)) {
      if (!info || !TYPE_OWNER_KINDS.has(info.kind)) continue;
      const identity = makeIdentity(file, exportedName);
      typeDefsByIdentity.set(identity, {
        name: exportedName,
        kind: info.kind,
        line: info.line,
        ownerFile: file,
        anyContamination: info.anyContamination ?? null,
      });
      if (!identitiesByName.has(exportedName)) identitiesByName.set(exportedName, []);
      identitiesByName.get(exportedName).push(identity);
      typeUsesByIdentity.set(identity, {
        directConsumers: new Set(),
        reExportedThrough: new Set(),
      });
    }
  }

  for (const [barrelFile, reExports] of Object.entries(reExportsByFile)) {
    if (!Array.isArray(reExports)) continue;
    for (const re of reExports) {
      if (!re?.source) continue;
      for (const [identity, defInfo] of typeDefsByIdentity) {
        if (!barrelReExportsFile(re.source, defInfo.ownerFile)) continue;
        typeUsesByIdentity.get(identity).reExportedThrough.add(barrelFile);
      }
    }
  }

  for (const [identity, defInfo] of typeDefsByIdentity) {
    defInfo.fanIn = fanInByIdentity[identity] ?? 0;
    defInfo.fanInSpace = normalizeFanInSpace(fanInByIdentitySpace[identity]);
  }

  return { typeDefsByIdentity, identitiesByName, typeUsesByIdentity, diagnostics };
}

/**
 * Render type ownership to Markdown per maintainer spec notes v0.2.2 §6.
 */
export function renderTypeOwnership({
  typeDefsByIdentity,
  identitiesByName,
  typeUsesByIdentity,
  diagnostics,
  meta,
  shapeIndex = null,
}) {
  const lines = [];
  lines.push('# Type ownership draft');
  lines.push('');

  if (meta?.existingCanon === true) {
    lines.push('> ⚠ Existing canon detected: `canonical/type-ownership.md`.');
    lines.push('> This draft is OBSERVATIONAL ONLY — it reports what AST shows, not what canon');
    lines.push('> declares. Full drift detection is the job of `check-canon.mjs` (Post-P3).');
    lines.push('> Do not promote this file over the existing canon without manual review.');
    lines.push('');
  }

  lines.push(`Generated: ${meta?.generatedAt ?? meta?.generated ?? new Date().toISOString()}`);
  lines.push(`Scope: ${meta?.scope ?? 'unspecified'}`);
  lines.push(`Source: ${meta?.source ?? 'fresh-ast-pass'}`);
  if (meta?.barrelsOpaque) {
    lines.push('Barrels: opaque (symbols.json absent — re-export chain resolution disabled)');
  }
  lines.push('');

  const entryRows = [];
  const duplicateGroups = [];
  for (const [name, identities] of identitiesByName) {
    if (identities.length >= 2) {
      duplicateGroups.push({ name, identities: [...identities] });
      const fanInByIdentity = {};
      const contaminationByIdentity = {};
      for (const id of identities) {
        const def = typeDefsByIdentity.get(id);
        fanInByIdentity[id] = def.fanIn;
        contaminationByIdentity[id] = def.anyContamination;
      }
      const group = classifyTypeNameGroup({
        name, identities, fanInByIdentity, contaminationByIdentity,
      });
      for (const id of identities) {
        const def = typeDefsByIdentity.get(id);
        entryRows.push(buildRow(def, id, group.label, group.marker, typeUsesByIdentity.get(id)));
      }
    } else {
      const id = identities[0];
      const def = typeDefsByIdentity.get(id);
      const single = classifySingleIdentity({
        identity: id, fanIn: def.fanIn, kind: def.kind, contamination: def.anyContamination,
      });
      entryRows.push(buildRow(def, id, single.label, single.marker, typeUsesByIdentity.get(id)));
    }
  }

  entryRows.sort((a, b) => {
    if (a.ownerFile !== b.ownerFile) return a.ownerFile < b.ownerFile ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });

  lines.push('| Name | Identity | Owner | Fan-in | Fan-in space | Status | Tags |');
  lines.push('|------|----------|-------|-------:|--------------|--------|------|');
  for (const row of entryRows) {
    lines.push(
      `| ${codeCell(row.name)} | ${codeCell(row.identity)} | ${codeCell(row.ownerLine)} ` +
      `| ${row.fanIn} | ${escapeMdCell(row.fanInSpace)} | ${escapeMdCell(row.status + ' ' + row.marker)} | ${escapeMdCell(row.tags)} |`
    );
  }
  lines.push('');

  const shapeEvidenceNotes = buildShapeEvidenceNotes({ duplicateGroups, shapeIndex });
  if (shapeEvidenceNotes.length > 0) {
    lines.push('## Shape evidence');
    lines.push('');
    for (const note of shapeEvidenceNotes) lines.push(`- ${note}`);
    lines.push('');
  }

  if (diagnostics.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const d of diagnostics) {
      lines.push(`- [확인 불가, reason: ${escapeMdCell(d.reason)}]${d.target ? ' target: ' + codeCell(d.target) : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function buildShapeEvidenceNotes({ duplicateGroups, shapeIndex }) {
  if (!shapeIndex) return [];
  const parsed = parseShapeIndexArtifact(shapeIndex);
  if (!parsed.ok) {
    return [`shape evidence unavailable: malformed shape-index.json (${parsed.reason}: ${parsed.detail}).`];
  }

  const notes = [];
  let generatedOnlyGroupCount = 0;
  let generatedOnlyIdentityCount = 0;
  if (parsed.complete === false && duplicateGroups.length > 0) {
    notes.push('shape evidence degraded: shape-index.json is incomplete; positive hash matches are grounded, but missing facts are not absence proof.');
  }

  const groups = [...duplicateGroups].sort((a, b) => a.name.localeCompare(b.name));
  for (const { name, identities } of groups) {
    const identityFacts = identities.map((id) => ({ id, fact: parsed.factsByIdentity.get(id) }));
    const present = identityFacts.filter((x) => x.fact?.hash);
    if (present.length === 0) continue;
    if (
      present.length === identities.length &&
      present.every((x) => x.fact?.generatedFile)
    ) {
      generatedOnlyGroupCount += 1;
      generatedOnlyIdentityCount += identities.length;
      continue;
    }

    const byHash = new Map();
    for (const { id, fact } of present) {
      if (!byHash.has(fact.hash)) byHash.set(fact.hash, []);
      byHash.get(fact.hash).push(id);
    }
    for (const ids of byHash.values()) ids.sort();
    const hashes = [...byHash.keys()].sort();
    const missing = identityFacts
      .filter((x) => !x.fact?.hash)
      .map((x) => x.id)
      .sort();

    let note;
    if (hashes.length === 1 && present.length === identities.length) {
      note = `same-shape evidence: ${codeCell(name)} has ${present.length} identities sharing ${codeCell(hashes[0])} (${formatIdentityList(byHash.get(hashes[0]))}).`;
    } else if (hashes.length === 1) {
      note = `shape evidence partial: ${codeCell(name)} has ${present.length}/${identities.length} identities sharing ${codeCell(hashes[0])} (${formatIdentityList(byHash.get(hashes[0]))}).`;
    } else {
      note = `different-shape evidence: ${codeCell(name)} splits across ${hashes.length} shape hashes: ${hashes.map((hash) => `${codeCell(hash)} (${formatIdentityList(byHash.get(hash))})`).join('; ')}.`;
    }

    if (missing.length > 0) {
      note += ` Missing shape facts: ${formatIdentityList(missing)}.`;
    }
    notes.push(note);
  }

  if (generatedOnlyGroupCount > 0) {
    notes.unshift(
      `generated-shape evidence summarized: ${generatedOnlyGroupCount} generated-only duplicate type groups ` +
      `(${generatedOnlyIdentityCount} identities) omitted from detailed notes; shape-index.json facts remain available.`
    );
  }

  return notes;
}

function formatIdentityList(identities) {
  return identities.map((id) => codeCell(id)).join(', ');
}

function buildRow(def, identity, label, marker, uses) {
  const reExportedThrough = uses?.reExportedThrough;
  const tags = [];
  if (reExportedThrough && reExportedThrough.size > 0) {
    tags.push('re-exported-through:' + [...reExportedThrough].sort().join(','));
  }
  if (def.anyContamination?.label) {
    tags.push('contamination:' + def.anyContamination.label);
  }
  return {
    name: def.name,
    identity,
    ownerFile: def.ownerFile,
    ownerLine: `${def.ownerFile}:${def.line}`,
    line: def.line,
    fanIn: def.fanIn,
    fanInSpace: formatFanInSpace(def.fanInSpace),
    status: label,
    marker,
    tags: tags.join(' '),
  };
}
