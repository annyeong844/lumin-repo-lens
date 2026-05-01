// Type-escape extractor for P2-0.
//
// Fresh AST pass that emits one `type-escape` fact per occurrence per
// `canonical/fact-model.md §3.9` (post-amendment: `occurrenceKey` +
// `normalizedCodeShape`). Covers all 11 escapeKinds with specific-wins
// precedence so a single AST site never emits two facts.
//
// Canonical anchors:
//   - canonical/fact-model.md §3.9 — authoritative shape + enum +
//     precedence rules (amended by P2-0 on 2026-04-20).
//   - canonical/any-contamination.md §10 — producer responsibilities.
//   - maintainer history notes §4.0 (precedence), §4.1 (shape), §5.3 (this module).

import { createHash } from 'node:crypto';
import { parseOxcOrThrow } from './parse-oxc.mjs';
import { computeLineStarts, lineOf } from './line-offset.mjs';

// ── Utilities ──────────────────────────────────────────────

function sourceSlice(src, node) {
  if (!node || typeof node.start !== 'number' || typeof node.end !== 'number') return '';
  return src.slice(node.start, node.end);
}

// Token-aware normalization: collapse whitespace runs outside string /
// template / comment ranges. Preserves whitespace INSIDE string literals.
// Drops trailing `;`. Does NOT attempt a full tokenizer — for the short
// source slices used as `codeShape`, a minimal state machine suffices.
export function normalizeCodeShape(raw) {
  if (!raw) return '';
  const out = [];
  let state = 'code';
  let prevSpace = false;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    const next = raw[i + 1];

    if (state === 'single') {
      out.push(c);
      if (c === '\\' && i + 1 < raw.length) { out.push(next); i += 2; continue; }
      if (c === "'") state = 'code';
      i++;
      continue;
    }
    if (state === 'double') {
      out.push(c);
      if (c === '\\' && i + 1 < raw.length) { out.push(next); i += 2; continue; }
      if (c === '"') state = 'code';
      i++;
      continue;
    }
    if (state === 'template') {
      out.push(c);
      if (c === '\\' && i + 1 < raw.length) { out.push(next); i += 2; continue; }
      if (c === '`') state = 'code';
      i++;
      continue;
    }
    if (state === 'line-comment') {
      out.push(c);
      if (c === '\n') state = 'code';
      i++;
      continue;
    }
    if (state === 'block-comment') {
      out.push(c);
      if (c === '*' && next === '/') { out.push(next); state = 'code'; i += 2; continue; }
      i++;
      continue;
    }

    // state === 'code'
    if (c === "'") { state = 'single'; out.push(c); prevSpace = false; i++; continue; }
    if (c === '"') { state = 'double'; out.push(c); prevSpace = false; i++; continue; }
    if (c === '`') { state = 'template'; out.push(c); prevSpace = false; i++; continue; }
    if (c === '/' && next === '/') { state = 'line-comment'; out.push(c, next); prevSpace = false; i += 2; continue; }
    if (c === '/' && next === '*') { state = 'block-comment'; out.push(c, next); prevSpace = false; i += 2; continue; }

    // Whitespace collapse in code state.
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (!prevSpace) {
        out.push(' ');
        prevSpace = true;
      }
      i++;
      continue;
    }

    out.push(c);
    prevSpace = false;
    i++;
  }

  let normalized = out.join('').trim();
  if (normalized.endsWith(';')) normalized = normalized.slice(0, -1).trimEnd();
  return normalized;
}

function occurrenceKey(file, escapeKind, normalizedCodeShape, insideExportedIdentity) {
  const input =
    file + '|' + escapeKind + '|' + normalizedCodeShape + '|' +
    (insideExportedIdentity ?? '<top-level>');
  return 'sha256:' + createHash('sha256').update(input).digest('hex');
}

// ── AST walking with parent stack ──────────────────────────

function walkWithAncestors(node, ancestors, visit) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  visit(node, ancestors);
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' ||
        key === 'loc' || key === 'range' || key === 'parent') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walkWithAncestors(c, ancestors, visit);
    } else if (child && typeof child === 'object' && typeof child.type === 'string') {
      walkWithAncestors(child, ancestors, visit);
    }
  }
  ancestors.pop();
}

