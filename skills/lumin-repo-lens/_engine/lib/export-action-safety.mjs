// Proof-carrying safe action selection for dead-export findings.
//
// This module deliberately separates deadness from edit safety. A symbol can be
// externally unused while its declaration is still needed locally, or while its
// initializer must keep running. In those cases the safe action is usually
// export demotion, not declaration deletion.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { producerMetaBase } from './artifacts.mjs';
import { countFileReferencesAst } from './classify-facts.mjs';
import { parseOxcOrThrow } from './parse-oxc.mjs';

const DECLARATION_NODE_KINDS = new Set([
  'FunctionDeclaration',
  'ClassDeclaration',
  'VariableDeclaration',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
]);

function findingId(p) {
  return `dead-export:${p.file}:${p.symbol}:${p.line}`;
}

function definitionId(file, node) {
  return `${file}#${node.type}:${node.start}-${node.end}`;
}

function readSource(root, relFile) {
  return readFileSync(path.join(root, relFile), 'utf8');
}

function nameOfId(id) {
  return id?.name ?? id?.value ?? null;
}

function bindingNames(pattern, out = []) {
  if (!pattern || typeof pattern !== 'object') return out;
  if (pattern.type === 'Identifier' || pattern.type === 'BindingIdentifier') {
    if (pattern.name) out.push(pattern.name);
    return out;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties ?? []) {
      if (prop.type === 'RestElement') bindingNames(prop.argument, out);
      else bindingNames(prop.value ?? prop.argument ?? prop.key, out);
    }
    return out;
  }
  if (pattern.type === 'ArrayPattern') {
    for (const el of pattern.elements ?? []) bindingNames(el, out);
    return out;
  }
  if (pattern.type === 'AssignmentPattern') {
    bindingNames(pattern.left, out);
    return out;
  }
  if (pattern.type === 'RestElement') {
    bindingNames(pattern.argument, out);
    return out;
  }
  return out;
}

function declarationNames(decl) {
  if (!decl) return [];
  if (decl.type === 'VariableDeclaration') {
    return (decl.declarations ?? []).flatMap((d) => bindingNames(d.id));
  }
  const id = decl.id ?? decl.name;
  const name = nameOfId(id);
  return name ? [name] : [];
}

function exportedNameOfSpecifier(spec) {
  return nameOfId(spec.exported) ?? nameOfId(spec.local);
}

function localNameOfSpecifier(spec) {
  return nameOfId(spec.local) ?? nameOfId(spec.exported);
}

function candidateSymbol(p) {
  return p.localName ?? p.symbol;
}

function isExportNode(node) {
  return node?.type === 'ExportNamedDeclaration' ||
         node?.type === 'ExportDefaultDeclaration' ||
         node?.type === 'ExportAllDeclaration';
}

function topLevelImportOrExportNodes(program) {
  return (program.body ?? []).filter((node) =>
    node.type === 'ImportDeclaration' || isExportNode(node));
}

function wouldRemoveLastModuleMarker(program, exportNode) {
  const io = topLevelImportOrExportNodes(program);
  return io.length === 1 && io[0] === exportNode;
}

function markerEditIfNeeded(program, exportNode) {
  if (!wouldRemoveLastModuleMarker(program, exportNode)) return [];
  return [{ kind: 'insert', text: 'export {};\n', position: 'eof' }];
}

function baseActionFields({ kind, proposal, targetNode, edits, actionGroupId, requiresModuleMarker, strongerActionBlockers = [] }) {
  return {
    kind,
    proofComplete: true,
    actionGroupId,
    target: {
      file: proposal.file,
      symbol: proposal.symbol,
      nodeKind: targetNode?.type ?? proposal.kind ?? null,
      definitionId: targetNode ? definitionId(proposal.file, targetNode) : null,
    },
    edits,
    requiresModuleMarker,
    preservesModuleSyntax: true,
    preservesSideEffects: true,
    preservesTypes: true,
    actionBlockers: [],
    strongerActionBlockers,
    notes: [],
  };
}

