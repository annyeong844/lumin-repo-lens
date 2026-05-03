// TS/JS/JSX file extractor for the symbol graph.
//
// Given an absolute path to a source file, returns the canonical
// per-file shape {filePath, defs, uses, reExports, loc}. This is the
// shape the three language extractors (_lib/extract-ts.mjs,
// _lib/extract-py.mjs, _lib/extract-go.mjs) converge on — downstream
// build-symbol-graph code consumes the shape uniformly and never
// switches on language again.
//
// Split out from build-symbol-graph.mjs in v1.10.1. The 173-LOC
// function was the bulk of the 785-LOC mega-file; moving it here
// (a) lets the tests exercise per-language behavior in isolation and
// (b) lines up with the sibling extract-py / extract-go modules so
// build-symbol-graph only orchestrates.
//
// Nothing here is JS-specific beyond oxc's ESTree AST shape. If an
// AST node shape you need has a TS* counterpart (interfaces, type
// aliases, enums, module declarations), it's handled — see
// FP-18, FP-25, FP-31 history in docs/maintainer/false-positive-patterns-ledger.md.

import { readFileSync } from 'node:fs';
import { parseOxcOrThrow } from './parse-oxc.mjs';
import { computeLineStarts, lineOf } from './line-offset.mjs';
import { extractTypeEscapes } from './extract-ts-escapes.mjs';

function makeLineGetter(src) {
  const lineStarts = computeLineStarts(src);
  return (node) => lineOf(lineStarts, node.start ?? 0);
}

function literalImportSource(node) {
  if (node?.type !== 'ImportExpression') return null;
  const s = node.source;
  return s &&
    (s.type === 'Literal' || s.type === 'StringLiteral') &&
    typeof s.value === 'string'
    ? s.value
    : null;
}

function literalRequireSource(node) {
  if (node?.type !== 'CallExpression') return null;
  if (node.callee?.type !== 'Identifier' || node.callee.name !== 'require') return null;
  const first = node.arguments?.[0];
  return first?.type === 'Literal' && typeof first.value === 'string'
    ? first.value
    : null;
}

function opaqueDynamicImportHint(node) {
  if (node?.type !== 'ImportExpression') return null;
  if (literalImportSource(node)) return null;
  const s = node.source;
  if (s?.type === 'TemplateLiteral' &&
      Array.isArray(s.expressions) &&
      s.expressions.length > 0) {
    const prefix = s.quasis?.[0]?.value?.cooked;
    if (typeof prefix === 'string' &&
        /^(?:\.\/|\.\.\/).+[\/\\]$/.test(prefix)) {
      return { kind: 'template-prefix', prefix };
    }
  }
  return { kind: 'nonliteral' };
}

function unwrapAwait(node) {
  return node?.type === 'AwaitExpression' ? node.argument : node;
}

function memberPropertyName(node) {
  const p = node?.property;
  if (!p) return null;
  if (typeof p.name === 'string') return p.name;
  if (typeof p.value === 'string') return p.value;
  return null;
}

function isCallCallee(parent, key) {
  return parent?.type === 'CallExpression' && key === 'callee';
}

function collectTopLevelSymbols(program, getNodeLine) {
  const defs = [];
  const uses = [];
  const reExports = [];
  const namespaceImports = new Map();

  for (const node of program.body) {
    collectExportDefinitions(node, defs, getNodeLine);
    collectReExports(node, reExports, uses, getNodeLine);
    collectImports(node, uses, namespaceImports, getNodeLine);
  }

  return { defs, uses, reExports, namespaceImports };
}

function collectExportDefinitions(node, defs, getNodeLine) {
  if (node.type === 'ExportDefaultDeclaration') {
    defs.push({ name: 'default', kind: 'default', line: getNodeLine(node) });
    return;
  }

  if (node.type !== 'ExportNamedDeclaration' || node.source) return;
  collectDeclarationDefs(node.declaration, defs, getNodeLine);
  collectExportSpecifierDefs(node, defs, getNodeLine);
}