// ── Export alias map ───────────────────────────────────────
//
// For `function foo() {} export { foo as bar }`, the extractor must
// resolve `foo`'s enclosing identity to `bar`. Scan the whole program
// for ExportNamedDeclaration without a `declaration` field (specifier-
// only exports) and build a localName → exportedName map.

function buildExportAliasMap(program) {
  const map = new Map();
  if (!program || !Array.isArray(program.body)) return map;
  for (const stmt of program.body) {
    if (stmt?.type === 'ExportNamedDeclaration' && !stmt.declaration && Array.isArray(stmt.specifiers)) {
      for (const spec of stmt.specifiers) {
        if (spec?.type === 'ExportSpecifier') {
          const localName = spec.local?.name;
          const exportedName = spec.exported?.name;
          if (localName && exportedName) map.set(localName, exportedName);
        }
      }
    }
  }
  return map;
}

// ── insideExportedIdentity resolution ──────────────────────
//
// Walks outward from the occurrence's ancestor stack (innermost first)
// looking for an enclosing EXPORTED binding. Rules per maintainer history notes §4.1.

function resolveInsideExportedIdentity(ancestors, file, exportAliasMap) {
  // Walk from innermost to outermost.
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    const parent = ancestors[i - 1];
    const grand = ancestors[i - 2];

    // export function foo() / export class Foo / export default named function
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id?.name) {
      // Parent is ExportNamedDeclaration?
      if (parent?.type === 'ExportNamedDeclaration') {
        return `${file}::${node.id.name}`;
      }
      // Parent is ExportDefaultDeclaration?
      if (parent?.type === 'ExportDefaultDeclaration') {
        return `${file}::default`;
      }
      // Alias-exported elsewhere via `export { foo as bar }`?
      const exportedName = exportAliasMap.get(node.id.name);
      if (exportedName) {
        return `${file}::${exportedName}`;
      }
    }

    // export interface Foo / export type Foo / export enum Foo /
    // export namespace Foo. Type-owner contamination needs the same
    // identity key as helper-owner facts.
    if (isTypeDeclarationNode(node) && node.id?.name) {
      if (parent?.type === 'ExportNamedDeclaration') {
        return `${file}::${node.id.name}`;
      }
      const exportedName = exportAliasMap.get(node.id.name);
      if (exportedName) {
        return `${file}::${exportedName}`;
      }
    }

    // export default anonymous function/arrow/class
    if (
      (node.type === 'FunctionExpression' ||
       node.type === 'ArrowFunctionExpression' ||
       node.type === 'ClassExpression') &&
      parent?.type === 'ExportDefaultDeclaration'
    ) {
      return `${file}::default`;
    }

    // export const foo = () => ... | function expr | class expr
    // Occurrence is inside an arrow / function / class expression, which
    // sits inside a VariableDeclarator that's inside VariableDeclaration
    // inside ExportNamedDeclaration.
    if (node.type === 'VariableDeclarator' && node.id?.name) {
      if (parent?.type === 'VariableDeclaration' && grand?.type === 'ExportNamedDeclaration') {
        return `${file}::${node.id.name}`;
      }
      // Alias-exported?
      const exportedName = exportAliasMap.get(node.id.name);
      if (exportedName) {
        return `${file}::${exportedName}`;
      }
    }
  }
  return null;
}

function isTypeDeclarationNode(node) {
  return node?.type === 'TSInterfaceDeclaration' ||
    node?.type === 'TSTypeAliasDeclaration' ||
    node?.type === 'TSEnumDeclaration' ||
    node?.type === 'TSModuleDeclaration';
}

// ── Escape detection per kind ──────────────────────────────

// Returns true if `node` is a TSAnyKeyword.
function isAnyKw(node) {
  return node?.type === 'TSAnyKeyword';
}

// Returns true if `node` is a TSUnknownKeyword.
function isUnknownKw(node) {
  return node?.type === 'TSUnknownKeyword';
}

