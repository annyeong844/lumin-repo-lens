// _lib/inline-pattern-artifact.mjs - repeated inline statement review cues.
//
// This artifact reports repeated syntax patterns only. It does not claim that
// occurrences are semantically equivalent or safe to extract.

import { createHash } from 'node:crypto';

import { computeLineStarts, lineOf } from './line-offset.mjs';
import { parseOxcOrThrow } from './parse-oxc.mjs';
import { detectGeneratedFileEvidence } from './shape-hash.mjs';
import { getThresholdPolicy, thresholdPolicySummary } from './threshold-policies.mjs';

export const INLINE_PATTERNS_SCHEMA_VERSION = 'inline-patterns.v1';
export const INLINE_PATTERN_NORMALIZER_VERSION = 'inline-statement-normalizer-v1';

const INLINE_PATTERN_POLICY = getThresholdPolicy('inline-pattern-policy');
const MIN_OCCURRENCES = INLINE_PATTERN_POLICY.thresholds.minOccurrences;
const MAX_CATCH_STATEMENTS = INLINE_PATTERN_POLICY.thresholds.maxCatchStatements;

const SKIP_KEYS = new Set(['start', 'end', 'loc', 'range', 'parent']);

function sha256(value) {
  return 'sha256:' + createHash('sha256').update(String(value)).digest('hex');
}

function stableCompare(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function propName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'PrivateIdentifier') return node.name ? `#${node.name}` : null;
  if (node?.type === 'Literal') return String(node.value);
  return null;
}

function normalizeMember(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return '<id>';
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'Super') return 'super';
  if (node.type === 'MemberExpression') {
    if (node.computed === true || node.optional === true) return null;
    const object = normalizeMember(node.object);
    const property = propName(node.property);
    if (!object || !property) return null;
    return `${object}.${property}`;
  }
  if (node.type === 'ChainExpression') return normalizeMember(node.expression);
  return null;
}

function normalizeCallStatement(statement) {
  if (statement?.type !== 'ExpressionStatement') return null;
  const expression = statement.expression;
  if (expression?.type !== 'CallExpression') return null;
  if ((expression.arguments ?? []).length > 0) return null;
  const callee = normalizeMember(expression.callee);
  if (!callee) return null;
  if (callee.startsWith('console.')) return null;
  return `${callee}();`;
}

function normalizeCatchBlock(catchClause) {
  const statements = catchClause?.body?.body ?? [];
  if (statements.length < 1 || statements.length > MAX_CATCH_STATEMENTS) return null;

  const normalized = [];
  for (const statement of statements) {
    const item = normalizeCallStatement(statement);
    if (!item) return null;
    normalized.push(item);
  }

  return `catch { ${normalized.join(' ')} }`;
}

function functionName(node, parent, parentKey) {
  if (node?.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') return parent.id.name;
  if (parent?.type === 'Property' && parent.key?.type === 'Identifier') return parent.key.name;
  if (parent?.type === 'MethodDefinition' && parent.key?.type === 'Identifier') return parent.key.name;
  if (parent?.type === 'ExportDefaultDeclaration' && parentKey === 'declaration') return 'default';
  return '<anonymous>';
}

function isFunctionLike(node) {
  return node?.type === 'FunctionDeclaration' ||
    node?.type === 'FunctionExpression' ||
    node?.type === 'ArrowFunctionExpression';
}

function collectCatchPatterns(program, { relFile, src }) {
  const lineStarts = computeLineStarts(src);
  const occurrences = [];
  const functionStack = [];

  function visit(node, parent = null, parentKey = null) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parent, parentKey);
      return;
    }

    let pushed = false;
    if (isFunctionLike(node)) {
      functionStack.push(functionName(node, parent, parentKey));
      pushed = true;
    }

    if (node.type === 'TryStatement' && node.handler) {
      const normalizedPattern = normalizeCatchBlock(node.handler);
      if (normalizedPattern) {
        occurrences.push({
          patternHash: sha256(normalizedPattern),
          kind: 'catch-block',
          normalizedPattern,
          file: relFile,
          line: lineOf(lineStarts, node.handler.start),
          endLine: lineOf(lineStarts, node.handler.end),
          enclosingFunction: functionStack[functionStack.length - 1] ?? '<top-level>',
        });
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'type' || SKIP_KEYS.has(key)) continue;
      const child = node[key];
      if (!child || typeof child !== 'object') continue;
      visit(child, node, key);
    }

    if (pushed) functionStack.pop();
  }

  visit(program);
  return occurrences;
}

