// _lib/check-canon-utils.mjs
//
// P5-1 — PURE parser + drift-record + JSON object builder.
// NO fs I/O. Callers (check-canon-artifact.mjs, check-canon-types.mjs,
// check-canon.mjs) handle reads/writes.
//
// Contract mirror: canonical/canon-drift.md §3.1 (categories+families),
// §5.a (type-ownership parser columns), §5.e (strictness policy), §6
// (JSON artifact shape).

// Expected column order for type-ownership per canon-drift.md §5.a.
import {
  parseCanonMarkdown,
  parseFanInCell,
  stripBackticks,
} from './check-canon-markdown.mjs';

export { parseTopologyCanonText } from './check-canon-topology-parser.mjs';
export { parseNamingCanonText } from './check-canon-naming-parser.mjs';

const TYPE_OWNERSHIP_COLUMNS = ['Name', 'Identity', 'Owner', 'Fan-in', 'Status', 'Tags'];
const TYPE_OWNERSHIP_COLUMN_SET = new Set(TYPE_OWNERSHIP_COLUMNS);

// Expected column order for helper-registry per canon-drift.md §5.b.
const HELPER_REGISTRY_COLUMNS = ['Name', 'Identity', 'Owner', 'Signature', 'Fan-in', 'Status', 'Tags', 'Any / unknown signal'];
const HELPER_REGISTRY_COLUMN_SET = new Set(HELPER_REGISTRY_COLUMNS);

// canonical/classification-gates.md §9 — type label set (drift-locked).
// Mirrors the test-classification-gates §9 parsed enumeration. Keeping a
// local copy here avoids circular imports with the drift-test file; the
// DC-11 test pins this list against the canonical file.
export const TYPE_LABEL_SET = Object.freeze(new Set([
  'zero-internal-fan-in',
  'low-signal-type-name',
  'DUPLICATE_STRONG',
  'DUPLICATE_REVIEW',
  'LOCAL_COMMON_NAME',
  'single-owner-strong',
  'single-owner-weak',
  'severely-any-contaminated',
  'ANY_COLLISION',
]));

// canonical/classification-gates.md §10.3 — helper label set (drift-locked).
// 9 entries. DC-* drift tests in test-classification-gates pin §10.3 against
// this constant transitively (via the existing §10.3 mirror).
export const HELPER_LABEL_SET = Object.freeze(new Set([
  'HELPER_DUPLICATE_STRONG',
  'HELPER_DUPLICATE_REVIEW',
  'HELPER_LOCAL_COMMON',
  'ANY_COLLISION_HELPER',
  'severely-any-contaminated-helper',
  'central-helper',
  'shared-helper',
  'zero-internal-fan-in-helper',
  'low-signal-helper-name',
]));

// canonical/classification-gates.md §11.4 — topology label set (drift-locked).
// 8 entries.
export const TOPOLOGY_LABEL_SET = Object.freeze(new Set([
  'cyclic-submodule',
  'isolated-submodule',
  'shared-submodule',
  'leaf-submodule',
  'scoped-submodule',
  'forbidden-cycle',
  'oversize',
  'extreme-oversize',
]));

// canonical/classification-gates.md §12.3 — naming label set (drift-locked).
// 10 entries total (7 cohort + 3 per-item per §12.3).
export const NAMING_LABEL_SET = Object.freeze(new Set([
  'camelCase-dominant',
  'PascalCase-dominant',
  'kebab-case-dominant',
  'snake_case-dominant',
  'UPPER_SNAKE-dominant',
  'mixed-convention',
  'insufficient-evidence',
  'convention-match',
  'convention-outlier',
  'low-info-excluded',
]));

// canon-drift.md §3.1 — 20-entry frozen mapping.
// Keyed as `<kind>::<category>` because `label-changed` appears as
// BOTH a category (in 2 kinds) AND a family tag — the compound key
// disambiguates.
export const CATEGORY_TO_FAMILY = Object.freeze({
  'type-drift::identity-added':        'added',
  'type-drift::identity-removed':      'removed',
  'type-drift::label-changed':         'label-changed',
  'type-drift::owner-changed':         'structural-status-changed',
  'helper-drift::helper-added':        'added',
  'helper-drift::helper-removed':      'removed',
  'helper-drift::label-changed':       'label-changed',
  'helper-drift::contamination-changed': 'content-shifted',
  'helper-drift::fan-in-tier-changed': 'label-changed',
  'topology-drift::submodule-added':   'added',
  'topology-drift::submodule-removed': 'removed',
  'topology-drift::scc-status-changed': 'structural-status-changed',
  'topology-drift::oversize-changed':  'content-shifted',
  'topology-drift::cross-edge-added':  'added',
  'topology-drift::cross-edge-removed': 'removed',
  'naming-drift::cohort-added':        'added',
  'naming-drift::cohort-removed':      'removed',
  'naming-drift::cohort-convention-shifted': 'label-changed',
  'naming-drift::new-outlier-introduced': 'content-shifted',
  'naming-drift::outlier-resolved':    'content-shifted',
});

