// _lib/check-canon-types.mjs
//
// P5-1 — type-ownership drift engine.
//
// Consumes:
//   - canonical/type-ownership.md (parsed via check-canon-artifact.mjs)
//   - symbols.json (projected via canon-draft-types::collectTypeIdentities)
//
// Produces:
//   - drift records per canon-drift.md §3.1 type-drift categories
//   - per-source Markdown report with §4.1 structure (p5-1.md)
//
// Differ algorithm (p5-1.md §5.3):
//   1. Identity-based pass: identity-removed / identity-added / label-changed.
//   2. Name-based 1:1 upgrade: exactly 1 add + 1 remove same exportedName →
//      single owner-changed record (labels preserved on both sides).
//   3. Ambiguous n:m (n+m ≥ 3 with shared name) → keep as separate records
//      with confidence='low'.

import {
  collectTypeIdentities,
  classifySingleIdentity,
  classifyTypeNameGroup,
} from './canon-draft-types.mjs';
import { loadTypeOwnershipCanon } from './check-canon-artifact.mjs';
import { makeDriftRecord } from './check-canon-utils.mjs';
import { parseShapeIndexArtifact } from './shape-index-schema.mjs';

function classifyFreshRecords({ typeDefsByIdentity, identitiesByName }) {
  const freshByIdentity = new Map();
  for (const [name, identities] of identitiesByName) {
    if (identities.length >= 2) {
      const fanInByIdentity = {};
      const contaminationByIdentity = {};
      for (const id of identities) {
        const def = typeDefsByIdentity.get(id);
        fanInByIdentity[id] = def.fanIn ?? 0;
        contaminationByIdentity[id] = def.anyContamination;
      }
      const group = classifyTypeNameGroup({
        name, identities, fanInByIdentity, contaminationByIdentity,
      });
      for (const id of identities) {
        const def = typeDefsByIdentity.get(id);
        freshByIdentity.set(id, {
          identity: id,
          exportedName: name,
          ownerFile: def.ownerFile,
          owner: `${def.ownerFile}:${def.line}`,
          fanIn: def.fanIn ?? 0,
          label: group.label,
        });
      }
    } else {
      const id = identities[0];
      const def = typeDefsByIdentity.get(id);
      const single = classifySingleIdentity({
        identity: id,
        fanIn: def.fanIn ?? 0,
        kind: def.kind,
        contamination: def.anyContamination,
      });
      freshByIdentity.set(id, {
        identity: id,
        exportedName: name,
        ownerFile: def.ownerFile,
        owner: `${def.ownerFile}:${def.line}`,
        fanIn: def.fanIn ?? 0,
        label: single.label,
      });
    }
  }
  return freshByIdentity;
}

function buildShapeHashByIdentity(shapeIndex) {
  if (!shapeIndex) return null;
  const parsed = parseShapeIndexArtifact(shapeIndex);
  if (!parsed.ok) return null;
  const hashes = new Map();
  for (const [identity, fact] of parsed.factsByIdentity) {
    if (typeof fact?.hash === 'string') hashes.set(identity, fact.hash);
  }
  return hashes;
}

function pushOwnerChangedDrift({ drifts, canonByIdentity, freshByIdentity, addId, remId }) {
  const canon = canonByIdentity.get(remId);
  const fresh = freshByIdentity.get(addId);
  drifts.push(makeDriftRecord({
    kind: 'type-drift',
    category: 'owner-changed',
    identity: remId,
    canon: {
      file: 'canonical/type-ownership.md',
      line: canon.line,
      label: canon.label,
      owner: canon.owner,
      identity: remId,
    },
    fresh: {
      label: fresh.label,
      owner: fresh.owner,
      identity: addId,
    },
    confidence: 'high',
  }));
}

function collectUniqueShapePairs({ addedIds, removedIds, shapeHashByIdentity }) {
  const addedByHash = new Map();
  const removedByHash = new Map();

  for (const id of addedIds) {
    const hash = shapeHashByIdentity.get(id);
    if (!hash) continue;
    if (!addedByHash.has(hash)) addedByHash.set(hash, []);
    addedByHash.get(hash).push(id);
  }
  for (const id of removedIds) {
    const hash = shapeHashByIdentity.get(id);
    if (!hash) continue;
    if (!removedByHash.has(hash)) removedByHash.set(hash, []);
    removedByHash.get(hash).push(id);
  }

  const pairs = [];
  const hashes = [...addedByHash.keys()]
    .filter((hash) => removedByHash.has(hash))
    .sort();
  for (const hash of hashes) {
    const addMatches = [...addedByHash.get(hash)].sort();
    const remMatches = [...removedByHash.get(hash)].sort();
    if (addMatches.length === 1 && remMatches.length === 1) {
      pairs.push({ addId: addMatches[0], remId: remMatches[0] });
    }
  }

  pairs.sort((a, b) => {
    if (a.remId !== b.remId) return a.remId.localeCompare(b.remId);
    return a.addId.localeCompare(b.addId);
  });
  return pairs;
}