export function inlinePatternReadErrorPayload(relFile, message) {
  return {
    files: [{
      file: relFile,
      patterns: [],
      diagnostics: [{
        kind: 'read-error',
        file: relFile,
        message: String(message ?? 'read error'),
      }],
    }],
  };
}

export function extractInlinePatternFilePayload({ src, relFile }) {
  const generatedFile = detectGeneratedFileEvidence(relFile, src);
  if (generatedFile) {
    return {
      files: [{
        file: relFile,
        patterns: [],
        diagnostics: [{
          kind: 'generated-file-skipped',
          file: relFile,
          generatedFile,
        }],
      }],
    };
  }

  try {
    const ast = parseOxcOrThrow(relFile, src);
    return {
      files: [{
        file: relFile,
        patterns: collectCatchPatterns(ast.program, { relFile, src }),
        diagnostics: [],
      }],
    };
  } catch (e) {
    return {
      files: [{
        file: relFile,
        patterns: [],
        diagnostics: [{
          kind: 'parse-error',
          file: relFile,
          message: String(e?.message ?? e),
        }],
      }],
    };
  }
}

function buildGroups(files) {
  const byHash = new Map();

  for (const file of files ?? []) {
    for (const pattern of file.patterns ?? []) {
      if (!byHash.has(pattern.patternHash)) {
        byHash.set(pattern.patternHash, {
          patternHash: pattern.patternHash,
          kind: pattern.kind,
          normalizedPattern: pattern.normalizedPattern,
          occurrences: [],
        });
      }
      byHash.get(pattern.patternHash).occurrences.push({
        file: pattern.file,
        line: pattern.line,
        endLine: pattern.endLine,
        enclosingFunction: pattern.enclosingFunction,
      });
    }
  }

  const groups = [];
  for (const group of byHash.values()) {
    if (group.occurrences.length < MIN_OCCURRENCES) continue;
    group.occurrences.sort((a, b) =>
      stableCompare(a.file, b.file) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.endLine ?? 0) - (b.endLine ?? 0) ||
      stableCompare(a.enclosingFunction, b.enclosingFunction)
    );
    const ownerFiles = [...new Set(group.occurrences.map((occ) => occ.file))].sort(stableCompare);
    groups.push({
      patternHash: group.patternHash,
      kind: group.kind,
      size: group.occurrences.length,
      ownerFiles,
      normalizedPattern: group.normalizedPattern,
      occurrences: group.occurrences,
      reviewReason: 'same normalized catch block; verify control-flow and ownership before extracting',
    });
  }

  groups.sort((a, b) =>
    b.size - a.size ||
    stableCompare(a.patternHash, b.patternHash) ||
    stableCompare(a.occurrences[0]?.file, b.occurrences[0]?.file) ||
    (a.occurrences[0]?.line ?? 0) - (b.occurrences[0]?.line ?? 0)
  );
  return groups;
}

export function assembleInlinePatternArtifact({
  metaBase,
  includeTests,
  exclude,
  files,
}) {
  const sortedFiles = [...(files ?? [])].sort((a, b) => stableCompare(a.file, b.file));
  const diagnostics = sortedFiles
    .flatMap((file) => file.diagnostics ?? [])
    .sort((a, b) =>
      stableCompare(a.file, b.file) ||
      stableCompare(a.kind, b.kind) ||
      stableCompare(a.message, b.message)
    );
  const groups = buildGroups(sortedFiles);

  return {
    schemaVersion: INLINE_PATTERNS_SCHEMA_VERSION,
    meta: {
      ...metaBase,
      schemaVersion: INLINE_PATTERNS_SCHEMA_VERSION,
      normalizerVersion: INLINE_PATTERN_NORMALIZER_VERSION,
      includeTests: includeTests !== false,
      exclude: [...(exclude ?? [])],
      fileCount: sortedFiles.length,
      patternOccurrenceCount: sortedFiles.reduce((sum, file) => sum + (file.patterns?.length ?? 0), 0),
      groupCount: groups.length,
      minOccurrences: MIN_OCCURRENCES,
      maxPatternStatements: MAX_CATCH_STATEMENTS,
      thresholdPolicies: thresholdPolicySummary(['inline-pattern-policy']),
      supports: {
        catchBlockPatterns: true,
        statementSequencePatterns: false,
        semanticEquivalence: false,
      },
    },
    groups,
    mutedGroups: [],
    diagnostics,
  };
}
