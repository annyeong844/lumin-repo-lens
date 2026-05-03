// _lib/classify-facts-ast-counter.mjs
//
// AST-based file-internal reference counting for classify-dead-exports.
// This module owns parser-backed identifier walking; classify-facts.mjs keeps
// regex fallback counters, predicate partner checks, and public re-exports.

import { parseOxcOrThrow } from './parse-oxc.mjs';
import { computeLineStarts, lineOf } from './line-offset.mjs';
import { EVIDENCE } from './vocab.mjs';

function parseErrorResult(error) {
  return {
    count: null,
    evidence: EVIDENCE.PARSE_ERROR,
    parseError: error.message,
    typeRefs: 0,
    valueRefs: 0,
    exportedDeclarationRefs: 0,
    exportedDeclarationRefLines: [],
  };
}

function isSkipPosition(parent, key, _parentNode) {
  if (!parent) return false;
  const pt = parent.type;

  if (key === 'id' && (
    pt === 'VariableDeclarator' ||
    pt === 'FunctionDeclaration' ||
    pt === 'FunctionExpression' ||
    pt === 'ClassDeclaration' ||
    pt === 'ClassExpression' ||
    pt === 'TSInterfaceDeclaration' ||
    pt === 'TSTypeAliasDeclaration' ||
    pt === 'TSEnumDeclaration' ||
    pt === 'TSModuleDeclaration'
  )) return true;

  if (pt === 'ImportSpecifier' ||
      pt === 'ImportDefaultSpecifier' ||
      pt === 'ImportNamespaceSpecifier') return true;

  if (pt === 'ExportSpecifier') {
    if (key === 'exported' || key === 'local') return true;
  }

  if (pt === 'Property' && key === 'key' && !parent.computed) return true;
  if (pt === 'MemberExpression' && key === 'property' && !parent.computed) return true;
  if ((pt === 'MethodDefinition' || pt === 'PropertyDefinition' ||
       pt === 'AccessorProperty') && key === 'key' && !parent.computed) return true;
  if (pt === 'LabeledStatement' && key === 'label') return true;
  if ((pt === 'BreakStatement' || pt === 'ContinueStatement') && key === 'label') return true;
  if (pt === 'JSXAttribute' && key === 'name') return true;
  if (pt === 'JSXMemberExpression' && key === 'property') return true;
  if (pt === 'JSXNamespacedName' && key === 'namespace') return true;

  return false;
}

function isTypeContext(parent) {
  if (!parent) return false;
  const t = parent.type;
  return t === 'TSTypeReference' ||
         t === 'TSTypeQuery' ||
         t === 'TSExpressionWithTypeArguments' ||
         t === 'TSInterfaceHeritage';
}

function isExportedTypeSurfaceDeclaration(node) {
  return node?.type === 'ExportNamedDeclaration' &&
    node.declaration &&
    (
      node.declaration.type === 'TSInterfaceDeclaration' ||
      node.declaration.type === 'TSTypeAliasDeclaration' ||
      node.declaration.type === 'TSModuleDeclaration' ||
      node.declaration.type === 'FunctionDeclaration' ||
      node.declaration.type === 'ClassDeclaration' ||
      node.declaration.type === 'VariableDeclaration'
    );
}

function collectPatternBindings(pattern, scope) {
  if (!pattern || typeof pattern !== 'object') return;
  if (pattern.type === 'Identifier') {
    scope.add(pattern.name);
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    for (const el of (pattern.elements ?? [])) collectPatternBindings(el, scope);
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const p of (pattern.properties ?? [])) {
      if (p?.type === 'Property') collectPatternBindings(p.value, scope);
      else if (p?.type === 'RestElement') collectPatternBindings(p.argument, scope);
    }
    return;
  }
  if (pattern.type === 'RestElement') {
    collectPatternBindings(pattern.argument, scope);
    return;
  }
  if (pattern.type === 'AssignmentPattern') {
    collectPatternBindings(pattern.left, scope);
  }
}