function removeExportTokenEdit(exportNode) {
  return { kind: 'remove-token', token: 'export', range: [exportNode.start, exportNode.start + 6] };
}

function deleteNodeEdit(node) {
  return { kind: 'delete-range', range: [node.start, node.end] };
}

function removeSpecifierEdit(spec) {
  return { kind: 'remove-specifier', range: [spec.start, spec.end] };
}

function isLiteralLike(node) {
  return node?.type === 'Literal';
}

function isDeleteSafeExpression(node) {
  if (!node) return true;
  if (isLiteralLike(node)) return true;
  if (node.type === 'TemplateLiteral') return (node.expressions ?? []).length === 0;
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') return true;
  if (node.type === 'ClassExpression') return !classHasDeleteUnsafeShape(node);
  if (node.type === 'ArrayExpression') {
    for (const el of node.elements ?? []) {
      if (el === null) continue;
      if (el.type === 'SpreadElement') return false;
      if (!isDeleteSafeExpression(el)) return false;
    }
    return true;
  }
  if (node.type === 'ObjectExpression') {
    for (const prop of node.properties ?? []) {
      if (!prop) continue;
      if (prop.type === 'SpreadElement') return false;
      if (prop.computed || prop.method || prop.shorthand) return false;
      if (prop.kind === 'get' || prop.kind === 'set') return false;
      if (!isDeleteSafeExpression(prop.value)) return false;
    }
    return true;
  }
  return false;
}

function expressionBlocker(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return 'identifier-initializer';
  if (node.type === 'CallExpression' ||
      node.type === 'NewExpression' ||
      node.type === 'AwaitExpression' ||
      node.type === 'TaggedTemplateExpression' ||
      node.type === 'AssignmentExpression' ||
      node.type === 'UpdateExpression') {
    return 'side-effect-initializer';
  }
  if (node.type === 'TemplateLiteral' && (node.expressions ?? []).length > 0) {
    return 'side-effect-initializer';
  }
  if (node.type === 'ArrayExpression') {
    for (const el of node.elements ?? []) {
      if (el === null) continue;
      if (el.type === 'SpreadElement') return 'side-effect-initializer';
      const b = expressionBlocker(el);
      if (b) return b;
    }
  }
  if (node.type === 'ObjectExpression') {
    for (const prop of node.properties ?? []) {
      if (!prop) continue;
      if (prop.type === 'SpreadElement' || prop.computed || prop.method ||
          prop.shorthand || prop.kind === 'get' || prop.kind === 'set') {
        return 'side-effect-initializer';
      }
      const b = expressionBlocker(prop.value);
      if (b) return b;
    }
  }
  if (!isDeleteSafeExpression(node)) return 'side-effect-initializer';
  return null;
}

function classHasDeleteUnsafeShape(node) {
  if (!node) return false;
  if ((node.decorators ?? []).length > 0) return true;
  if (node.superClass) return true;
  for (const el of node.body?.body ?? []) {
    if (el.type === 'StaticBlock') return true;
    if (el.computed) return true;
    if (el.static && el.value) return true;
    if ((el.decorators ?? []).length > 0) return true;
  }
  return false;
}

function classBlockers(node) {
  const blockers = [];
  if ((node.decorators ?? []).length > 0) blockers.push('decorator-present');
  if (node.superClass) blockers.push('class-extends');
  for (const el of node.body?.body ?? []) {
    if (el.type === 'StaticBlock') blockers.push('class-static-block');
    if (el.computed) blockers.push('class-computed-member');
    if (el.static && el.value) blockers.push('class-static-field');
    if ((el.decorators ?? []).length > 0) blockers.push('decorator-present');
  }
  return [...new Set(blockers)];
}

function groupId(file, node) {
  return `${file}:${node.type}:${node.start}-${node.end}`;
}