function diffRecords(canonByIdentity, freshByIdentity, { shapeIndex = null } = {}) {
  const drifts = [];
  const shapeHashByIdentity = buildShapeHashByIdentity(shapeIndex);
  // Pass 1: identity-based diff
  const addedIdentities = [];
  const removedIdentities = [];
  for (const [id, canon] of canonByIdentity) {
    const fresh = freshByIdentity.get(id);
    if (!fresh) {
      removedIdentities.push(id);
      continue;
    }
    if (canon.label !== fresh.label) {
      drifts.push(makeDriftRecord({
        kind: 'type-drift',
        category: 'label-changed',
        identity: id,
        canon: { file: 'canonical/type-ownership.md', line: canon.line, label: canon.label, owner: canon.owner },
        fresh: { label: fresh.label, owner: fresh.owner },
        confidence: 'high',
      }));
    }
  }
  for (const [id] of freshByIdentity) {
    if (!canonByIdentity.has(id)) addedIdentities.push(id);
  }

  // Pass 2: name-based 1:1 owner-changed upgrade
  const addedByName = new Map();
  const removedByName = new Map();
  for (const id of addedIdentities) {
    const r = freshByIdentity.get(id);
    if (!addedByName.has(r.exportedName)) addedByName.set(r.exportedName, []);
    addedByName.get(r.exportedName).push(id);
  }
  for (const id of removedIdentities) {
    const r = canonByIdentity.get(id);
    if (!removedByName.has(r.exportedName)) removedByName.set(r.exportedName, []);
    removedByName.get(r.exportedName).push(id);
  }

  const consumedAdded = new Set();
  const consumedRemoved = new Set();
  const lowConfidenceAdded = new Set();
  const lowConfidenceRemoved = new Set();
  for (const [name, addedIds] of addedByName) {
    const removedIds = removedByName.get(name) ?? [];
    if (removedIds.length === 0) continue;
    if (addedIds.length === 1 && removedIds.length === 1) {
      const addId = addedIds[0];
      const remId = removedIds[0];
      // Top-level identity MUST follow canon-drift.md §4 type-drift contract:
      // `ownerFile::exportedName`. Anchor to canon (remId) — the new owner
      // location lives in fresh.identity, preserving both sides' information.
      pushOwnerChangedDrift({ drifts, canonByIdentity, freshByIdentity, addId, remId });
      consumedAdded.add(addId);
      consumedRemoved.add(remId);
      continue;
    }

    if (shapeHashByIdentity) {
      const pairs = collectUniqueShapePairs({
        addedIds,
        removedIds,
        shapeHashByIdentity,
      });
      for (const { addId, remId } of pairs) {
        pushOwnerChangedDrift({ drifts, canonByIdentity, freshByIdentity, addId, remId });
        consumedAdded.add(addId);
        consumedRemoved.add(remId);
      }
    }

    const unresolvedAdded = addedIds.filter((id) => !consumedAdded.has(id));
    const unresolvedRemoved = removedIds.filter((id) => !consumedRemoved.has(id));
    if (unresolvedAdded.length > 0 && unresolvedRemoved.length > 0) {
      for (const id of unresolvedAdded) lowConfidenceAdded.add(id);
      for (const id of unresolvedRemoved) lowConfidenceRemoved.add(id);
    }
  }

  // Emit remaining added / removed (not consumed by owner-change upgrade)
  for (const id of addedIdentities) {
    if (consumedAdded.has(id)) continue;
    const fresh = freshByIdentity.get(id);
    const confidence = lowConfidenceAdded.has(id) ? 'low' : 'high';
    drifts.push(makeDriftRecord({
      kind: 'type-drift',
      category: 'identity-added',
      identity: id,
      fresh: { label: fresh.label, owner: fresh.owner },
      confidence,
    }));
  }
  for (const id of removedIdentities) {
    if (consumedRemoved.has(id)) continue;
    const canon = canonByIdentity.get(id);
    const confidence = lowConfidenceRemoved.has(id) ? 'low' : 'high';
    drifts.push(makeDriftRecord({
      kind: 'type-drift',
      category: 'identity-removed',
      identity: id,
      canon: {
        file: 'canonical/type-ownership.md',
        line: canon.line,
        label: canon.label,
        owner: canon.owner,
      },
      confidence,
    }));
  }

  return drifts;
}