// Walk a type annotation subtree looking for a direct TSAnyKeyword.
// Used to flag rest-any-args / index-sig-any / generic-default-any
// and to mark those any-keywords as "consumed" so they don't
// double-emit as explicit-any.
function collectAnyKwStarts(typeNode, out) {
  if (!typeNode || typeof typeNode !== 'object') return;
  if (isAnyKw(typeNode)) {
    out.add(typeNode.start);
    return;
  }
  for (const key of Object.keys(typeNode)) {
    if (key === 'type' || key === 'start' || key === 'end' ||
        key === 'loc' || key === 'range' || key === 'parent') continue;
    const child = typeNode[key];
    if (Array.isArray(child)) {
      for (const c of child) collectAnyKwStarts(c, out);
    } else if (child && typeof child === 'object') {
      collectAnyKwStarts(child, out);
    }
  }
}

// ── AST-kind walker ────────────────────────────────────────
//
// First pass: specific kinds (rest-any-args, index-sig-any,
// generic-default-any, angle-any, as-unknown-as-T, as-any). Each
// consumes the TSAnyKeyword nodes inside its match so the second pass
// does not double-emit them as explicit-any.

function detectAstEscapes(program, makeFact) {
  const facts = [];
  const consumedAnyStarts = new Set();
  const consumedAsExprStarts = new Set();

  walkWithAncestors(program, [], (node, anc) => {
    if (node.type === 'RestElement' && node.typeAnnotation) {
      const anyStarts = new Set();
      collectAnyKwStarts(node.typeAnnotation, anyStarts);
      if (anyStarts.size > 0) {
        for (const s of anyStarts) consumedAnyStarts.add(s);
        facts.push(makeFact(node, 'rest-any-args', anc));
      }
      return;
    }
    if (node.type === 'TSIndexSignature' && node.typeAnnotation) {
      const anyStarts = new Set();
      collectAnyKwStarts(node.typeAnnotation, anyStarts);
      if (anyStarts.size > 0) {
        for (const s of anyStarts) consumedAnyStarts.add(s);
        facts.push(makeFact(node, 'index-sig-any', anc));
      }
      return;
    }
    if (node.type === 'TSTypeParameter' && node.default && isAnyKw(node.default)) {
      consumedAnyStarts.add(node.default.start);
      facts.push(makeFact(node, 'generic-default-any', anc));
      return;
    }
    if (node.type === 'TSTypeAssertion' && isAnyKw(node.typeAnnotation)) {
      consumedAnyStarts.add(node.typeAnnotation.start);
      facts.push(makeFact(node, 'angle-any', anc));
      return;
    }
    // as-unknown-as-T wins over as-any even when outer is `as any`.
    if (
      node.type === 'TSAsExpression' &&
      node.expression?.type === 'TSAsExpression' &&
      isUnknownKw(node.expression.typeAnnotation)
    ) {
      consumedAsExprStarts.add(node.start);
      consumedAsExprStarts.add(node.expression.start);
      if (isAnyKw(node.typeAnnotation)) consumedAnyStarts.add(node.typeAnnotation.start);
      facts.push(makeFact(node, 'as-unknown-as-T', anc));
      return;
    }
    if (
      node.type === 'TSAsExpression' &&
      isAnyKw(node.typeAnnotation) &&
      !consumedAsExprStarts.has(node.start)
    ) {
      consumedAnyStarts.add(node.typeAnnotation.start);
      facts.push(makeFact(node, 'as-any', anc));
    }
  });

  // Second pass: every TSAnyKeyword not consumed by a specific kind.
  walkWithAncestors(program, [], (node, anc) => {
    if (!isAnyKw(node)) return;
    if (consumedAnyStarts.has(node.start)) return;
    facts.push(makeFact(node, 'explicit-any', anc));
  });

  return facts;
}

// ── Comment-based walker ───────────────────────────────────
//
// Directives must appear as the FIRST token of the comment body. Prose
// that mentions `@ts-ignore` inside a long module-header sentence is
// NOT a directive; it's documentation. The `^\s*` anchor eliminates
// that false-positive class (P2-0 dogfood discovery in
// measure-discipline.mjs's header).

