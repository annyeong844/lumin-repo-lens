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
import { definitionIdFromOxcNode } from './definition-id.mjs';
import { uniquePreWriteTokens } from './pre-write-token-policy.mjs';

const LOCAL_OPERATION_READ_QUERY_VERBS = new Set([
  'fetch',
  'find',
  'get',
  'list',
  'load',
  'lookup',
  'query',
  'read',
  'resolve',
  'retrieve',
  'search',
]);

const LOCAL_OPERATION_MUTATION_VERBS = new Set([
  'add',
  'create',
  'delete',
  'destroy',
  'dispatch',
  'emit',
  'patch',
  'remove',
  'save',
  'send',
  'set',
  'update',
  'upsert',
  'write',
]);

const LOCAL_OPERATION_CONTAINER_START = new Set(['build', 'create', 'make']);
const LOCAL_OPERATION_CONTAINER_DOMAIN = new Set(['repository', 'service']);

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
  if (node.callee?.type !== 'Identifier' || node.callee.name !== 'require')
    return null;
  const first = node.arguments?.[0];
  return first?.type === 'Literal' && typeof first.value === 'string'
    ? first.value
    : null;
}

function isRequireCall(node) {
  return (
    node?.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'require'
  );
}

function opaqueDynamicImportHint(node) {
  if (node?.type !== 'ImportExpression') return null;
  if (literalImportSource(node)) return null;
  const s = node.source;
  if (
    s?.type === 'TemplateLiteral' &&
    Array.isArray(s.expressions) &&
    s.expressions.length > 0
  ) {
    const prefix = s.quasis?.[0]?.value?.cooked;
    if (
      typeof prefix === 'string' &&
      /^(?:\.\/|\.\.\/).+[\/\\]$/.test(prefix)
    ) {
      return { kind: 'template-prefix', prefix };
    }
  }
  return { kind: 'nonliteral' };
}

function isImportMetaGlobCall(node) {
  if (node?.type !== 'CallExpression') return null;
  const callee = node.callee;
  if (callee?.type !== 'MemberExpression' || callee.computed) return null;
  if (memberPropertyName(callee) !== 'glob') return null;
  const object = callee.object;
  if (object?.type !== 'MetaProperty') return null;
  if (object.meta?.name !== 'import' || object.property?.name !== 'meta')
    return null;
  return true;
}

function importMetaGlobPattern(node) {
  if (!isImportMetaGlobCall(node)) return null;
  return literalStringValue(node.arguments?.[0]);
}

