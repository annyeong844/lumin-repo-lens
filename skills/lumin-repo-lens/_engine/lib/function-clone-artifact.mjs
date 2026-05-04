// _lib/function-clone-artifact.mjs - deterministic function clone cues.
//
// This artifact intentionally does NOT claim semantic equivalence. It
// fingerprints top-level exported functions/helpers and surfaces exact body
// or same-structure groups for the model to inspect with source file:line
// evidence.

import { createHash } from 'node:crypto';
import path from 'node:path';

import { parseOxcOrThrow } from './parse-oxc.mjs';
import { computeLineStarts, lineOf } from './line-offset.mjs';
import { detectGeneratedFileEvidence } from './shape-hash.mjs';

const FUNCTION_CLONE_SCHEMA_VERSION = 'function-clones.v2';
const FUNCTION_CLONE_NORMALIZED_VERSION = 'function-body.normalized.v1';

const SKIP_KEYS = new Set([
  'start',
  'end',
  'loc',
  'range',
  'parent',
  'typeAnnotation',
  'returnType',
  'typeParameters',
  'declare',
  'accessibility',
  'shorthand',
]);

function toRel(root, abs) {
  return path.relative(root, abs).replace(/\\/g, '/');
}

function sourceSlice(src, node) {
  if (!node || typeof node.start !== 'number' || typeof node.end !== 'number') return '';
  return src.slice(node.start, node.end);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
  return out;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function hash(value) {
  return 'sha256:' + createHash('sha256').update(stableJson(value)).digest('hex');
}

function compactSource(src) {
  return String(src ?? '').replace(/\s+/g, ' ').trim();
}

function exactBodyHash(src) {
  return 'sha256:' + createHash('sha256').update(compactSource(src)).digest('hex');
}

function isFunctionLike(node) {
  return node?.type === 'FunctionDeclaration' ||
    node?.type === 'FunctionExpression' ||
    node?.type === 'ArrowFunctionExpression';
}

function isFunctionishVariableDeclarator(declarator) {
  return declarator?.id?.type === 'Identifier' && isFunctionLike(declarator.init);
}

function exportedAliases(program) {
  const aliases = new Map();
  function add(localName, exportedName) {
    if (!localName || !exportedName) return;
    if (!aliases.has(localName)) aliases.set(localName, new Set());
    aliases.get(localName).add(exportedName);
  }

  for (const stmt of program?.body ?? []) {
    if (stmt?.type !== 'ExportNamedDeclaration' || stmt.source || stmt.declaration) continue;
    for (const spec of stmt.specifiers ?? []) {
      if (spec?.type !== 'ExportSpecifier') continue;
      add(spec.local?.name, spec.exported?.name ?? spec.local?.name);
    }
  }
  return aliases;
}

function topLevelExportedFunctions(program) {
  const out = [];
  const aliases = exportedAliases(program);

  function addEntry({ fn, localName, exportedName, declarationKind }) {
    if (!fn || !exportedName) return;
    out.push({ fn, localName: localName ?? exportedName, exportedName, declarationKind });
  }

  for (const stmt of program?.body ?? []) {
    if (stmt?.type === 'ExportNamedDeclaration' && stmt.declaration) {
      const d = stmt.declaration;
      if (d.type === 'FunctionDeclaration') {
        addEntry({
          fn: d,
          localName: d.id?.name,
          exportedName: d.id?.name,
          declarationKind: d.type,
        });
        continue;
      }
      if (d.type === 'VariableDeclaration') {
        for (const decl of d.declarations ?? []) {
          if (!isFunctionishVariableDeclarator(decl)) continue;
          addEntry({
            fn: decl.init,
            localName: decl.id.name,
            exportedName: decl.id.name,
            declarationKind: d.kind ?? 'VariableDeclaration',
          });
        }
        continue;
      }
    }

    if (stmt?.type === 'ExportDefaultDeclaration' && isFunctionLike(stmt.declaration)) {
      addEntry({
        fn: stmt.declaration,
        localName: stmt.declaration.id?.name ?? 'default',
        exportedName: 'default',
        declarationKind: stmt.declaration.type,
      });
      continue;
    }

    if (stmt?.type === 'FunctionDeclaration') {
      const localName = stmt.id?.name;
      const exportedNames = aliases.get(localName);
      if (!exportedNames) continue;
      for (const exportedName of exportedNames) {
        addEntry({ fn: stmt, localName, exportedName, declarationKind: stmt.type });
      }
      continue;
    }

    if (stmt?.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations ?? []) {
        if (!isFunctionishVariableDeclarator(decl)) continue;
        const exportedNames = aliases.get(decl.id.name);
        if (!exportedNames) continue;
        for (const exportedName of exportedNames) {
          addEntry({
            fn: decl.init,
            localName: decl.id.name,
            exportedName,
            declarationKind: stmt.kind ?? 'VariableDeclaration',
          });
        }
      }
    }
  }

  return out;
}