function parseIdentityCell(identityCell) {
  const identity = stripBackticks(identityCell);
  const parts = identity.split('::');
  if (parts.length < 2) return null;
  const exportedName = parts.pop();
  const ownerFile = parts.join('::');
  return { identity, exportedName, ownerFile };
}

function buildTypeOwnershipRow(cells, lineNumber) {
  const [nameCell, identityCell, ownerCell, fanInCell, statusCell, tagsCell] = cells;
  const id = parseIdentityCell(identityCell);
  if (!id) return null;
  return {
    identity: id.identity,
    exportedName: id.exportedName,
    ownerFile: id.ownerFile,
    owner: stripBackticks(ownerCell),
    fanIn: parseFanInCell(fanInCell),
    label: stripBackticks(statusCell).split(/\s+/)[0] ?? '',
    tags: tagsCell,
    name: stripBackticks(nameCell),
    line: lineNumber,
  };
}

function buildHelperRegistryRow(cells, lineNumber) {
  const [nameCell, identityCell, ownerCell, signatureCell, fanInCell, statusCell, tagsCell, anySignalCell] = cells;
  const id = parseIdentityCell(identityCell);
  if (!id) return null;
  return {
    identity: id.identity,
    exportedName: id.exportedName,
    ownerFile: id.ownerFile,
    owner: stripBackticks(ownerCell),
    signature: signatureCell.trim(),
    fanIn: parseFanInCell(fanInCell),
    label: stripBackticks(statusCell).split(/\s+/)[0] ?? '',
    tags: tagsCell,
    anyUnknownSignal: anySignalCell.trim(),
    name: stripBackticks(nameCell),
    line: lineNumber,
  };
}

export function parseTypeOwnershipCanonText({ text, canonLabelSet }) {
  return parseCanonMarkdown({
    text,
    expectedColumns: TYPE_OWNERSHIP_COLUMNS,
    expectedColumnSet: TYPE_OWNERSHIP_COLUMN_SET,
    canonLabelSet,
    buildRecord: buildTypeOwnershipRow,
    schemaTag: 'type-ownership',
  });
}

export function parseHelperRegistryCanonText({ text, canonLabelSet }) {
  return parseCanonMarkdown({
    text,
    expectedColumns: HELPER_REGISTRY_COLUMNS,
    expectedColumnSet: HELPER_REGISTRY_COLUMN_SET,
    canonLabelSet,
    buildRecord: buildHelperRegistryRow,
    schemaTag: 'helper-registry',
  });
}

export function makeDriftRecord({ kind, category, identity, canon, fresh, confidence = 'high' }) {
  const family = CATEGORY_TO_FAMILY[`${kind}::${category}`];
  if (!family) {
    throw new Error(`makeDriftRecord: unknown (kind, category) pair: ${kind} / ${category}`);
  }
  const rec = { kind, category, family, identity, confidence };
  if (canon !== undefined) rec.canon = canon;
  if (fresh !== undefined) rec.fresh = fresh;
  return rec;
}

export function buildCanonDriftJsonObject({ meta, perSource, drifts }) {
  const perSourceEntries = Object.values(perSource ?? {});
  const sourcesRequested = perSourceEntries.length;
  const sourcesSkipped = perSourceEntries.filter((e) =>
    e?.status === 'skipped-missing-canon' ||
    e?.status === 'skipped-unrecognized-schema').length;
  const sourcesChecked = sourcesRequested - sourcesSkipped;
  const driftCount = (drifts ?? []).length;
  return {
    meta: meta ?? {},
    summary: {
      sourcesRequested,
      sourcesChecked,
      sourcesSkipped,
      driftCount,
    },
    perSource: perSource ?? {},
    drifts: drifts ?? [],
  };
}