function collectDeclarationDefs(declaration, defs, getNodeLine) {
  if (!declaration) return;
  const line = getNodeLine(declaration);

  if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
    if (declaration.id?.name) defs.push({ name: declaration.id.name, kind: declaration.type, line });
    return;
  }

  if (declaration.type === 'VariableDeclaration') {
    for (const decl of declaration.declarations) {
      if (decl.id?.type === 'Identifier') {
        defs.push({ name: decl.id.name, kind: `${declaration.kind}-var`, line });
      }
    }
    return;
  }

  if (isTypeDeclaration(declaration) && declaration.id?.name) {
    defs.push({ name: declaration.id.name, kind: declaration.type, line });
  }
}

function collectExportSpecifierDefs(node, defs, getNodeLine) {
  for (const spec of node.specifiers ?? []) {
    if (spec.type !== 'ExportSpecifier' || !spec.exported?.name) continue;
    const exportedName = spec.exported.name;
    const localName = spec.local?.name ?? exportedName;
    const def = { name: exportedName, kind: 'ExportSpecifier', line: getNodeLine(spec) };
    if (localName !== exportedName) def.localName = localName;
    defs.push(def);
  }
}

function isTypeDeclaration(node) {
  return node.type === 'TSInterfaceDeclaration' ||
    node.type === 'TSTypeAliasDeclaration' ||
    node.type === 'TSEnumDeclaration' ||
    node.type === 'TSModuleDeclaration';
}

function collectReExports(node, reExports, uses, getNodeLine) {
  if (node.type === 'ExportNamedDeclaration' && node.source) {
    reExports.push({ source: node.source.value, line: getNodeLine(node) });
    collectNamedReExportUses(node, uses, getNodeLine);
    return;
  }

  if (node.type === 'ExportAllDeclaration') {
    reExports.push({ source: node.source.value, line: getNodeLine(node) });
    uses.push({
      fromSpec: node.source.value,
      name: '*',
      kind: 'reExportAll',
      typeOnly: node.exportKind === 'type',
      line: getNodeLine(node),
    });
  }
}

function collectNamedReExportUses(node, uses, getNodeLine) {
  const declTypeOnly = node.exportKind === 'type';
  for (const spec of node.specifiers ?? []) {
    if (spec.type === 'ExportSpecifier') {
      uses.push({
        fromSpec: node.source.value,
        name: spec.local?.name ?? spec.exported?.name,
        kind: 'reExport',
        typeOnly: declTypeOnly || spec.exportKind === 'type',
        line: getNodeLine(spec),
      });
    }
  }
}

function collectImports(node, uses, namespaceImports, getNodeLine) {
  if (node.type !== 'ImportDeclaration') return;

  for (const spec of node.specifiers ?? []) {
    if (spec.type === 'ImportSpecifier') {
      uses.push({
        fromSpec: node.source.value,
        name: spec.imported?.name ?? spec.local?.name,
        kind: 'import',
        typeOnly: node.importKind === 'type' || spec.importKind === 'type',
        line: getNodeLine(spec),
      });
    } else if (spec.type === 'ImportDefaultSpecifier') {
      uses.push({
        fromSpec: node.source.value,
        name: 'default',
        kind: 'default',
        typeOnly: node.importKind === 'type',
        line: getNodeLine(spec),
      });
    } else if (spec.type === 'ImportNamespaceSpecifier' && spec.local?.name) {
      namespaceImports.set(spec.local.name, {
        fromSpec: node.source.value,
        typeOnly: node.importKind === 'type',
        line: getNodeLine(spec),
      });
    }
  }
}

function collectMemberPrecisionUses(program, namespaceImports, getNodeLine) {
  const state = createMemberPrecisionState();
  const rootScope = makeScope();
  bindNamespaceImports(rootScope, namespaceImports, state);
  walkMemberPrecision(program, rootScope, state, getNodeLine);
  return {
    uses: emitMemberPrecisionUses(state),
    opaqueDynamicImports: state.opaqueDynamicImports,
  };
}

function createMemberPrecisionState() {
  return {
    fallbackDynamicImports: [],
    opaqueDynamicImports: [],
    namespaceRecords: [],
    dynamicRecords: [],
    cjsRecords: [],
    cjsDirectUses: [],
    cjsFallbackUses: [],
    handledDynamicImports: new WeakSet(),
    handledCjsRequires: new WeakSet(),
  };
}