function shouldPreserveIdentifier(node, parent, key) {
  if (!node?.name) return false;
  if (parent?.type === 'MemberExpression' && key === 'property' && parent.computed !== true) return true;
  if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition' ||
       parent?.type === 'PropertyDefinition' || parent?.type === 'AccessorProperty') &&
      key === 'key' && parent.computed !== true) return true;
  return false;
}

function normalizeLiteral(node, { preserveLiteralValues }) {
  const value = node?.value;
  if (preserveLiteralValues) {
    return {
      type: node.type,
      kind: value === null ? 'null' : typeof value,
      value: typeof value === 'bigint' ? value.toString() : value,
      regex: node.regex ?? undefined,
    };
  }
  return {
    type: node.type,
    kind: value === null ? 'null' : typeof value,
    regex: node.regex ? 'regex' : undefined,
  };
}

function normalizeTemplateElement(node, { preserveLiteralValues }) {
  if (preserveLiteralValues) {
    return {
      type: node.type,
      value: node.value?.raw ?? node.value?.cooked ?? '',
      tail: node.tail === true,
    };
  }
  return {
    type: node.type,
    kind: 'template-part',
    tail: node.tail === true,
  };
}

function normalizeNode(node, options = {}, parent = null, key = null) {
  if (Array.isArray(node)) return node.map((entry) => normalizeNode(entry, options, parent, key));
  if (!node || typeof node !== 'object') return node;

  if (node.type === 'Identifier') {
    return {
      type: 'Identifier',
      name: shouldPreserveIdentifier(node, parent, key) ? node.name : '$ID',
    };
  }
  if (node.type === 'PrivateIdentifier') return { type: 'PrivateIdentifier', name: '#ID' };
  if (node.type === 'ThisExpression') return { type: 'ThisExpression' };
  if (node.type === 'Super') return { type: 'Super' };
  if (node.type === 'Literal') return normalizeLiteral(node, options);
  if (node.type === 'TemplateElement') return normalizeTemplateElement(node, options);

  const out = { type: node.type };
  for (const k of Object.keys(node).sort()) {
    if (k === 'type' || SKIP_KEYS.has(k)) continue;
    const value = node[k];
    if (typeof value === 'function' || value === undefined) continue;
    out[k] = normalizeNode(value, options, node, k);
  }
  return out;
}

function functionBodyNode(fn) {
  return fn?.body ?? null;
}

function bodyStatementCount(fn) {
  const body = functionBodyNode(fn);
  if (!body) return 0;
  if (Array.isArray(body.body)) return body.body.length;
  return 1;
}

function collectCallTokens(body) {
  const tokens = new Set();

  function calleeName(callee) {
    if (callee?.type === 'Identifier') return callee.name;
    if (callee?.type === 'MemberExpression') {
      const prop = callee.property;
      if (!callee.computed && prop?.type === 'Identifier') return prop.name;
      if (prop?.type === 'Literal') return String(prop.value);
    }
    if (callee?.type === 'ChainExpression') return calleeName(callee.expression);
    if (callee?.type === 'NewExpression') return calleeName(callee.callee);
    return null;
  }

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const name = calleeName(node.callee);
      if (name) tokens.add(name);
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || SKIP_KEYS.has(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c === 'object') walk(c);
      } else if (v && typeof v === 'object') {
        walk(v);
      }
    }
  }

  walk(body);
  return [...tokens].sort();
}