function collectBlockBindings(stmts, scope) {
  if (!Array.isArray(stmts)) return;
  for (const stmt of stmts) {
    if (!stmt || typeof stmt !== 'object') continue;
    if (stmt.type === 'VariableDeclaration') {
      for (const decl of (stmt.declarations ?? [])) collectPatternBindings(decl.id, scope);
    } else if (stmt.type === 'FunctionDeclaration' && stmt.id?.name) {
      scope.add(stmt.id.name);
    } else if (stmt.type === 'ClassDeclaration' && stmt.id?.name) {
      scope.add(stmt.id.name);
    } else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
      collectBlockBindings([stmt.declaration], scope);
    } else if (stmt.type === 'ExportDefaultDeclaration' && stmt.declaration?.id?.name) {
      scope.add(stmt.declaration.id.name);
    }
  }
}

function scopeForFunction(node) {
  const scope = new Set();
  if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') &&
      node.id?.name) {
    scope.add(node.id.name);
  }
  for (const param of (node.params ?? [])) collectPatternBindings(param, scope);
  return scope;
}

function scopeForForLoop(node) {
  const scope = new Set();
  const initNode = node.type === 'ForStatement' ? node.init : node.left;
  if (initNode?.type === 'VariableDeclaration') {
    for (const decl of (initNode.declarations ?? [])) {
      collectPatternBindings(decl.id, scope);
    }
  }
  return scope;
}

function scopeForNode(node) {
  if (node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression') {
    return scopeForFunction(node);
  }
  if (node.type === 'BlockStatement') {
    const scope = new Set();
    collectBlockBindings(node.body ?? [], scope);
    return scope;
  }
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    const scope = new Set();
    if (node.id?.name) scope.add(node.id.name);
    return scope;
  }
  if (node.type === 'CatchClause') {
    const scope = new Set();
    if (node.param) collectPatternBindings(node.param, scope);
    return scope;
  }
  if (node.type === 'ForStatement' ||
      node.type === 'ForInStatement' ||
      node.type === 'ForOfStatement') {
    return scopeForForLoop(node);
  }
  return null;
}

function isShadowed(state, name) {
  for (let i = state.scopeStack.length - 1; i > 0; i--) {
    if (state.scopeStack[i].has(name)) return true;
  }
  return false;
}

function recordMatchingIdentifier({ state, node, parent, key, symbolName, declLine, depth }) {
  const isIdent = node.type === 'Identifier';
  const isJsxIdent = node.type === 'JSXIdentifier';
  if ((!isIdent && !isJsxIdent) || node.name !== symbolName) return false;

  const nodeLine = lineOf(state.lineStarts, node.start ?? 0);
  if (nodeLine === declLine) return true;
  if (isSkipPosition(parent, key, node)) return true;
  if (isShadowed(state, symbolName)) return true;

  state.count++;
  if (isJsxIdent) state.valueRefs++;
  else if (isTypeContext(parent)) state.typeRefs++;
  else state.valueRefs++;

  if (depth > 0) {
    state.exportedDeclarationRefs++;
    state.exportedDeclarationRefLines.push(nodeLine);
  }
  return true;
}

function isFunctionLike(node) {
  return node?.type === 'FunctionDeclaration' ||
    node?.type === 'FunctionExpression' ||
    node?.type === 'ArrowFunctionExpression';
}

function childDepthForKey({ node, key, child, nextDepth }) {
  // Exported signatures are public declaration surface, but implementation
  // bodies are not. Keep depth for params/returnType/typeAnnotation and
  // reset only the executable body.
  if (isFunctionLike(node) && key === 'body') return 0;

  // Exported variable annotations are declaration surface. Initializers are
  // implementation detail unless the initializer is itself a function, where
  // params/returnType form the exposed signature and its body is reset above.
  if (node.type === 'VariableDeclarator' && key === 'init') {
    return isFunctionLike(child) ? nextDepth : 0;
  }

  // Class field annotations are public surface. Field initializers are
  // implementation details and should not make value/type helpers look like
  // exported declaration dependencies.
  if ((node.type === 'PropertyDefinition' || node.type === 'AccessorProperty') &&
      key === 'value') {
    return 0;
  }

  return nextDepth;
}

function shouldSkipNodeKey(key) {
  return key === 'type' ||
    key === 'start' ||
    key === 'end' ||
    key === 'loc' ||
    key === 'range' ||
    key === 'parent';
}