const TS_IGNORE_RE = /^\s*@ts-ignore\b/;
const TS_EXPECT_ERROR_RE = /^\s*@ts-expect-error\b/;
const NO_EXPLICIT_ANY_RE = /^\s*eslint-disable(?:-next-line|-line)?\b[^\n]*\b(?:@typescript-eslint\/)?no-explicit-any\b/;
const JSDOC_ANY_RE = /(?:^|\n)\s*\*?\s*@(type|param|returns?|typedef|property)\s*\{\s*any\s*\}/;

function commentFact(filePath, cmt, lineStarts) {
  const value = cmt.value ?? '';
  const isLine = cmt.type === 'Line';
  const codeShape = isLine ? `//${value}` : `/*${value}*/`;
  const line = lineOf(lineStarts, cmt.start ?? 0);
  const normalizedCodeShape = normalizeCodeShape(codeShape);
  let escapeKind = null;
  if (TS_IGNORE_RE.test(value)) escapeKind = 'ts-ignore';
  else if (TS_EXPECT_ERROR_RE.test(value)) escapeKind = 'ts-expect-error';
  else if (NO_EXPLICIT_ANY_RE.test(value)) escapeKind = 'no-explicit-any-disable';
  else if (!isLine && JSDOC_ANY_RE.test(value)) escapeKind = 'jsdoc-any';
  if (!escapeKind) return null;
  return {
    file: filePath,
    line,
    escapeKind,
    codeShape,
    normalizedCodeShape,
    insideExportedIdentity: null,
    occurrenceKey: occurrenceKey(filePath, escapeKind, normalizedCodeShape, null),
  };
}

function detectCommentEscapes(comments, filePath, lineStarts) {
  const facts = [];
  for (const cmt of comments) {
    const f = commentFact(filePath, cmt, lineStarts);
    if (f) facts.push(f);
  }
  return facts;
}

// ── Main extractor ─────────────────────────────────────────

/**
 * @param {string} src       TS/TSX/JS/JSX source text
 * @param {string} filePath  file path (used for the `file` field and
 *                            occurrenceKey; normalize to forward-slash
 *                            before calling for cross-platform keys)
 * @returns {{
 *   typeEscapes?: Array<object>,
 *   parseError?: string,
 * }}
 */
export function extractTypeEscapes(src, filePath) {
  let parsed;
  try { parsed = parseOxcOrThrow(filePath, src); }
  catch (e) {
    return { parseError: e.message };
  }

  const program = parsed.program;
  const lineStarts = computeLineStarts(src);
  const exportAliasMap = buildExportAliasMap(program);

  const makeFact = (node, escapeKind, ancestors) => ({
    file: filePath,
    line: lineOf(lineStarts, node.start ?? 0),
    escapeKind,
    codeShape: sourceSlice(src, node),
    normalizedCodeShape: normalizeCodeShape(sourceSlice(src, node)),
    insideExportedIdentity: resolveInsideExportedIdentity(ancestors, filePath, exportAliasMap),
    get occurrenceKey() {
      return occurrenceKey(filePath, this.escapeKind, this.normalizedCodeShape, this.insideExportedIdentity);
    },
  });

  // `makeFact` returns a getter for occurrenceKey; materialize to plain
  // strings before sorting so JSON.stringify emits concrete values.
  function materialize(f) {
    return {
      file: f.file, line: f.line, escapeKind: f.escapeKind,
      codeShape: f.codeShape, normalizedCodeShape: f.normalizedCodeShape,
      insideExportedIdentity: f.insideExportedIdentity,
      occurrenceKey: f.occurrenceKey,
    };
  }

  const astFacts = detectAstEscapes(program, makeFact).map(materialize);
  const commentFacts = detectCommentEscapes(parsed.comments ?? [], filePath, lineStarts);
  const facts = [...astFacts, ...commentFacts];

  facts.sort((a, b) => (a.line - b.line) || a.occurrenceKey.localeCompare(b.occurrenceKey));

  return { typeEscapes: facts };
}