function makeScope(parent = null) {
  return { parent, bindings: new Map() };
}

function bind(scope, name, binding) {
  if (typeof name === 'string' && name.length > 0) scope.bindings.set(name, binding);
}

function resolveBinding(scope, name) {
  for (let s = scope; s; s = s.parent) {
    if (s.bindings.has(name)) return s.bindings.get(name);
  }
  return null;
}

function makeTracked(state, kind, fields) {
  const record = {
    kind,
    members: [],
    degraded: false,
    ...fields,
  };
  if (kind === 'namespace') state.namespaceRecords.push(record);
  else if (kind === 'dynamic') state.dynamicRecords.push(record);
  else if (kind === 'cjs') state.cjsRecords.push(record);
  return record;
}

function bindPattern(scope, pattern, binding) {
  if (!pattern || typeof pattern !== 'object') return;
  if (pattern.type === 'Identifier') {
    bind(scope, pattern.name, binding);
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    for (const el of pattern.elements ?? []) bindPattern(scope, el, binding);
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties ?? []) {
      if (prop?.type === 'Property') bindPattern(scope, prop.value, binding);
      else if (prop?.type === 'RestElement') bindPattern(scope, prop.argument, binding);
    }
    return;
  }
  if (pattern.type === 'RestElement') bindPattern(scope, pattern.argument, binding);
  else if (pattern.type === 'AssignmentPattern') bindPattern(scope, pattern.left, binding);
}

function bindNamespaceImports(rootScope, namespaceImports, state) {
  for (const [localName, imp] of namespaceImports) {
    bind(rootScope, localName, makeTracked(state, 'namespace', {
      fromSpec: imp.fromSpec,
      typeOnly: imp.typeOnly,
      line: imp.line,
      localName,
    }));
  }
}

function walkMemberPrecision(node, scope, state, getNodeLine, parent = null, key = '') {
  if (!node || typeof node !== 'object') return;

  if (node.type === 'Program') {
    walkNodeList(node.body, scope, state, getNodeLine, node, 'body');
    return;
  }

  if (node.type === 'ImportDeclaration') return;
  if (isFunctionNode(node)) return walkFunctionNode(node, scope, state, getNodeLine);
  if (node.type === 'BlockStatement' || node.type === 'CatchClause') {
    return walkBlockLikeNode(node, scope, state, getNodeLine);
  }

  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    bind(scope, node.id?.name, { kind: 'local' });
  }

  if (node.type === 'VariableDeclaration') return walkVariableDeclaration(node, scope, state, getNodeLine);
  if (handleCjsReexportAssignment(node, state, getNodeLine)) return;
  if (handleThenDynamicImport(node, scope, state, getNodeLine)) return;
  if (handleDirectRequireMemberExpression(node, state, getNodeLine)) return;
  if (handleTrackedMemberExpression(node, scope, parent, key, getNodeLine)) return;
  if (handleFallbackImportExpression(node, state, getNodeLine)) return;
  if (handleFallbackRequireExpression(node, state, getNodeLine, parent)) return;
  if (handleTrackedIdentifier(node, scope)) return;

  walkChildNodes(node, scope, state, getNodeLine);
}

function isFunctionNode(node) {
  return node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression';
}

function walkFunctionNode(node, scope, state, getNodeLine) {
  if (node.type === 'FunctionDeclaration') bind(scope, node.id?.name, { kind: 'local' });
  const fnScope = makeScope(scope);
  if (node.type === 'FunctionExpression') bind(fnScope, node.id?.name, { kind: 'local' });
  for (const param of node.params ?? []) bindPattern(fnScope, param, { kind: 'local' });
  walkMemberPrecision(node.body, fnScope, state, getNodeLine, node, 'body');
}

function walkBlockLikeNode(node, scope, state, getNodeLine) {
  const blockScope = makeScope(scope);
  if (node.type === 'CatchClause') bindPattern(blockScope, node.param, { kind: 'local' });
  const body = node.type === 'BlockStatement' ? node.body : [node.body];
  walkNodeList(body, blockScope, state, getNodeLine, node, 'body');
}