function buildFunctionFact({ entry, src, ownerFile, lineStarts, scope }) {
  const { fn, exportedName, localName, declarationKind } = entry;
  const body = functionBodyNode(fn);
  if (!body) return null;

  const startLine = lineOf(lineStarts, fn.start ?? 0);
  const endLine = lineOf(lineStarts, fn.end ?? 0);
  const bodyStartLine = lineOf(lineStarts, body.start ?? fn.start ?? 0);
  const bodyEndLine = lineOf(lineStarts, body.end ?? fn.end ?? 0);
  const identity = `${ownerFile}::${exportedName}`;
  const bodySource = sourceSlice(src, body);
  const normalizedExact = normalizeNode(body, { preserveLiteralValues: true });
  const normalizedStructure = normalizeNode(body, { preserveLiteralValues: false });
  const generatedFile = detectGeneratedFileEvidence(ownerFile, src);

  return {
    kind: 'function-body-fingerprint',
    identity,
    exportedName,
    localName,
    ownerFile,
    line: startLine,
    endLine,
    bodyLineStart: bodyStartLine,
    bodyLineEnd: bodyEndLine,
    bodyLoc: Math.max(1, bodyEndLine - bodyStartLine + 1),
    declarationKind,
    functionKind: fn.type,
    async: fn.async === true,
    generator: fn.generator === true,
    paramCount: Array.isArray(fn.params) ? fn.params.length : 0,
    statementCount: bodyStatementCount(fn),
    exactBodyHash: exactBodyHash(bodySource),
    normalizedExactHash: hash(normalizedExact),
    normalizedStructureHash: hash(normalizedStructure),
    callTokens: collectCallTokens(body),
    source: 'fresh-ast-pass',
    scope,
    confidence: 'high',
    ...(generatedFile ? { generatedFile } : {}),
  };
}

function readErrorDiagnostic(file, message) {
  return {
    kind: 'function-clone-diagnostic',
    code: 'read-error',
    severity: 'error',
    file,
    message,
  };
}

function parseErrorDiagnostic(file, message) {
  return {
    kind: 'function-clone-diagnostic',
    code: 'parse-error',
    severity: 'error',
    file,
    message,
  };
}

export function functionCloneReadErrorPayload(relFile, message) {
  return {
    facts: [],
    diagnostics: [readErrorDiagnostic(relFile, `read failed: ${message}`)],
    filesWithParseErrors: [],
    filesWithReadErrors: [{ file: relFile, message }],
  };
}

export function extractFunctionCloneFilePayload({ src, relFile, scope }) {
  let parsed;
  try {
    parsed = parseOxcOrThrow(relFile, src);
  } catch (e) {
    return {
      facts: [],
      diagnostics: [parseErrorDiagnostic(relFile, e.message)],
      filesWithParseErrors: [{ file: relFile, message: e.message }],
      filesWithReadErrors: [],
    };
  }

  const lineStarts = computeLineStarts(src);
  const facts = [];
  for (const entry of topLevelExportedFunctions(parsed.program)) {
    const fact = buildFunctionFact({
      entry,
      src,
      ownerFile: relFile,
      lineStarts,
      scope,
    });
    if (fact) facts.push(fact);
  }

  return {
    facts,
    diagnostics: [],
    filesWithParseErrors: [],
    filesWithReadErrors: [],
  };
}