function renderDriftMarkdown({ drifts, canonPath, canonLineCount }) {
  const lines = [];
  lines.push('# Type-ownership canon drift');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Canon file: ${canonPath}`);
  lines.push(`Canon line count: ${canonLineCount}`);
  lines.push(`Drift count: ${drifts.length}`);
  lines.push('');

  const byCat = {
    'identity-added':   drifts.filter((d) => d.category === 'identity-added'),
    'identity-removed': drifts.filter((d) => d.category === 'identity-removed'),
    'label-changed':    drifts.filter((d) => d.category === 'label-changed'),
    'owner-changed':    drifts.filter((d) => d.category === 'owner-changed'),
  };

  lines.push('## 1. Summary');
  lines.push('');
  lines.push('| Category | Family | Count |');
  lines.push('|----------|--------|------:|');
  lines.push(`| identity-added    | added                     | ${byCat['identity-added'].length} |`);
  lines.push(`| identity-removed  | removed                   | ${byCat['identity-removed'].length} |`);
  lines.push(`| label-changed     | label-changed             | ${byCat['label-changed'].length} |`);
  lines.push(`| owner-changed     | structural-status-changed | ${byCat['owner-changed'].length} |`);
  lines.push('');

  let section = 2;
  if (byCat['identity-added'].length > 0) {
    lines.push(`## ${section}. identity-added`);
    lines.push('');
    lines.push('| Identity | Fresh owner | Fresh label | Confidence |');
    lines.push('|----------|-------------|-------------|------------|');
    for (const d of byCat['identity-added']) {
      lines.push(`| \`${d.identity}\` | \`${d.fresh.owner}\` | \`${d.fresh.label}\` | ${d.confidence} |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['identity-removed'].length > 0) {
    lines.push(`## ${section}. identity-removed`);
    lines.push('');
    lines.push('| Identity | Canon owner | Canon label | Canon line | Confidence |');
    lines.push('|----------|-------------|-------------|-----------:|------------|');
    for (const d of byCat['identity-removed']) {
      lines.push(`| \`${d.identity}\` | \`${d.canon.owner}\` | \`${d.canon.label}\` | ${d.canon.line} | ${d.confidence} |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['label-changed'].length > 0) {
    lines.push(`## ${section}. label-changed`);
    lines.push('');
    lines.push('| Identity | Canon label | Fresh label | Canon line |');
    lines.push('|----------|-------------|-------------|-----------:|');
    for (const d of byCat['label-changed']) {
      lines.push(`| \`${d.identity}\` | \`${d.canon.label}\` | \`${d.fresh.label}\` | ${d.canon.line} |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['owner-changed'].length > 0) {
    lines.push(`## ${section}. owner-changed`);
    lines.push('');
    lines.push('| Exported name | Canon owner | Fresh owner | Canon label | Fresh label | Canon line |');
    lines.push('|---------------|-------------|-------------|-------------|-------------|-----------:|');
    for (const d of byCat['owner-changed']) {
      const name = d.canon.identity.split('::').pop();
      lines.push(
        `| \`${name}\` | \`${d.canon.owner}\` | \`${d.fresh.owner}\` ` +
        `| \`${d.canon.label}\` | \`${d.fresh.label}\` | ${d.canon.line} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function detectTypeOwnershipDrift({ canonPath, symbols, canonLabelSet, loader, shapeIndex = null }) {
  const load = loader ?? loadTypeOwnershipCanon;
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

  const collected = collectTypeIdentities({ symbols });
  const freshByIdentity = classifyFreshRecords(collected);
  const drifts = diffRecords(canonResult.records, freshByIdentity, { shapeIndex });

  const reportMarkdown = renderDriftMarkdown({
    drifts,
    canonPath,
    canonLineCount: canonResult.lineCount,
  });

  return {
    drifts,
    status: drifts.length > 0 ? 'drift' : 'clean',
    diagnostics: [...canonResult.diagnostics, ...(collected.diagnostics ?? [])],
    reportMarkdown,
    canonLineCount: canonResult.lineCount,
  };
}