function walkVariableDeclaration(node, scope, state, getNodeLine) {
  for (const decl of node.declarations ?? []) {
    const requireSpec = literalRequireSource(decl.init);
    if (requireSpec) {
      state.handledCjsRequires.add(decl.init);
      if (decl.id?.type === 'ObjectPattern') {
        collectCjsDestructuringUses(decl.id, requireSpec, state, getNodeLine(decl.init));
        bindPattern(scope, decl.id, { kind: 'local' });
      } else if (decl.id?.type === 'Identifier') {
        if (node.kind === 'const') {
          bind(scope, decl.id.name, makeTracked(state, 'cjs', {
            fromSpec: requireSpec,
            typeOnly: false,
            line: getNodeLine(decl.init),
            localName: decl.id.name,
            node: decl.init,
          }));
        } else {
          state.cjsFallbackUses.push({
            fromSpec: requireSpec,
            name: '*',
            kind: 'cjs-namespace-escape',
            typeOnly: false,
            line: getNodeLine(decl.init),
            localName: decl.id.name,
            degraded: true,
          });
          bind(scope, decl.id.name, { kind: 'local' });
        }
      } else {
        state.cjsFallbackUses.push({
          fromSpec: requireSpec,
          name: '*',
          kind: 'cjs-namespace-escape',
          typeOnly: false,
          line: getNodeLine(decl.init),
          degraded: true,
        });
        bindPattern(scope, decl.id, { kind: 'local' });
      }
      continue;
    }

    const importNode = unwrapAwait(decl.init);
    const fromSpec = literalImportSource(importNode);
    if (decl.id?.type === 'Identifier' && fromSpec) {
      const record = makeTracked(state, 'dynamic', {
        fromSpec,
        typeOnly: false,
        line: getNodeLine(importNode),
        localName: decl.id.name,
        node: importNode,
      });
      bind(scope, decl.id.name, record);
      state.handledDynamicImports.add(importNode);
    } else {
      bindPattern(scope, decl.id, { kind: 'local' });
      walkMemberPrecision(decl.init, scope, state, getNodeLine, decl, 'init');
    }
  }
}

function collectCjsDestructuringUses(pattern, fromSpec, state, line) {
  for (const prop of pattern.properties ?? []) {
    if (prop?.type === 'Property') {
      const key = prop.key;
      const name = key?.type === 'Identifier' || key?.type === 'Literal'
        ? String(key.name ?? key.value)
        : null;
      if (name) {
        state.cjsDirectUses.push({
          fromSpec,
          name,
          kind: 'cjs-require-exact',
          typeOnly: false,
          line,
        });
      }
    } else if (prop?.type === 'RestElement') {
      state.cjsFallbackUses.push({
        fromSpec,
        name: '*',
        kind: 'cjs-namespace-escape',
        typeOnly: false,
        line,
        degraded: true,
      });
    }
  }
}

function isModuleExportsTarget(node) {
  if (node?.type !== 'MemberExpression' || node.computed) return false;
  const prop = memberPropertyName(node);
  if (node.object?.type === 'Identifier' && node.object.name === 'exports') return !!prop;
  return node.object?.type === 'Identifier' &&
    node.object.name === 'module' &&
    prop === 'exports';
}

function handleCjsReexportAssignment(node, state, getNodeLine) {
  if (node.type !== 'AssignmentExpression') return false;
  const fromSpec = literalRequireSource(node.right);
  if (!fromSpec || !isModuleExportsTarget(node.left)) return false;
  state.handledCjsRequires.add(node.right);
  state.cjsFallbackUses.push({
    fromSpec,
    name: '*',
    kind: 'cjs-reexport-broad',
    typeOnly: false,
    line: getNodeLine(node.right),
    degraded: true,
  });
  return true;
}

function handleDirectRequireMemberExpression(node, state, getNodeLine) {
  if (node.type !== 'MemberExpression' || node.computed) return false;
  const fromSpec = literalRequireSource(node.object);
  if (!fromSpec) return false;
  state.handledCjsRequires.add(node.object);
  const name = memberPropertyName(node);
  if (name) {
    state.cjsDirectUses.push({
      fromSpec,
      name,
      kind: 'cjs-namespace-member',
      typeOnly: false,
      line: getNodeLine(node),
    });
  } else {
    state.cjsFallbackUses.push({
      fromSpec,
      name: '*',
      kind: 'cjs-namespace-escape',
      typeOnly: false,
      line: getNodeLine(node),
      degraded: true,
    });
  }
  return true;
}

