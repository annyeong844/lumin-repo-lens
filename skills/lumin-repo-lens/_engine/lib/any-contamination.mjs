// _lib/any-contamination.mjs
//
// Derives symbols.json per-identity anyContamination annotations from
// occurrence-level type-escape facts. The occurrence inventory remains the
// precise post-write source of truth; these annotations answer the pre-write
// question "is this exported identity safe to reuse semantically?"

import { relPath } from './paths.mjs';

const TYPE_OWNER_KINDS = new Set([
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
]);

const HELPER_OWNER_KINDS = new Set([
  'FunctionDeclaration',
  'const-var',
  'let-var',
  'var-var',
]);

const ANY_ESCAPE_KINDS = new Set([
  'explicit-any',
  'as-any',
  'angle-any',
  'as-unknown-as-T',
  'rest-any-args',
  'index-sig-any',
  'generic-default-any',
  'no-explicit-any-disable',
  'jsdoc-any',
]);

function inc(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedObjectFromMap(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function isOwnerKind(kind) {
  return TYPE_OWNER_KINDS.has(kind) || HELPER_OWNER_KINDS.has(kind);
}

function makeIdentity(file, name) {
  return `${file}::${name}`;
}

function buildDefLookups({ root, defIndex }) {
  const identityToDef = new Map();
  const defsByRelFile = new Map();

  for (const [absFile, defs] of defIndex) {
    const file = relPath(root, absFile);
    const rows = [];
    for (const [name, def] of defs) {
      if (!def || !isOwnerKind(def.kind)) continue;
      const identity = makeIdentity(file, name);
      const row = { identity, name, file, def };
      identityToDef.set(identity, row);
      rows.push(row);
    }
    rows.sort((a, b) => (a.def.line ?? 0) - (b.def.line ?? 0) || a.name.localeCompare(b.name));
    defsByRelFile.set(file, rows);
  }

  return { identityToDef, defsByRelFile };
}

function identityForEscape(fact, identityToDef, defsByRelFile) {
  if (typeof fact?.insideExportedIdentity === 'string' &&
      identityToDef.has(fact.insideExportedIdentity)) {
    return fact.insideExportedIdentity;
  }

  // JSDoc comments are detached from the AST in oxc. For the common JS
  // pattern `/** @type {any} */ export const foo = ...`, associate the
  // comment with the nearest exported owner immediately below it.
  if (fact?.escapeKind !== 'jsdoc-any') return null;
  const rows = defsByRelFile.get(fact.file) ?? [];
  const hit = rows.find((row) => {
    const defLine = row.def.line ?? 0;
    return defLine >= fact.line && defLine - fact.line <= 3;
  });
  return hit?.identity ?? null;
}

function severityRank(label) {
  if (label === 'severely-any-contaminated') return 3;
  if (label === 'any-contaminated') return 2;
  if (label === 'has-any') return 1;
  if (label === 'unknown-surface') return 0;
  return -1;
}

function highestLabel(labels) {
  return [...labels].sort((a, b) => severityRank(b) - severityRank(a))[0] ?? null;
}

function buildAnnotation(facts, kind) {
  if (!Array.isArray(facts) || facts.length === 0) return null;

  const counts = new Map();
  for (const f of facts) inc(counts, f.escapeKind);

  const anyEscapeCount = [...counts.entries()]
    .filter(([escapeKind]) => ANY_ESCAPE_KINDS.has(escapeKind))
    .reduce((sum, [, count]) => sum + count, 0);
  if (anyEscapeCount === 0) return null;

  const explicitAnyCount = counts.get('explicit-any') ?? 0;
  const asAnyCount = (counts.get('as-any') ?? 0) + (counts.get('angle-any') ?? 0);
  const launderingCount = counts.get('as-unknown-as-T') ?? 0;
  const restAnyArgsCount = counts.get('rest-any-args') ?? 0;
  const indexSignatureAnyCount = counts.get('index-sig-any') ?? 0;
  const genericDefaultAnyCount = counts.get('generic-default-any') ?? 0;
  const jsdocAnyCount = counts.get('jsdoc-any') ?? 0;
  const noExplicitAnyDisableCount = counts.get('no-explicit-any-disable') ?? 0;
  const labels = new Set(['has-any']);
  const isType = TYPE_OWNER_KINDS.has(kind);
  const isHelper = HELPER_OWNER_KINDS.has(kind);

  if (
    isType ||
    asAnyCount > 0 ||
    explicitAnyCount > 0 ||
    restAnyArgsCount > 0 ||
    launderingCount > 0 ||
    jsdocAnyCount > 0 ||
    noExplicitAnyDisableCount > 0
  ) {
    labels.add('any-contaminated');
  }

  if (
    launderingCount > 0 ||
    restAnyArgsCount > 0 ||
    asAnyCount >= 2 ||
    explicitAnyCount >= 3 ||
    indexSignatureAnyCount > 0 ||
    (isType && anyEscapeCount >= 3) ||
    (isHelper && jsdocAnyCount >= 2)
  ) {
    labels.add('severely-any-contaminated');
  }

  const sortedLabels = [...labels].sort((a, b) => severityRank(a) - severityRank(b));
  return {
    label: highestLabel(sortedLabels),
    labels: sortedLabels,
    measurements: {
      escapeCount: facts.length,
      anyEscapeCount,
      escapeKindCounts: sortedObjectFromMap(counts),
      explicitAnyCount,
      asAnyCount,
      launderingCount,
      restAnyArgsCount,
      indexSignatureAnyCount,
      genericDefaultAnyCount,
      jsdocAnyCount,
      noExplicitAnyDisableCount,
      lines: [...new Set(facts.map((f) => f.line).filter((line) => Number.isFinite(line)))].sort((a, b) => a - b),
    },
  };
}

export function buildAnyContaminationFacts({ root, defIndex, fileData }) {
  const { identityToDef, defsByRelFile } = buildDefLookups({ root, defIndex });
  const factsByIdentity = new Map();

  for (const info of fileData.values()) {
    for (const fact of info.typeEscapes ?? []) {
      const identity = identityForEscape(fact, identityToDef, defsByRelFile);
      if (!identity) continue;
      if (!factsByIdentity.has(identity)) factsByIdentity.set(identity, []);
      factsByIdentity.get(identity).push(fact);
    }
  }

  const helperOwnersByIdentity = {};
  const typeOwnersByIdentity = {};
  let annotatedIdentities = 0;

  for (const [identity, row] of identityToDef) {
    const annotation = buildAnnotation(factsByIdentity.get(identity) ?? [], row.def.kind);
    if (annotation) {
      row.def.anyContamination = annotation;
      annotatedIdentities++;
    } else {
      delete row.def.anyContamination;
    }

    const owner = {
      ownerFile: row.file,
      exportedName: row.name,
      kind: row.def.kind,
      line: row.def.line,
      anyContamination: annotation ?? null,
    };
    if (TYPE_OWNER_KINDS.has(row.def.kind)) {
      typeOwnersByIdentity[identity] = owner;
    } else if (HELPER_OWNER_KINDS.has(row.def.kind)) {
      helperOwnersByIdentity[identity] = owner;
    }
  }

  return {
    helperOwnersByIdentity,
    typeOwnersByIdentity,
    annotatedIdentities,
  };
}