function groupFacts(facts, key, { minSize = 2, minBodyLoc = 3 } = {}) {
  const byHash = new Map();
  for (const fact of facts) {
    if (!fact?.[key]) continue;
    if ((fact.bodyLoc ?? 0) < minBodyLoc || (fact.statementCount ?? 0) < 2) continue;
    if (!byHash.has(fact[key])) byHash.set(fact[key], []);
    byHash.get(fact[key]).push(fact);
  }

  const groups = [];
  for (const [groupHash, members] of byHash) {
    if (members.length < minSize) continue;
    const sorted = members
      .slice()
      .sort((a, b) => a.identity.localeCompare(b.identity));
    const generatedOnly = sorted.every((m) => !!m.generatedFile);
    const exactHashCount = new Set(sorted.map((m) => m.normalizedExactHash)).size;
    const callTokenSets = sorted.map((m) => new Set(m.callTokens ?? []));
    const sharedCallTokens = callTokenSets.length === 0
      ? []
      : [...callTokenSets[0]].filter((token) => callTokenSets.every((set) => set.has(token))).sort();
    groups.push({
      hash: groupHash,
      size: sorted.length,
      generatedOnly,
      exactHashCount,
      identities: sorted.map((m) => m.identity),
      ownerFiles: [...new Set(sorted.map((m) => m.ownerFile))].sort(),
      exportedNames: [...new Set(sorted.map((m) => m.exportedName))].sort(),
      lines: sorted.map((m) => ({ identity: m.identity, file: m.ownerFile, line: m.line })),
      bodyLocRange: [
        Math.min(...sorted.map((m) => m.bodyLoc ?? 0)),
        Math.max(...sorted.map((m) => m.bodyLoc ?? 0)),
      ],
      sharedCallTokens,
      reason: key === 'normalizedExactHash'
        ? 'same normalized function body; verify domain ownership before merging'
        : 'same anonymized function-body structure; review cue only, not proof of semantic equivalence',
    });
  }

  groups.sort((a, b) =>
    (b.generatedOnly ? 0 : 1) - (a.generatedOnly ? 0 : 1) ||
    b.size - a.size ||
    b.bodyLocRange[1] - a.bodyLocRange[1] ||
    a.identities.join('|').localeCompare(b.identities.join('|')));
  return groups;
}

const GENERIC_CALL_TOKENS = new Set([
  'apply',
  'bind',
  'call',
  'catch',
  'filter',
  'find',
  'forEach',
  'format',
  'includes',
  'join',
  'map',
  'push',
  'reduce',
  'slice',
  'split',
  'then',
  'toString',
  'trim',
]);

function roundScore(n) {
  return Math.round(n * 1000) / 1000;
}

function jaccard(a, b) {
  const aa = new Set(a ?? []);
  const bb = new Set(b ?? []);
  const union = new Set([...aa, ...bb]);
  if (union.size === 0) return 0;
  let shared = 0;
  for (const token of aa) if (bb.has(token)) shared++;
  return shared / union.size;
}

function rangeSimilarity(a, b) {
  const aa = Number(a ?? 0);
  const bb = Number(b ?? 0);
  const max = Math.max(aa, bb);
  if (max <= 0) return 0;
  return 1 - (Math.abs(aa - bb) / max);
}

function nameTokens(name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2);
}

function significantCallTokens(fact) {
  return [...new Set(fact.callTokens ?? [])]
    .filter((token) => {
      const raw = String(token ?? '');
      return raw.length >= 4 && !GENERIC_CALL_TOKENS.has(raw);
    })
    .sort();
}

function groupedIdentitySet(...groupsLists) {
  const out = new Set();
  for (const groups of groupsLists) {
    for (const group of groups ?? []) {
      for (const identity of group.identities ?? []) out.add(identity);
    }
  }
  return out;
}