function nullActionRecord(proposal, actionBlockers, extra = {}) {
  return {
    id: findingId(proposal),
    file: proposal.file,
    line: proposal.line,
    symbol: proposal.symbol,
    kind: proposal.kind,
    bucket: proposal.bucket,
    safeAction: null,
    actionBlockers,
    ...extra,
  };
}

function concreteActionRecord(proposal, safeAction, extra = {}) {
  return {
    id: findingId(proposal),
    file: proposal.file,
    line: proposal.line,
    symbol: proposal.symbol,
    kind: proposal.kind,
    bucket: proposal.bucket,
    safeAction,
    actionBlockers: [],
    ...extra,
  };
}

function localReferenceInfo(src, relFile, proposal) {
  try {
    return countFileReferencesAst(src, relFile, candidateSymbol(proposal), proposal.line);
  } catch {
    return { count: 1, typeRefs: 0, valueRefs: 1, evidence: 'ast-count-failed' };
  }
}

function declarationMergeBlocker(fileInfo, name) {
  const count = fileInfo.nameCounts.get(name) ?? 0;
  return count > 1;
}

function buildFileInfo(root, relFile) {
  const src = readSource(root, relFile);
  const ast = parseOxcOrThrow(relFile, src).program;
  const nameCounts = new Map();
  for (const node of ast.body ?? []) {
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      for (const name of declarationNames(node.declaration)) {
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
    }
  }
  return { src, ast, nameCounts };
}

function findMatchingExport(fileInfo, proposal) {
  const wanted = candidateSymbol(proposal);
  for (const node of fileInfo.ast.body ?? []) {
    if (node.type === 'ExportAllDeclaration') {
      if (nameOfId(node.exported) === proposal.symbol) {
        return { exportNode: node, sourceReExport: true, targetNode: node };
      }
      continue;
    }
    if (node.type === 'ExportDefaultDeclaration') {
      if (proposal.symbol === 'default') {
        return { exportNode: node, defaultExport: true, targetNode: node.declaration ?? node };
      }
      continue;
    }
    if (node.type !== 'ExportNamedDeclaration') continue;
    if (node.source) {
      const spec = (node.specifiers ?? []).find((s) =>
        exportedNameOfSpecifier(s) === proposal.symbol ||
        localNameOfSpecifier(s) === wanted);
      if (spec) return { exportNode: node, specifier: spec, sourceReExport: true, targetNode: spec };
      continue;
    }
    if (node.declaration) {
      const names = declarationNames(node.declaration);
      if (names.includes(wanted) || names.includes(proposal.symbol)) {
        let declarator = null;
        if (node.declaration.type === 'VariableDeclaration') {
          declarator = (node.declaration.declarations ?? []).find((d) =>
            bindingNames(d.id).includes(wanted) || bindingNames(d.id).includes(proposal.symbol));
        }
        return {
          exportNode: node,
          declaration: node.declaration,
          declarator,
          targetNode: declarator ?? node.declaration,
          declarationNames: names,
        };
      }
      continue;
    }
    const spec = (node.specifiers ?? []).find((s) =>
      exportedNameOfSpecifier(s) === proposal.symbol ||
      localNameOfSpecifier(s) === wanted);
    if (spec) return { exportNode: node, specifier: spec, targetNode: spec };
  }
  return null;
}