function affectedDirFromGlobPattern(pattern) {
  if (typeof pattern !== 'string') return null;
  const normalized = pattern.replace(/\\/g, '/');
  if (!normalized.startsWith('./') && !normalized.startsWith('../'))
    return null;
  const firstDynamic = normalized.search(/[*?[{]/);
  if (firstDynamic < 0) return null;
  const staticPrefix = normalized.slice(0, firstDynamic);
  const slash = staticPrefix.lastIndexOf('/');
  if (slash < 0) return null;
  return staticPrefix.slice(0, slash) || '.';
}

function opaqueCjsRequireHint(node) {
  if (!isRequireCall(node) || literalRequireSource(node)) return null;
  if (isStaticJsonRequireArgument(node.arguments?.[0])) return null;
  return { kind: 'dynamic-require' };
}

function literalStringValue(node) {
  if (!node) return null;
  if (
    (node.type === 'Literal' || node.type === 'StringLiteral') &&
    typeof node.value === 'string'
  ) {
    return node.value;
  }
  return null;
}

function isJsonPathFragment(value) {
  return (
    typeof value === 'string' &&
    value.replace(/\\/g, '/').toLowerCase().endsWith('.json')
  );
}

function isPathJoinOrResolveCall(node) {
  if (node?.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee?.type !== 'MemberExpression' || callee.computed) return false;
  const prop = memberPropertyName(callee);
  return (
    (prop === 'join' || prop === 'resolve') &&
    callee.object?.type === 'Identifier' &&
    callee.object.name === 'path'
  );
}

function isStaticJsonRequireArgument(node) {
  const direct = literalStringValue(node);
  if (isJsonPathFragment(direct)) return true;

  if (!isPathJoinOrResolveCall(node)) return false;
  const args = node.arguments ?? [];
  const last = args[args.length - 1];
  return isJsonPathFragment(literalStringValue(last));
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

function staticMemberPropertyName(node) {
  if (!node?.computed) return memberPropertyName(node);
  return literalStringValue(node.property);
}

function isCallCallee(parent, key) {
  return parent?.type === 'CallExpression' && key === 'callee';
}

function isNonEscapingTrackedIdentifierRead(parent, key) {
  if (!parent) return false;
  if (parent.type === 'IfStatement' && key === 'test') return true;
  if (parent.type === 'LogicalExpression' && key === 'left') return true;
  if (
    parent.type === 'UnaryExpression' &&
    parent.operator === 'typeof' &&
    key === 'argument'
  )
    return true;
  return false;
}

function isMutatingMemberAccess(parent, key) {
  if (!parent) return false;
  if (parent.type === 'AssignmentExpression' && key === 'left') return true;
  if (parent.type === 'UpdateExpression' && key === 'argument') return true;
  if (
    parent.type === 'UnaryExpression' &&
    parent.operator === 'delete' &&
    key === 'argument'
  )
    return true;
  return false;
}

function collectTopLevelSymbols(program, getNodeLine, artifactFilePath) {
  const defs = [];
  const uses = [];
  const reExports = [];
  const namespaceImports = new Map();
  const namedImports = new Map();
  const cjsExportSurface = collectCjsExportSurface(program, getNodeLine);
  const classMethods = collectClassMethodSurface(
    program,
    getNodeLine,
    artifactFilePath,
  );
  const localOperations = collectPreWriteLocalOperationSurface(
    program,
    getNodeLine,
    artifactFilePath,
  );
  const localDeclarations = collectTopLevelDeclarationTargets(program);

  for (const node of program.body) {
    collectExportDefinitions(
      node,
      defs,
      getNodeLine,
      artifactFilePath,
      localDeclarations,
    );
    collectReExports(node, reExports, uses, getNodeLine);
    collectImports(node, uses, namespaceImports, namedImports, getNodeLine);
  }

  return {
    defs,
    uses,
    reExports,
    namespaceImports,
    namedImports,
    cjsExportSurface,
    classMethods,
    localOperations,
  };
}

function classNameFromTopLevelNode(node) {
  const declaration =
    node.type === 'ExportNamedDeclaration' ||
    node.type === 'ExportDefaultDeclaration'
      ? node.declaration
      : node;

  if (declaration?.type === 'ClassDeclaration' && declaration.id?.name) {
    return { className: declaration.id.name, classNode: declaration };
  }

  if (declaration?.type === 'VariableDeclaration') {
    const out = [];
    for (const decl of declaration.declarations ?? []) {
      if (
        decl.id?.type === 'Identifier' &&
        decl.init?.type === 'ClassExpression'
      ) {
        out.push({ className: decl.id.name, classNode: decl.init });
      }
    }
    return out;
  }

  return null;
}

function methodNameFromClassKey(key, computed) {
  if (!key) return null;
  if (key.type === 'PrivateIdentifier' && typeof key.name === 'string')
    return `#${key.name}`;
  if (!computed && typeof key.name === 'string') return key.name;
  if (computed) return null;
  if (typeof key.value === 'string') return key.value;
  return null;
}

function classMemberRecord(member, className, getNodeLine, artifactFilePath) {
  const memberType = member?.type;
  const isMethod = memberType === 'MethodDefinition';
  const isFunctionField =
    memberType === 'PropertyDefinition' &&
    (member.value?.type === 'ArrowFunctionExpression' ||
      member.value?.type === 'FunctionExpression');
  if (!isMethod && !isFunctionField) return null;

  const methodName = methodNameFromClassKey(
    member.key,
    member.computed === true,
  );
  if (!methodName || methodName === 'constructor') return null;

  const memberKind = isMethod
    ? (member.kind ?? 'method')
    : 'class-field-function';
  if (memberKind === 'constructor') return null;

  const visibility = methodName.startsWith('#')
    ? 'private'
    : (member.accessibility ?? 'public');
  const line = getNodeLine(member.key ?? member);
  const endLine = getNodeLine(member.value ?? member);
  const record = {
    identity: `${artifactFilePath}::${className}#${methodName}`,
    ownerFile: artifactFilePath,
    className,
    name: methodName,
    methodName,
    kind: 'ClassMethod',
    memberKind,
    visibility,
    static: member.static === true,
    computed: member.computed === true,
    line,
  };
  if (endLine && endLine !== line) record.endLine = endLine;
  return record;
}

function collectClassMethodsFromClass(
  classNode,
  className,
  getNodeLine,
  artifactFilePath,
) {
  const out = [];
  for (const member of classNode?.body?.body ?? []) {
    const record = classMemberRecord(
      member,
      className,
      getNodeLine,
      artifactFilePath,
    );
    if (record) out.push(record);
  }
  return out;
}

function collectClassMethodSurface(program, getNodeLine, artifactFilePath) {
  const out = [];
  for (const node of program.body ?? []) {
    const info = classNameFromTopLevelNode(node);
    if (Array.isArray(info)) {
      for (const entry of info) {
        out.push(
          ...collectClassMethodsFromClass(
            entry.classNode,
            entry.className,
            getNodeLine,
            artifactFilePath,
          ),
        );
      }
      continue;
    }
    if (info) {
      out.push(
        ...collectClassMethodsFromClass(
          info.classNode,
          info.className,
          getNodeLine,
          artifactFilePath,
        ),
      );
    }
  }
  return out;
}

function isFunctionExpressionLike(node) {
  return (
    node?.type === 'FunctionExpression' ||
    node?.type === 'ArrowFunctionExpression'
  );
}

function containerKindForVariableInit(node) {
  if (node?.type === 'FunctionExpression') return 'const-function-expression';
  if (node?.type === 'ArrowFunctionExpression') return 'const-arrow-function';
  return null;
}

function containerCandidateFromFunctionDeclaration(node) {
  if (node?.type !== 'FunctionDeclaration' || !node.id?.name) return null;
  return {
    name: node.id.name,
    node,
    containerKind: 'function-declaration',
  };
}

function containerCandidateFromVariableDeclarator(decl, declarationKind) {
  if (declarationKind !== 'const') return null;
  if (decl?.id?.type !== 'Identifier' || !isFunctionExpressionLike(decl.init))
    return null;
  const containerKind = containerKindForVariableInit(decl.init);
  if (!containerKind) return null;
  return {
    name: decl.id.name,
    node: decl.init,
    containerKind,
  };
}

function collectExportedFactoryContainers(program) {
  const localDeclarations = collectTopLevelDeclarationTargets(program);
  const containers = [];

  function addContainer(candidate) {
    if (!candidate || !isLocalOperationContainerName(candidate.name)) return;
    containers.push(candidate);
  }

  for (const node of program.body ?? []) {
    if (node.type === 'ExportDefaultDeclaration') {
      addContainer(containerCandidateFromFunctionDeclaration(node.declaration));
      continue;
    }

    if (node.type !== 'ExportNamedDeclaration' || node.source) continue;

    const declaration = node.declaration;
    if (declaration?.type === 'FunctionDeclaration') {
      addContainer(containerCandidateFromFunctionDeclaration(declaration));
      continue;
    }

    if (declaration?.type === 'VariableDeclaration') {
      for (const decl of declaration.declarations ?? []) {
        addContainer(
          containerCandidateFromVariableDeclarator(decl, declaration.kind),
        );
      }
      continue;
    }

    for (const spec of node.specifiers ?? []) {
      if (spec.type !== 'ExportSpecifier') continue;
      const localName = spec.local?.name;
      const local = localName ? localDeclarations.get(localName) : null;
      if (!local) continue;
      if (local.type === 'FunctionDeclaration') {
        addContainer(containerCandidateFromFunctionDeclaration(local));
      } else if (local.type === 'VariableDeclarator') {
        addContainer(containerCandidateFromVariableDeclarator(local, 'const'));
      }
    }
  }

  return containers.sort((a, b) =>
    `${a.name}|${a.containerKind}`.localeCompare(
      `${b.name}|${b.containerKind}`,
    ),
  );
}

function isLocalOperationContainerName(name) {
  const tokens = uniquePreWriteTokens(name);
  return (
    LOCAL_OPERATION_CONTAINER_START.has(tokens[0]) &&
    tokens.some((token) => LOCAL_OPERATION_CONTAINER_DOMAIN.has(token))
  );
}

function localOperationInfo(name) {
  const tokens = uniquePreWriteTokens(name);
  const verb = tokens[0];
  if (!LOCAL_OPERATION_READ_QUERY_VERBS.has(verb)) return null;
  if (LOCAL_OPERATION_MUTATION_VERBS.has(verb)) return null;
  const domainTokens = tokens
    .slice(1)
    .filter(
      (token) =>
        token &&
        !LOCAL_OPERATION_READ_QUERY_VERBS.has(token) &&
        !LOCAL_OPERATION_MUTATION_VERBS.has(token),
    );
  if (domainTokens.length === 0) return null;
  return {
    operationFamily: 'read-query',
    domainTokens,
  };
}

function localFunctionCandidateFromStatement(statement) {
  if (statement?.type === 'FunctionDeclaration' && statement.id?.name) {
    return {
      name: statement.id.name,
      node: statement,
      declarationKind: 'function-declaration',
    };
  }

  if (statement?.type !== 'VariableDeclaration' || statement.kind !== 'const')
    return null;
  const out = [];
  for (const decl of statement.declarations ?? []) {
    if (decl.id?.type !== 'Identifier' || !isFunctionExpressionLike(decl.init))
      continue;
    const declarationKind = containerKindForVariableInit(decl.init);
    if (!declarationKind) continue;
    out.push({
      name: decl.id.name,
      node: decl,
      declarationKind,
    });
  }
  return out;
}

function collectPreWriteLocalOperationSurface(
  program,
  getNodeLine,
  artifactFilePath,
) {
  const out = [];
  for (const container of collectExportedFactoryContainers(program)) {
    if (container.node?.body?.type !== 'BlockStatement') continue;
    for (const statement of container.node.body.body ?? []) {
      const candidate = localFunctionCandidateFromStatement(statement);
      const candidates = Array.isArray(candidate) ? candidate : [candidate];
      for (const item of candidates) {
        if (!item) continue;
        const operation = localOperationInfo(item.name);
        if (!operation) continue;
        out.push({
          identity: `${artifactFilePath}::${container.name}#${item.name}`,
          name: item.name,
          ownerFile: artifactFilePath,
          containerName: container.name,
          containerKind: container.containerKind,
          scopeKind: 'nested-function',
          matchedField: 'preWriteLocalOperationIndex',
          line: getNodeLine(item.node?.id ?? item.node),
          operationFamily: operation.operationFamily,
          domainTokens: operation.domainTokens,
          visibility: 'local-only',
          eligibleForDeadExportRanking: false,
          eligibleForSafeFix: false,
        });
      }
    }
  }
  return out.sort((a, b) =>
    `${a.ownerFile}|${a.containerName}|${a.name}|${String(a.line).padStart(6, '0')}`.localeCompare(
      `${b.ownerFile}|${b.containerName}|${b.name}|${String(b.line).padStart(6, '0')}`,
    ),
  );
}

function collectTopLevelDeclarationTargets(program) {
  const out = new Map();
  for (const node of program.body ?? []) {
    const declaration =
      node.type === 'ExportNamedDeclaration' && node.declaration
        ? node.declaration
        : node;
    if (!declaration || typeof declaration !== 'object') continue;

    if (
      declaration.type === 'FunctionDeclaration' ||
      declaration.type === 'ClassDeclaration'
    ) {
      if (declaration.id?.name && !out.has(declaration.id.name))
        out.set(declaration.id.name, declaration);
      continue;
    }

    if (declaration.type === 'VariableDeclaration') {
      for (const decl of declaration.declarations ?? []) {
        if (decl.id?.type === 'Identifier' && !out.has(decl.id.name))
          out.set(decl.id.name, decl);
      }
      continue;
    }

    if (
      isTypeDeclaration(declaration) &&
      declaration.id?.name &&
      !out.has(declaration.id.name)
    ) {
      out.set(declaration.id.name, declaration);
    }
  }
  return out;
}

function withDefinitionId(def, artifactFilePath, targetNode) {
  const definitionId = definitionIdFromOxcNode(artifactFilePath, targetNode);
  return definitionId ? { ...def, definitionId } : def;
}

function collectExportDefinitions(
  node,
  defs,
  getNodeLine,
  artifactFilePath,
  localDeclarations,
) {
  if (node.type === 'ExportDefaultDeclaration') {
    defs.push(
      withDefinitionId(
        { name: 'default', kind: 'default', line: getNodeLine(node) },
        artifactFilePath,
        node.declaration ?? node,
      ),
    );
    return;
  }

  if (node.type !== 'ExportNamedDeclaration' || node.source) return;
  collectDeclarationDefs(node.declaration, defs, getNodeLine, artifactFilePath);
  collectExportSpecifierDefs(
    node,
    defs,
    getNodeLine,
    artifactFilePath,
    localDeclarations,
  );
}

function collectDeclarationDefs(
  declaration,
  defs,
  getNodeLine,
  artifactFilePath,
) {
  if (!declaration) return;
  const line = getNodeLine(declaration);

  if (
    declaration.type === 'FunctionDeclaration' ||
    declaration.type === 'ClassDeclaration'
  ) {
    if (declaration.id?.name) {
      defs.push(
        withDefinitionId(
          { name: declaration.id.name, kind: declaration.type, line },
          artifactFilePath,
          declaration,
        ),
      );
    }
    return;
  }

  if (declaration.type === 'VariableDeclaration') {
    for (const decl of declaration.declarations) {
      if (decl.id?.type === 'Identifier') {
        defs.push(
          withDefinitionId(
            { name: decl.id.name, kind: `${declaration.kind}-var`, line },
            artifactFilePath,
            decl,
          ),
        );
      }
    }
    return;
  }

  if (isTypeDeclaration(declaration) && declaration.id?.name) {
    defs.push(
      withDefinitionId(
        { name: declaration.id.name, kind: declaration.type, line },
        artifactFilePath,
        declaration,
      ),
    );
  }
}

function collectExportSpecifierDefs(
  node,
  defs,
  getNodeLine,
  artifactFilePath,
  localDeclarations,
) {
  for (const spec of node.specifiers ?? []) {
    if (spec.type !== 'ExportSpecifier' || !spec.exported?.name) continue;
    const exportedName = spec.exported.name;
    const localName = spec.local?.name ?? exportedName;
    const def = {
      name: exportedName,
      kind: 'ExportSpecifier',
      line: getNodeLine(spec),
    };
    if (localName !== exportedName) def.localName = localName;
    defs.push(
      withDefinitionId(
        def,
        artifactFilePath,
        localDeclarations.get(localName) ?? spec,
      ),
    );
  }
}

function isTypeDeclaration(node) {
  return (
    node.type === 'TSInterfaceDeclaration' ||
    node.type === 'TSTypeAliasDeclaration' ||
    node.type === 'TSEnumDeclaration' ||
    node.type === 'TSModuleDeclaration'
  );
}

function collectReExports(node, reExports, uses, getNodeLine) {
  if (node.type === 'ExportNamedDeclaration' && node.source) {
    reExports.push({ source: node.source.value, line: getNodeLine(node) });
    collectNamedReExportUses(node, uses, getNodeLine);
    return;
  }

  if (node.type === 'ExportAllDeclaration') {
    const exportedName = node.exported?.name ?? null;
    reExports.push({
      source: node.source.value,
      line: getNodeLine(node),
      ...(exportedName ? { namespace: exportedName } : {}),
    });
    uses.push({
      fromSpec: node.source.value,
      name: exportedName ?? '*',
      kind: exportedName ? 'reExportNamespace' : 'reExportAll',
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

function collectImports(
  node,
  uses,
  namespaceImports,
  namedImports,
  getNodeLine,
) {
  if (node.type !== 'ImportDeclaration') return;

  if ((node.specifiers ?? []).length === 0) {
    uses.push({
      fromSpec: node.source.value,
      name: '*',
      kind: 'import-side-effect',
      typeOnly: false,
      line: getNodeLine(node),
    });
    return;
  }

  for (const spec of node.specifiers ?? []) {
    if (spec.type === 'ImportSpecifier') {
      const importedName = spec.imported?.name ?? spec.local?.name;
      const localName = spec.local?.name ?? importedName;
      uses.push({
        fromSpec: node.source.value,
        name: importedName,
        kind: 'import',
        typeOnly: node.importKind === 'type' || spec.importKind === 'type',
        line: getNodeLine(spec),
        ...(localName && localName !== importedName ? { localName } : {}),
      });
      if (localName && importedName) {
        namedImports.set(localName, {
          fromSpec: node.source.value,
          importedName,
          typeOnly: node.importKind === 'type' || spec.importKind === 'type',
          line: getNodeLine(spec),
          localName,
        });
      }
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

function collectCjsExportSurface(program, getNodeLine) {
  const surface = { exact: [], opaque: [] };
  for (const node of program.body ?? []) {
    if (node.type !== 'ExpressionStatement') continue;
    const expr = node.expression;
    if (expr?.type !== 'AssignmentExpression' || expr.operator !== '=')
      continue;
    collectCjsExportAssignment(expr, surface, getNodeLine);
  }

  surface.exact.sort((a, b) =>
    `${a.name}|${a.kind}|${String(a.line).padStart(6, '0')}`.localeCompare(
      `${b.name}|${b.kind}|${String(b.line).padStart(6, '0')}`,
    ),
  );
  surface.opaque.sort((a, b) =>
    `${a.kind}|${String(a.line).padStart(6, '0')}`.localeCompare(
      `${b.kind}|${String(b.line).padStart(6, '0')}`,
    ),
  );

  return surface.exact.length || surface.opaque.length ? surface : null;
}

function collectCjsExportAssignment(node, surface, getNodeLine) {
  const member = cjsExportMemberAssignment(node.left);
  if (member) {
    if (member.name) {
      surface.exact.push({
        name: member.name,
        kind: member.kind,
        line: getNodeLine(node.left),
      });
    } else {
      surface.opaque.push({
        kind: 'computed-export-name',
        line: getNodeLine(node.left),
      });
    }
    return;
  }

  if (!isModuleExportsObject(node.left)) return;
  if (node.right?.type !== 'ObjectExpression') {
    surface.opaque.push({
      kind: 'module-exports-assignment',
      line: getNodeLine(node.left),
    });
    return;
  }

  collectModuleExportsObjectProperties(node.right, surface, getNodeLine);
}

function cjsExportMemberAssignment(node) {
  if (node?.type !== 'MemberExpression') return null;

  if (node.object?.type === 'Identifier' && node.object.name === 'exports') {
    return {
      name: staticMemberPropertyName(node),
      kind: 'exports-member',
    };
  }

  if (isModuleExportsObject(node.object)) {
    return {
      name: staticMemberPropertyName(node),
      kind: 'module-exports-member',
    };
  }

  return null;
}

function isModuleExportsObject(node) {
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.object?.type === 'Identifier' &&
    node.object.name === 'module' &&
    memberPropertyName(node) === 'exports'
  );
}

function collectModuleExportsObjectProperties(node, surface, getNodeLine) {
  for (const prop of node.properties ?? []) {
    if (prop?.type !== 'Property') {
      surface.opaque.push({
        kind: 'module-exports-object-opaque',
        line: getNodeLine(prop ?? node),
      });
      continue;
    }

    const name = prop.computed
      ? prop.key?.type === 'Literal' && typeof prop.key.value === 'string'
        ? prop.key.value
        : null
      : (prop.key?.name ??
        (typeof prop.key?.value === 'string' ? prop.key.value : null));
    if (name) {
      surface.exact.push({
        name,
        kind: 'module-exports-object',
        line: getNodeLine(prop),
      });
    } else {
      surface.opaque.push({
        kind: 'computed-export-name',
        line: getNodeLine(prop),
      });
    }
  }
}

function collectMemberPrecisionUses(
  program,
  namespaceImports,
  namedImports,
  getNodeLine,
) {
  const state = createMemberPrecisionState();
  const rootScope = makeScope();
  bindNamespaceImports(rootScope, namespaceImports, state);
  bindNamedImports(rootScope, namedImports, state);
  walkMemberPrecision(program, rootScope, state, getNodeLine);
  return {
    uses: emitMemberPrecisionUses(state),
    opaqueDynamicImports: state.opaqueDynamicImports,
    cjsRequireOpacity: state.cjsRequireOpacity,
  };
}

function createMemberPrecisionState() {
  return {
    fallbackDynamicImports: [],
    opaqueDynamicImports: [],
    cjsRequireOpacity: [],
    namespaceRecords: [],
    namedImportRecords: [],
    dynamicRecords: [],
    importMetaGlobUses: [],
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
  if (typeof name === 'string' && name.length > 0)
    scope.bindings.set(name, binding);
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
  else if (kind === 'named-import') state.namedImportRecords.push(record);
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
      else if (prop?.type === 'RestElement')
        bindPattern(scope, prop.argument, binding);
    }
    return;
  }
  if (pattern.type === 'RestElement')
    bindPattern(scope, pattern.argument, binding);
  else if (pattern.type === 'AssignmentPattern')
    bindPattern(scope, pattern.left, binding);
}

function bindNamespaceImports(rootScope, namespaceImports, state) {
  for (const [localName, imp] of namespaceImports) {
    bind(
      rootScope,
      localName,
      makeTracked(state, 'namespace', {
        fromSpec: imp.fromSpec,
        typeOnly: imp.typeOnly,
        line: imp.line,
        localName,
      }),
    );
  }
}

function bindNamedImports(rootScope, namedImports, state) {
  for (const [localName, imp] of namedImports) {
    bind(
      rootScope,
      localName,
      makeTracked(state, 'named-import', {
        fromSpec: imp.fromSpec,
        importedName: imp.importedName,
        typeOnly: imp.typeOnly,
        line: imp.line,
        localName,
      }),
    );
  }
}

function walkMemberPrecision(
  node,
  scope,
  state,
  getNodeLine,
  parent = null,
  key = '',
) {
  if (!node || typeof node !== 'object') return;

  if (node.type === 'Program') {
    walkNodeList(node.body, scope, state, getNodeLine, node, 'body');
    return;
  }

  if (node.type === 'ImportDeclaration') return;
  if (isFunctionNode(node))
    return walkFunctionNode(node, scope, state, getNodeLine);
  if (node.type === 'BlockStatement' || node.type === 'CatchClause') {
    return walkBlockLikeNode(node, scope, state, getNodeLine);
  }

  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    bind(scope, node.id?.name, { kind: 'local' });
  }

  if (node.type === 'VariableDeclaration')
    return walkVariableDeclaration(node, scope, state, getNodeLine);
  if (handleCjsReexportAssignment(node, state, getNodeLine)) return;
  if (handleThenDynamicImport(node, scope, state, getNodeLine)) return;
  if (handleDirectRequireMemberExpression(node, state, getNodeLine)) return;
  if (handleImportMetaGlobExpression(node, state, getNodeLine)) return;
  if (handleTrackedMemberExpression(node, scope, parent, key, getNodeLine))
    return;
  if (handleFallbackImportExpression(node, state, getNodeLine)) return;
  if (handleFallbackRequireExpression(node, state, getNodeLine, parent)) return;
  if (handleOpaqueRequireExpression(node, state, getNodeLine)) return;
  if (handleTrackedIdentifier(node, scope, parent, key)) return;

  walkChildNodes(node, scope, state, getNodeLine);
}

function isFunctionNode(node) {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  );
}

function walkFunctionNode(node, scope, state, getNodeLine) {
  if (node.type === 'FunctionDeclaration')
    bind(scope, node.id?.name, { kind: 'local' });
  const fnScope = makeScope(scope);
  if (node.type === 'FunctionExpression')
    bind(fnScope, node.id?.name, { kind: 'local' });
  for (const param of node.params ?? [])
    bindPattern(fnScope, param, { kind: 'local' });
  walkMemberPrecision(node.body, fnScope, state, getNodeLine, node, 'body');
}

function walkBlockLikeNode(node, scope, state, getNodeLine) {
  const blockScope = makeScope(scope);
  if (node.type === 'CatchClause')
    bindPattern(blockScope, node.param, { kind: 'local' });
  const body = node.type === 'BlockStatement' ? node.body : [node.body];
  walkNodeList(body, blockScope, state, getNodeLine, node, 'body');
}

function walkVariableDeclaration(node, scope, state, getNodeLine) {
  for (const decl of node.declarations ?? []) {
    const requireSpec = literalRequireSource(decl.init);
    if (requireSpec) {
      state.handledCjsRequires.add(decl.init);
      if (decl.id?.type === 'ObjectPattern') {
        collectCjsDestructuringUses(
          decl.id,
          requireSpec,
          state,
          getNodeLine(decl.init),
        );
        bindPattern(scope, decl.id, { kind: 'local' });
      } else if (decl.id?.type === 'Identifier') {
        if (node.kind === 'const') {
          bind(
            scope,
            decl.id.name,
            makeTracked(state, 'cjs', {
              fromSpec: requireSpec,
              typeOnly: false,
              line: getNodeLine(decl.init),
              localName: decl.id.name,
              node: decl.init,
            }),
          );
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
    } else if (
      decl.id?.type === 'ObjectPattern' &&
      decl.init?.type === 'Identifier'
    ) {
      const record = resolveBinding(scope, decl.init.name);
      if (record?.kind === 'cjs') {
        collectCjsAliasDestructuringUses(decl.id, record, getNodeLine);
        bindPattern(scope, decl.id, { kind: 'local' });
      } else {
        bindPattern(scope, decl.id, { kind: 'local' });
        walkMemberPrecision(decl.init, scope, state, getNodeLine, decl, 'init');
      }
    } else {
      bindPattern(scope, decl.id, { kind: 'local' });
      walkMemberPrecision(decl.init, scope, state, getNodeLine, decl, 'init');
    }
  }
}

function collectCjsAliasDestructuringUses(pattern, record, getNodeLine) {
  for (const prop of pattern.properties ?? []) {
    if (prop?.type === 'Property') {
      const key = prop.key;
      const name =
        key?.type === 'Identifier' || key?.type === 'Literal'
          ? String(key.name ?? key.value)
          : null;
      if (name) record.members.push({ name, line: getNodeLine(prop) });
      else record.degraded = true;
    } else if (prop?.type === 'RestElement') {
      record.degraded = true;
    }
  }
}

function collectCjsDestructuringUses(pattern, fromSpec, state, line) {
  for (const prop of pattern.properties ?? []) {
    if (prop?.type === 'Property') {
      const key = prop.key;
      const name =
        key?.type === 'Identifier' || key?.type === 'Literal'
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
  if (node.object?.type === 'Identifier' && node.object.name === 'exports')
    return !!prop;
  return (
    node.object?.type === 'Identifier' &&
    node.object.name === 'module' &&
    prop === 'exports'
  );
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
  if (node.type !== 'MemberExpression') return false;
  const fromSpec = literalRequireSource(node.object);
  if (!fromSpec) return false;
  state.handledCjsRequires.add(node.object);
  const name = staticMemberPropertyName(node);
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
  if (
    node.type !== 'CallExpression' ||
    node.callee?.type !== 'MemberExpression' ||
    node.callee.computed ||
    memberPropertyName(node.callee) !== 'then'
  )
    return false;

  const importNode = node.callee.object;
  const fromSpec = literalImportSource(importNode);
  const callback = node.arguments?.[0];
  const param = callback?.params?.[0];
  if (!fromSpec || param?.type !== 'Identifier' || !isFunctionNode(callback))
    return false;

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
  walkMemberPrecision(
    callback.body,
    callbackScope,
    state,
    getNodeLine,
    callback,
    'body',
  );
  state.handledDynamicImports.add(importNode);
  return true;
}

function handleTrackedMemberExpression(node, scope, parent, key, getNodeLine) {
  if (node.type !== 'MemberExpression' || node.object?.type !== 'Identifier')
    return false;
  const record = resolveBinding(scope, node.object.name);
  if (
    record?.kind !== 'namespace' &&
    record?.kind !== 'named-import' &&
    record?.kind !== 'dynamic' &&
    record?.kind !== 'cjs'
  )
    return false;

  if (record.kind === 'cjs') {
    if (isMutatingMemberAccess(parent, key)) {
      record.degraded = true;
      return true;
    }
    const name = staticMemberPropertyName(node);
    if (name) record.members.push({ name, line: getNodeLine(node) });
    else record.degraded = true;
    return true;
  }

  if (record.kind === 'named-import') {
    if (isMutatingMemberAccess(parent, key)) {
      record.degraded = true;
      return true;
    }
    const name = staticMemberPropertyName(node);
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
    state.fallbackDynamicImports.push({
      node,
      fromSpec,
      line: getNodeLine(node),
    });
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

function handleImportMetaGlobExpression(node, state, getNodeLine) {
  if (!isImportMetaGlobCall(node)) return false;
  const pattern = importMetaGlobPattern(node);
  if (!pattern) {
    state.importMetaGlobUses.push({
      fromSpec: 'import.meta.glob(<nonliteral>)',
      name: '*',
      kind: 'import-meta-glob',
      typeOnly: false,
      line: getNodeLine(node),
      dynamic: true,
      degraded: true,
      reason: 'import-meta-glob-nonliteral-unsupported',
      resolverStage: 'import-meta-glob',
      outputLevel: 'unsupported',
      unsupportedFamily: 'dynamic-modules',
      hint: 'dynamic-module-surface',
    });
    return true;
  }
  state.importMetaGlobUses.push({
    fromSpec: pattern,
    name: '*',
    kind: 'import-meta-glob',
    typeOnly: false,
    line: getNodeLine(node),
    dynamic: true,
    degraded: true,
    reason: 'import-meta-glob-unsupported',
    resolverStage: 'import-meta-glob',
    outputLevel: 'unsupported',
    unsupportedFamily: 'dynamic-modules',
    hint: 'dynamic-module-surface',
    affectedDir: affectedDirFromGlobPattern(pattern),
  });
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

function handleOpaqueRequireExpression(node, state, getNodeLine) {
  if (state.handledCjsRequires.has(node)) return false;
  const hint = opaqueCjsRequireHint(node);
  if (!hint) return false;
  state.cjsRequireOpacity.push({
    line: getNodeLine(node),
    ...hint,
  });
  state.handledCjsRequires.add(node);
  return true;
}

function handleTrackedIdentifier(node, scope, parent, key) {
  if (node.type !== 'Identifier') return false;
  const record = resolveBinding(scope, node.name);
  if (
    record?.kind === 'namespace' ||
    record?.kind === 'named-import' ||
    record?.kind === 'dynamic' ||
    record?.kind === 'cjs'
  ) {
    if (isNonEscapingTrackedIdentifierRead(parent, key)) return true;
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
    if (childKey === 'type' || childKey === 'start' || childKey === 'end')
      continue;
    const v = node[childKey];
    if (Array.isArray(v)) {
      walkNodeList(
        v.filter((child) => child && typeof child === 'object' && child.type),
        scope,
        state,
        getNodeLine,
        node,
        childKey,
      );
    } else if (v && typeof v === 'object' && typeof v.type === 'string') {
      walkMemberPrecision(v, scope, state, getNodeLine, node, childKey);
    }
  }
}

function emitMemberPrecisionUses(state) {
  return [
    ...emitNamespaceRecordUses(state.namespaceRecords),
    ...emitNamedImportRecordUses(state.namedImportRecords),
    ...(state.importMetaGlobUses ?? []),
    ...emitDynamicRecordUses(state),
    ...emitFallbackDynamicUses(state),
    ...emitCjsUses(state),
  ];
}

function emitNamedImportRecordUses(namedImportRecords) {
  const uses = [];
  for (const record of namedImportRecords) {
    if (record.members.length > 0 && !record.degraded) {
      for (const member of record.members) {
        uses.push({
          fromSpec: record.fromSpec,
          name: record.importedName,
          memberName: member.name,
          kind: 'imported-namespace-member',
          typeOnly: record.typeOnly,
          line: member.line,
          localName: record.localName,
        });
      }
    } else if (record.degraded) {
      uses.push({
        fromSpec: record.fromSpec,
        name: record.importedName,
        kind: 'imported-namespace-escape',
        typeOnly: record.typeOnly,
        line: record.line,
        localName: record.localName,
        degraded: true,
      });
    }
  }
  return uses;
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
  const artifactFilePath = options.artifactFilePath ?? filePath;
  const {
    defs,
    uses,
    reExports,
    namespaceImports,
    namedImports,
    cjsExportSurface,
    classMethods,
    localOperations,
  } = collectTopLevelSymbols(result.program, getNodeLine, artifactFilePath);
  const memberPrecision = collectMemberPrecisionUses(
    result.program,
    namespaceImports,
    namedImports,
    getNodeLine,
  );
  uses.push(...memberPrecision.uses);
  const typeEscapePath = artifactFilePath;
  const typeEscapeResult = extractTypeEscapes(src, typeEscapePath);

  return {
    filePath,
    defs,
    uses,
    reExports,
    classMethods,
    localOperations,
    typeEscapes: typeEscapeResult.typeEscapes ?? [],
    loc: src.split('\n').length,
    ...(cjsExportSurface ? { cjsExportSurface } : {}),
    ...(memberPrecision.opaqueDynamicImports.length > 0
      ? { dynamicImportOpacity: memberPrecision.opaqueDynamicImports }
      : {}),
    ...(memberPrecision.cjsRequireOpacity.length > 0
      ? { cjsRequireOpacity: memberPrecision.cjsRequireOpacity }
      : {}),
  };
}