function buildNearFunctionCandidates(facts, exactBodyGroups, structureGroups) {
  const grouped = groupedIdentitySet(exactBodyGroups, structureGroups);
  const eligible = facts
    .filter((fact) => !grouped.has(fact.identity))
    .filter((fact) => significantCallTokens(fact).length > 0)
    .filter((fact) => fact.generator !== true)
    .sort((a, b) => a.identity.localeCompare(b.identity));

  const byCallToken = new Map();
  for (const fact of eligible) {
    for (const token of significantCallTokens(fact)) {
      if (!byCallToken.has(token)) byCallToken.set(token, []);
      byCallToken.get(token).push(fact);
    }
  }

  const pairKeys = new Set();
  const candidates = [];
  for (const token of [...byCallToken.keys()].sort()) {
    const bucket = byCallToken.get(token).slice().sort((a, b) => a.identity.localeCompare(b.identity));
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];
        const pairKey = [a.identity, b.identity].sort().join('\0');
        if (pairKeys.has(pairKey)) continue;
        pairKeys.add(pairKey);
        if (a.async !== b.async) continue;
        if (Math.abs((a.paramCount ?? 0) - (b.paramCount ?? 0)) > 1) continue;

        const aCalls = significantCallTokens(a);
        const bCalls = significantCallTokens(b);
        const sharedCallTokens = aCalls.filter((entry) => bCalls.includes(entry)).sort();
        if (sharedCallTokens.length === 0) continue;

        const callTokenJaccard = jaccard(aCalls, bCalls);
        const aNameTokens = nameTokens(a.exportedName);
        const bNameTokens = nameTokens(b.exportedName);
        const sharedNameTokens = aNameTokens.filter((entry) => bNameTokens.includes(entry)).sort();
        const nameTokenJaccard = jaccard(aNameTokens, bNameTokens);
        const bodyLocSimilarity = rangeSimilarity(a.bodyLoc, b.bodyLoc);
        const statementCountSimilarity = rangeSimilarity(a.statementCount, b.statementCount);
        if (bodyLocSimilarity < 0.34 || statementCountSimilarity < 0.34) continue;
        if (callTokenJaccard < 0.5 && nameTokenJaccard < 0.34) continue;

        const score = roundScore(
          (callTokenJaccard * 0.45) +
          (nameTokenJaccard * 0.25) +
          (bodyLocSimilarity * 0.15) +
          (statementCountSimilarity * 0.15)
        );
        if (score < 0.62) continue;

        const sorted = [a, b].sort((left, right) => left.identity.localeCompare(right.identity));
        const reasons = [
          `shared significant call tokens: ${sharedCallTokens.join(', ')}`,
          `body size similarity: ${roundScore(bodyLocSimilarity)}`,
          `statement-count similarity: ${roundScore(statementCountSimilarity)}`,
        ];
        if (sharedNameTokens.length > 0) {
          reasons.push(`shared exported-name tokens: ${sharedNameTokens.join(', ')}`);
        }
        candidates.push({
          kind: 'near-function-candidate',
          identities: sorted.map((m) => m.identity),
          ownerFiles: [...new Set(sorted.map((m) => m.ownerFile))].sort(),
          exportedNames: sorted.map((m) => m.exportedName).sort(),
          lines: sorted.map((m) => ({ identity: m.identity, file: m.ownerFile, line: m.line })),
          score,
          risk: 'review-only',
          generatedOnly: sorted.every((m) => !!m.generatedFile),
          sharedCallTokens,
          sharedNameTokens,
          callTokenJaccard: roundScore(callTokenJaccard),
          nameTokenJaccard: roundScore(nameTokenJaccard),
          bodyLocRange: [
            Math.min(...sorted.map((m) => m.bodyLoc ?? 0)),
            Math.max(...sorted.map((m) => m.bodyLoc ?? 0)),
          ],
          statementCountRange: [
            Math.min(...sorted.map((m) => m.statementCount ?? 0)),
            Math.max(...sorted.map((m) => m.statementCount ?? 0)),
          ],
          reasons,
          reason: 'near function cue only; source review required; not proof of semantic equivalence or an automatic merge',
        });
      }
    }
  }

  candidates.sort((a, b) =>
    (b.generatedOnly ? 0 : 1) - (a.generatedOnly ? 0 : 1) ||
    b.score - a.score ||
    a.identities.join('|').localeCompare(b.identities.join('|')));
  return candidates.slice(0, 50);
}