function chooseDeclarationAction({ proposal, match, fileInfo, deadSymbols }) {
  const { declaration: decl, exportNode } = match;
  if (!decl || !DECLARATION_NODE_KINDS.has(decl.type)) {
    return nullActionRecord(proposal, ['unrecognized-export-form']);
  }

  const requiresModuleMarker = wouldRemoveLastModuleMarker(fileInfo.ast, exportNode);
  const markerEdits = markerEditIfNeeded(fileInfo.ast, exportNode);
  const localRefs = localReferenceInfo(fileInfo.src, proposal.file, proposal);
  const hasLocalRefs = (localRefs.count ?? 0) > 0;
  const stronger = [];
  if (hasLocalRefs) stronger.push('local-refs-present');

  if (declarationMergeBlocker(fileInfo, candidateSymbol(proposal))) {
    return nullActionRecord(proposal, ['declaration-merge-partner']);
  }

  if (decl.type === 'VariableDeclaration') {
    const names = declarationNames(decl);
    const partialMulti = names.length > 1 && !names.every((name) => deadSymbols.has(name));
    if (partialMulti) return nullActionRecord(proposal, ['partial-multi-declarator']);
    const init = match.declarator?.init ?? null;
    const b = expressionBlocker(init);
    if (b) stronger.push(b);
    const canDelete = !hasLocalRefs && !b && isDeleteSafeExpression(init);
    if (canDelete) {
      const edits = [deleteNodeEdit(exportNode), ...markerEdits];
      const safeAction = baseActionFields({
        kind: 'delete_value_declaration',
        proposal,
        exportNode,
        targetNode: match.targetNode,
        edits,
        actionGroupId: groupId(proposal.file, decl),
        requiresModuleMarker,
        strongerActionBlockers: stronger,
      });
      return concreteActionRecord(proposal, safeAction, { localUseProof: localRefs });
    }
    const edits = [removeExportTokenEdit(exportNode), ...markerEdits];
    const safeAction = baseActionFields({
      kind: 'demote_export_declaration',
      proposal,
      exportNode,
      targetNode: match.targetNode,
      edits,
      actionGroupId: groupId(proposal.file, decl),
      requiresModuleMarker,
      strongerActionBlockers: [...new Set(stronger)],
    });
    return concreteActionRecord(proposal, safeAction, { localUseProof: localRefs });
  }

  if (decl.type === 'TSInterfaceDeclaration' || decl.type === 'TSTypeAliasDeclaration') {
    if (!hasLocalRefs) {
      const edits = [deleteNodeEdit(exportNode), ...markerEdits];
      const safeAction = baseActionFields({
        kind: 'delete_type_declaration',
        proposal,
        exportNode,
        targetNode: match.targetNode,
        edits,
        actionGroupId: groupId(proposal.file, decl),
        requiresModuleMarker,
        strongerActionBlockers: [],
      });
      return concreteActionRecord(proposal, safeAction, { localUseProof: localRefs });
    }
    const edits = [removeExportTokenEdit(exportNode), ...markerEdits];
    const safeAction = baseActionFields({
      kind: 'demote_export_declaration',
      proposal,
      exportNode,
      targetNode: match.targetNode,
      edits,
      actionGroupId: groupId(proposal.file, decl),
      requiresModuleMarker,
      strongerActionBlockers: [...new Set(stronger)],
    });
    return concreteActionRecord(proposal, safeAction, { localUseProof: localRefs });
  }

  if (decl.type === 'ClassDeclaration') {
    stronger.push(...classBlockers(decl));
  }
  if (decl.type === 'TSEnumDeclaration') {
    stronger.push('ts-enum-emit-mode');
  }

  const canDeleteValue =
    !hasLocalRefs &&
    (decl.type === 'FunctionDeclaration' ||
     (decl.type === 'ClassDeclaration' && !classHasDeleteUnsafeShape(decl)));

  if (canDeleteValue) {
    const edits = [deleteNodeEdit(exportNode), ...markerEdits];
    const safeAction = baseActionFields({
      kind: 'delete_value_declaration',
      proposal,
      exportNode,
      targetNode: match.targetNode,
      edits,
      actionGroupId: groupId(proposal.file, decl),
      requiresModuleMarker,
      strongerActionBlockers: [...new Set(stronger)],
    });
    return concreteActionRecord(proposal, safeAction, { localUseProof: localRefs });
  }

  const edits = [removeExportTokenEdit(exportNode), ...markerEdits];
  const safeAction = baseActionFields({
    kind: 'demote_export_declaration',
    proposal,
    exportNode,
    targetNode: match.targetNode,
    edits,
    actionGroupId: groupId(proposal.file, decl),
    requiresModuleMarker,
    strongerActionBlockers: [...new Set(stronger)],
  });
  return concreteActionRecord(proposal, safeAction, { localUseProof: localRefs });
}