function handleThenDynamicImport(node, scope, state, getNodeLine) {
  if (node.type !== 'CallExpression' ||
      node.callee?.type !== 'MemberExpression' ||
      node.callee.computed ||
      memberPropertyName(node.callee) !== 'then') return false;

  const importNode = node.callee.object;
  const fromSpec = literalImportSource(importNode);
  const callback = node.arguments?.[0];
  const param = callback?.params?.[0];
  if (!fromSpec || param?.type !== 'Identifier' || !isFunctionNode(callback)) return false;

  const record = makeTracked(state, 'dynamic', {
    fromSpec,
    typeOnly: false,
    line: getNodeLine(importNode),
    localName: param.name,
    node: importNode,
  });
  const callbackScope = makeScope(scope);
  bind(callbackScope, param.name, record);
  for (const extraParam of (callback.params ?? []).slice(1)) {
    bindPattern(callbackScope, extraParam, { kind: 'local' });
  }
  walkMemberPrecision(callback.body, callbackScope, state, getNodeLine, callback, 'body');
  state.handledDynamicImports.add(importNode);
  return true;
}

function handleTrackedMemberExpression(node, scope, parent, key, getNodeLine) {
  if (node.type !== 'MemberExpression' || node.object?.type !== 'Identifier') return false;
  const record = resolveBinding(scope, node.object.name);
  if (record?.kind !== 'namespace' && record?.kind !== 'dynamic' && record?.kind !== 'cjs') return false;

  if (record.kind === 'cjs') {
    const name = !node.computed ? memberPropertyName(node) : null;
    if (name) record.members.push({ name, line: getNodeLine(node) });
    else record.degraded = true;
    return true;
  }

  if (!node.computed && isCallCallee(parent, key)) {
    const name = memberPropertyName(node);
    if (name) record.members.push({ name, line: getNodeLine(node) });
  } else {
    record.degraded = true;
  }
  return true;
}

function handleFallbackImportExpression(node, state, getNodeLine) {
  if (node.type !== 'ImportExpression') return false;
  const fromSpec = literalImportSource(node);
  if (fromSpec && !state.handledDynamicImports.has(node)) {
    state.fallbackDynamicImports.push({ node, fromSpec, line: getNodeLine(node) });
  } else if (!fromSpec) {
    const hint = opaqueDynamicImportHint(node);
    if (hint) {
      state.opaqueDynamicImports.push({
        line: getNodeLine(node),
        ...hint,
      });
    }
  }
  return true;
}

function handleFallbackRequireExpression(node, state, getNodeLine, parent) {
  const fromSpec = literalRequireSource(node);
  if (!fromSpec || state.handledCjsRequires.has(node)) return false;
  const sideEffectOnly = parent?.type === 'ExpressionStatement';
  state.cjsFallbackUses.push({
    fromSpec,
    name: '*',
    kind: sideEffectOnly ? 'cjs-side-effect-only' : 'cjs-namespace-escape',
    typeOnly: false,
    line: getNodeLine(node),
    ...(sideEffectOnly ? {} : { degraded: true }),
  });
  state.handledCjsRequires.add(node);
  return true;
}

function handleTrackedIdentifier(node, scope) {
  if (node.type !== 'Identifier') return false;
  const record = resolveBinding(scope, node.name);
  if (record?.kind === 'namespace' || record?.kind === 'dynamic' || record?.kind === 'cjs') {
    record.degraded = true;
  }
  return true;
}

function walkNodeList(nodes, scope, state, getNodeLine, parent, key) {
  for (const child of nodes ?? []) {
    walkMemberPrecision(child, scope, state, getNodeLine, parent, key);
  }
}