export function assembleFunctionCloneArtifact({
  metaBase,
  includeTests,
  exclude,
  scope,
  observedAt,
  fileCount,
  facts,
  diagnostics,
  filesWithParseErrors,
  filesWithReadErrors,
  incremental = null,
}) {
  const stampedFacts = (facts ?? []).map((fact) => ({
    ...fact,
    observedAt,
  }));

  stampedFacts.sort((a, b) => {
    if (a.ownerFile !== b.ownerFile) return a.ownerFile < b.ownerFile ? -1 : 1;
    if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0);
    const aName = a.exportedName ?? a.identity ?? '';
    const bName = b.exportedName ?? b.identity ?? '';
    return aName.localeCompare(bName);
  });
  const sortedDiagnostics = (diagnostics ?? []).slice().sort((a, b) =>
    (a.file ?? '').localeCompare(b.file ?? '') ||
    (a.code ?? '').localeCompare(b.code ?? '') ||
    String(a.line ?? '').localeCompare(String(b.line ?? '')) ||
    (a.message ?? '').localeCompare(b.message ?? ''));

  const exactBodyGroups = groupFacts(stampedFacts, 'normalizedExactHash');
  const structureGroups = groupFacts(stampedFacts, 'normalizedStructureHash');
  const nearFunctionCandidates = buildNearFunctionCandidates(
    stampedFacts,
    exactBodyGroups,
    structureGroups
  );
  const generatedFileFactCount = stampedFacts.filter((fact) => fact.generatedFile).length;

  return {
    schemaVersion: FUNCTION_CLONE_SCHEMA_VERSION,
    meta: {
      ...metaBase,
      source: 'fresh-ast-pass',
      scope,
      observedAt,
      complete: filesWithReadErrors.length === 0 && filesWithParseErrors.length === 0,
      includeTests: includeTests === true,
      exclude: exclude ?? [],
      fileCount,
      factCount: stampedFacts.length,
      generatedFileFactCount,
      exactBodyGroupCount: exactBodyGroups.filter((g) => !g.generatedOnly).length,
      structureGroupCount: structureGroups.filter((g) => !g.generatedOnly).length,
      nearFunctionCandidateCount: nearFunctionCandidates.filter((g) => !g.generatedOnly).length,
      diagnosticCount: sortedDiagnostics.length,
      filesWithParseErrors,
      filesWithReadErrors,
      ...(incremental ? { incremental } : {}),
      supports: {
        exportedTopLevelFunctions: true,
        exportedConstArrowFunctions: true,
        defaultFunctionExports: true,
        exactBodyHash: true,
        normalizedExactHash: true,
        normalizedStructureHash: true,
        normalizedVersion: FUNCTION_CLONE_NORMALIZED_VERSION,
        nearFunctionCandidates: true,
        generatedFileEvidence: true,
        semanticEquivalence: false,
      },
      caveat: 'Function clone groups and near candidates are deterministic review cues. They do not prove semantic equivalence or justify automatic merging.',
    },
    facts: stampedFacts,
    exactBodyGroups,
    structureGroups,
    nearFunctionCandidates,
    diagnostics: sortedDiagnostics,
  };
}

export function buildFunctionCloneArtifact({
  root,
  files,
  readFile,
  metaBase,
  includeTests,
  exclude,
  scope,
  observedAt,
}) {
  const aggregate = {
    facts: [],
    diagnostics: [],
    filesWithParseErrors: [],
    filesWithReadErrors: [],
  };

  function appendPayload(payload) {
    aggregate.facts.push(...(payload.facts ?? []));
    aggregate.diagnostics.push(...(payload.diagnostics ?? []));
    aggregate.filesWithParseErrors.push(...(payload.filesWithParseErrors ?? []));
    aggregate.filesWithReadErrors.push(...(payload.filesWithReadErrors ?? []));
  }

  for (const abs of files) {
    const relFile = toRel(root, abs);
    let src;
    try {
      src = readFile(abs, 'utf8');
    } catch (e) {
      appendPayload(functionCloneReadErrorPayload(relFile, e.message));
      continue;
    }

    appendPayload(extractFunctionCloneFilePayload({
      src,
      relFile,
      scope,
    }));
  }

  return assembleFunctionCloneArtifact({
    metaBase,
    includeTests,
    exclude,
    scope,
    observedAt,
    fileCount: files.length,
    ...aggregate,
  });
}