function chooseSpecifierAction({ proposal, match, fileInfo }) {
  if (match.sourceReExport) {
    return nullActionRecord(proposal, ['re-export-from-source']);
  }
  if (match.defaultExport) {
    return nullActionRecord(proposal, ['default-export']);
  }
  if (!match.specifier) {
    return nullActionRecord(proposal, ['unrecognized-export-form']);
  }
  const exportNode = match.exportNode;
  const specifiers = exportNode.specifiers ?? [];
  const removesStatement = specifiers.length <= 1;
  const requiresModuleMarker = removesStatement && wouldRemoveLastModuleMarker(fileInfo.ast, exportNode);
  const edits = [
    removesStatement ? deleteNodeEdit(exportNode) : removeSpecifierEdit(match.specifier),
    ...(requiresModuleMarker ? markerEditIfNeeded(fileInfo.ast, exportNode) : []),
  ];
  const safeAction = baseActionFields({
    kind: 'remove_export_specifier',
    proposal,
    exportNode,
    targetNode: match.targetNode,
    edits,
    actionGroupId: groupId(proposal.file, exportNode),
    requiresModuleMarker,
    strongerActionBlockers: [],
  });
  return concreteActionRecord(proposal, safeAction);
}

function chooseAction({ proposal, fileInfo, deadSymbols }) {
  const match = findMatchingExport(fileInfo, proposal);
  if (!match) return nullActionRecord(proposal, ['export-form-not-found']);
  if (match.sourceReExport || match.defaultExport || match.specifier || match.exportNode.type === 'ExportAllDeclaration') {
    return chooseSpecifierAction({ proposal, match, fileInfo });
  }
  return chooseDeclarationAction({ proposal, match, fileInfo, deadSymbols });
}

function proposalBuckets(deadClassify) {
  return [
    ...(deadClassify.proposal_C_remove_symbol ?? []).map((p) => ({ ...p, bucket: 'C' })),
    ...(deadClassify.proposal_A_demote_to_internal ?? []).map((p) => ({ ...p, bucket: 'A' })),
    ...(deadClassify.proposal_remove_export_specifier ?? []).map((p) => ({ ...p, bucket: 'specifier' })),
  ];
}

function deadSymbolsByFile(proposals) {
  const out = new Map();
  for (const p of proposals) {
    if (!out.has(p.file)) out.set(p.file, new Set());
    out.get(p.file).add(candidateSymbol(p));
    out.get(p.file).add(p.symbol);
  }
  return out;
}

export function buildExportActionSafetyArtifact({ root, deadClassify }) {
  const proposals = proposalBuckets(deadClassify);
  const byFileSymbols = deadSymbolsByFile(proposals);
  const fileCache = new Map();
  const findings = [];
  const warnings = [];

  for (const proposal of proposals) {
    try {
      let fileInfo = fileCache.get(proposal.file);
      if (!fileInfo) {
        fileInfo = buildFileInfo(root, proposal.file);
        fileCache.set(proposal.file, fileInfo);
      }
      const rec = chooseAction({
        proposal,
        fileInfo,
        deadSymbols: byFileSymbols.get(proposal.file) ?? new Set(),
      });
      findings.push(rec);
    } catch (e) {
      warnings.push({ file: proposal.file, symbol: proposal.symbol, message: e.message });
      findings.push(nullActionRecord(proposal, ['action-safety-parse-error']));
    }
  }

  const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
  return {
    meta: {
      ...producerMetaBase({ tool: 'export-action-safety.mjs', root }),
      schemaVersion: 1,
      total: findings.length,
      warnings,
    },
    findings,
    byId,
  };
}