function walkChildNodes(node, scope, state, getNodeLine) {
  for (const childKey of Object.keys(node)) {
    if (childKey === 'type' || childKey === 'start' || childKey === 'end') continue;
    const v = node[childKey];
    if (Array.isArray(v)) {
      walkNodeList(v.filter((child) => child && typeof child === 'object' && child.type),
        scope, state, getNodeLine, node, childKey);
    } else if (v && typeof v === 'object' && typeof v.type === 'string') {
      walkMemberPrecision(v, scope, state, getNodeLine, node, childKey);
    }
  }
}

function emitMemberPrecisionUses(state) {
  return [
    ...emitNamespaceRecordUses(state.namespaceRecords),
    ...emitDynamicRecordUses(state),
    ...emitFallbackDynamicUses(state),
    ...emitCjsUses(state),
  ];
}

function emitNamespaceRecordUses(namespaceRecords) {
  const uses = [];
  for (const record of namespaceRecords) {
    if (record.members.length > 0 && !record.degraded) {
      for (const member of record.members) {
        uses.push({
          fromSpec: record.fromSpec,
          name: member.name,
          kind: 'namespace-member',
          typeOnly: record.typeOnly,
          line: member.line,
          localName: record.localName,
        });
      }
    } else if (record.degraded) {
      uses.push({
        fromSpec: record.fromSpec,
        name: '*',
        kind: 'namespace',
        typeOnly: record.typeOnly,
        line: record.line,
        localName: record.localName,
        degraded: true,
      });
    }
  }
  return uses;
}

function emitDynamicRecordUses(state) {
  const uses = [];
  for (const record of state.dynamicRecords) {
    if (record.members.length > 0 && !record.degraded) {
      state.handledDynamicImports.add(record.node);
      for (const member of record.members) {
        uses.push({
          fromSpec: record.fromSpec,
          name: member.name,
          kind: 'dynamic-member',
          typeOnly: false,
          line: member.line,
          dynamic: true,
          localName: record.localName,
        });
      }
    } else {
      uses.push({
        fromSpec: record.fromSpec,
        name: '*',
        kind: 'dynamic',
        typeOnly: false,
        line: record.line,
        dynamic: true,
        degraded: true,
        ...(record.localName ? { localName: record.localName } : {}),
      });
    }
  }
  return uses;
}

function emitFallbackDynamicUses(state) {
  const uses = [];
  for (const d of state.fallbackDynamicImports) {
    if (state.handledDynamicImports.has(d.node)) continue;
    uses.push({
      fromSpec: d.fromSpec,
      name: '*',
      kind: 'dynamic',
      typeOnly: false,
      line: d.line,
      dynamic: true,
      degraded: true,
    });
  }
  return uses;
}

function emitCjsUses(state) {
  const uses = [...state.cjsDirectUses, ...state.cjsFallbackUses];
  for (const record of state.cjsRecords) {
    if (record.members.length > 0 && !record.degraded) {
      for (const member of record.members) {
        uses.push({
          fromSpec: record.fromSpec,
          name: member.name,
          kind: 'cjs-namespace-member',
          typeOnly: false,
          line: member.line,
          localName: record.localName,
        });
      }
    } else if (record.degraded) {
      uses.push({
        fromSpec: record.fromSpec,
        name: '*',
        kind: 'cjs-namespace-escape',
        typeOnly: false,
        line: record.line,
        localName: record.localName,
        degraded: true,
      });
    }
  }
  return uses;
}

export function extractDefinitionsAndUses(filePath, options = {}) {
  const src = readFileSync(filePath, 'utf8');
  const result = parseOxcOrThrow(filePath, src);
  const getNodeLine = makeLineGetter(src);
  const { defs, uses, reExports, namespaceImports } =
    collectTopLevelSymbols(result.program, getNodeLine);
  const memberPrecision = collectMemberPrecisionUses(result.program, namespaceImports, getNodeLine);
  uses.push(...memberPrecision.uses);
  const typeEscapePath = options.artifactFilePath ?? filePath;
  const typeEscapeResult = extractTypeEscapes(src, typeEscapePath);

  return {
    filePath,
    defs,
    uses,
    reExports,
    typeEscapes: typeEscapeResult.typeEscapes ?? [],
    loc: src.split('\n').length,
    ...(memberPrecision.opaqueDynamicImports.length > 0
      ? { dynamicImportOpacity: memberPrecision.opaqueDynamicImports }
      : {}),
  };
}