function buildReferenceResult(state) {
  return {
    count: state.count,
    evidence: EVIDENCE.AST_REF_COUNT,
    typeRefs: state.typeRefs,
    valueRefs: state.valueRefs,
    exportedDeclarationRefs: state.exportedDeclarationRefs,
    exportedDeclarationRefLines: [...new Set(state.exportedDeclarationRefLines)]
      .sort((a, b) => a - b),
  };
}

function createBatchState(src, requests) {
  const lineStarts = computeLineStarts(src);
  const sharedScopeStack = [new Set()];
  const states = new Map();
  const statesByName = new Map();

  for (let i = 0; i < requests.length; i++) {
    const request = requests[i] ?? {};
    const symbolName = request.symbolName;
    if (typeof symbolName !== 'string' || symbolName.length === 0) {
      throw new Error('countFileReferencesAstMany: request.symbolName is required');
    }
    const key = request.key ?? symbolName;
    const state = {
      lineStarts,
      count: 0,
      typeRefs: 0,
      valueRefs: 0,
      exportedDeclarationRefs: 0,
      exportedDeclarationRefLines: [],
      scopeStack: sharedScopeStack,
      symbolName,
      declLine: Number(request.declLine ?? 0),
    };
    states.set(key, state);
    if (!statesByName.has(symbolName)) statesByName.set(symbolName, []);
    statesByName.get(symbolName).push(state);
  }

  return { states, statesByName, sharedScopeStack };
}

function recordMatchingIdentifierBatch({ statesByName, node, parent, key, depth }) {
  const isIdent = node.type === 'Identifier';
  const isJsxIdent = node.type === 'JSXIdentifier';
  if (!isIdent && !isJsxIdent) return false;

  const states = statesByName.get(node.name);
  if (!states || states.length === 0) return false;

  for (const state of states) {
    recordMatchingIdentifier({
      state,
      node,
      parent,
      key,
      symbolName: state.symbolName,
      declLine: state.declLine,
      depth,
    });
  }
  return true;
}

function walkReferenceTreeBatch(node, parent, key, depth, statesByName, sharedScopeStack) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'JSXClosingElement') return;
  if (recordMatchingIdentifierBatch({ statesByName, node, parent, key, depth })) return;

  const nextDepth = depth + (isExportedTypeSurfaceDeclaration(node) ? 1 : 0);
  const scope = scopeForNode(node);
  if (scope) sharedScopeStack.push(scope);
  for (const childKey of Object.keys(node)) {
    if (shouldSkipNodeKey(childKey)) continue;
    const child = node[childKey];
    const childDepth = childDepthForKey({ node, key: childKey, child, nextDepth });
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object' && typeof item.type === 'string') {
          walkReferenceTreeBatch(item, node, childKey, nextDepth, statesByName, sharedScopeStack);
        }
      }
    } else if (child && typeof child === 'object' && typeof child.type === 'string') {
      walkReferenceTreeBatch(child, node, childKey, childDepth, statesByName, sharedScopeStack);
    }
  }
  if (scope) sharedScopeStack.pop();
}

export function countFileReferencesAstMany(src, filePath, requests) {
  if (!Array.isArray(requests)) {
    throw new Error('countFileReferencesAstMany: requests must be an array');
  }
  const out = new Map();
  if (requests.length === 0) return out;

  let parsed;
  try {
    parsed = parseOxcOrThrow(filePath, src);
  } catch (error) {
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i] ?? {};
      const key = request.key ?? request.symbolName;
      out.set(key, parseErrorResult(error));
    }
    return out;
  }

  const { states, statesByName, sharedScopeStack } = createBatchState(src, requests);
  walkReferenceTreeBatch(parsed.program, null, null, 0, statesByName, sharedScopeStack);
  for (const [key, state] of states) out.set(key, buildReferenceResult(state));
  return out;
}

export function countFileReferencesAst(src, filePath, symbolName, declLine) {
  const result = countFileReferencesAstMany(src, filePath, [
    { key: symbolName, symbolName, declLine },
  ]).get(symbolName);
  return result ?? parseErrorResult(new Error(`missing AST count for ${symbolName}`));
}
