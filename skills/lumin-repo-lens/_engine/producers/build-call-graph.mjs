// build-call-graph.mjs — Identifier-based cross-file call graph (parameterized)
// Level 1: named import + same-file identifier call → cross-file edge
// Analysis: top callee, semi-dead imports, feature envy, prototype access distribution
//
// Usage: node build-call-graph.mjs --root <repo> [--output <dir>]

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canContainJsx } from '../lib/lang.mjs';
import { parseOxcOrThrow } from '../lib/parse-oxc.mjs';
import { parseCliArgs } from '../lib/cli.mjs';
import { detectRepoMode } from '../lib/repo-mode.mjs';
import { buildAliasMap } from '../lib/alias-map.mjs';
import { makeResolver, isResolvedFile } from '../lib/resolver-core.mjs';
import { collectFiles as collectFilesShared } from '../lib/collect-files.mjs';
import { relPath } from '../lib/paths.mjs';
import { definitionIdFromOxcNode } from '../lib/definition-id.mjs';
import {
  buildExportedObjectMaps,
  staticMemberPropertyName,
} from '../lib/call-graph-bounded.mjs';
import { createProducerPhaseTimer } from '../lib/producer-phase-timing.mjs';

const cli = parseCliArgs();
const { root: ROOT, output } = cli;
const phaseTimer = createProducerPhaseTimer({
  producer: 'build-call-graph.mjs',
  output,
});

const repoMode = detectRepoMode(ROOT);
const aliasMap = buildAliasMap(ROOT, repoMode, { exclude: cli.exclude });
const _resolveRaw = makeResolver(ROOT, aliasMap);
const resolveSpecifier = (from, spec) => {
  const r = _resolveRaw(from, spec);
  // Treat sentinels (EXTERNAL / UNRESOLVED_INTERNAL) as "no file" for the
  // call graph — the downstream consumer expects either a real path or null.
  return isResolvedFile(r) ? r : null;
};

function collectFiles() {
  return collectFilesShared(ROOT, { includeTests: cli.includeTests, exclude: cli.exclude });
}

function parseErrorRecord(filePath, error) {
  return {
    file: relPath(ROOT, filePath),
    message: String(error?.message ?? error ?? 'unknown parse error').split('\n')[0],
  };
}

function callGraphWarnings(parseErrorDetails) {
  if (parseErrorDetails.length === 0) return [];
  return [{
    kind: 'parse-errors',
    code: 'call-graph-parse-errors',
    count: parseErrorDetails.length,
    message: `${parseErrorDetails.length} file(s) failed to parse; call graph is partial`,
    files: parseErrorDetails,
  }];
}

function walk(node, visitor, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visitor(node, parent);
  for (const key in node) {
    if (key === 'parent') continue;
    const c = node[key];
    if (Array.isArray(c)) {
      for (const x of c) if (x && typeof x === 'object' && x.type) walk(x, visitor, node);
    } else if (c && typeof c === 'object' && c.type) walk(c, visitor, node);
  }
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
  }
  return out;
}

function isTypeDeclaration(node) {
  return node?.type === 'TSInterfaceDeclaration' ||
    node?.type === 'TSTypeAliasDeclaration' ||
    node?.type === 'TSEnumDeclaration' ||
    node?.type === 'TSModuleDeclaration';
}

function collectLocalDeclarationTargets(program) {
  const out = new Map();
  for (const node of program.body ?? []) {
    const declaration = node.type === 'ExportNamedDeclaration' && node.declaration
      ? node.declaration
      : node;
    if (!declaration || typeof declaration !== 'object') continue;

    if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
      if (declaration.id?.name && !out.has(declaration.id.name)) out.set(declaration.id.name, declaration);
      continue;
    }

    if (declaration.type === 'VariableDeclaration') {
      for (const decl of declaration.declarations ?? []) {
        if (decl.id?.type === 'Identifier' && !out.has(decl.id.name)) out.set(decl.id.name, decl);
      }
      continue;
    }

    if (isTypeDeclaration(declaration) && declaration.id?.name && !out.has(declaration.id.name)) {
      out.set(declaration.id.name, declaration);
    }
  }
  return out;
}

function declarationExportIds(relFile, declaration) {
  const out = new Map();
  if (!declaration) return out;

  if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
    if (declaration.id?.name) out.set(declaration.id.name, definitionIdFromOxcNode(relFile, declaration));
    return out;
  }

  if (declaration.type === 'VariableDeclaration') {
    for (const decl of declaration.declarations ?? []) {
      for (const name of bindingNames(decl.id)) {
        out.set(name, definitionIdFromOxcNode(relFile, decl));
      }
    }
    return out;
  }

  if (isTypeDeclaration(declaration) && declaration.id?.name) {
    out.set(declaration.id.name, definitionIdFromOxcNode(relFile, declaration));
  }
  return out;
}

function collectExportAliasMap(program, relFile) {
  const localDeclarations = collectLocalDeclarationTargets(program);
  const exportAliases = new Map();

  for (const node of program.body ?? []) {
    if (node.type === 'ExportDefaultDeclaration') {
      exportAliases.set('default', definitionIdFromOxcNode(relFile, node.declaration ?? node));
      continue;
    }

    if (node.type !== 'ExportNamedDeclaration' || node.source) continue;

    if (node.declaration) {
      for (const [name, definitionId] of declarationExportIds(relFile, node.declaration)) {
        if (definitionId) exportAliases.set(name, definitionId);
      }
      continue;
    }

    for (const spec of node.specifiers ?? []) {
      if (spec.type !== 'ExportSpecifier') continue;
      const exportedName = nameOfId(spec.exported) ?? nameOfId(spec.local);
      const localName = nameOfId(spec.local) ?? exportedName;
      if (!exportedName) continue;
      const target = localDeclarations.get(localName) ?? spec;
      const definitionId = definitionIdFromOxcNode(relFile, target);
      if (definitionId) exportAliases.set(exportedName, definitionId);
    }
  }

  return exportAliases;
}

function rootIdentifierOfMemberExpression(node) {
  let current = node;
  while (current?.type === 'MemberExpression') {
    current = current.object;
  }
  return current?.type === 'Identifier' ? current.name : null;
}

// ─── 파일별 분석 ─────────────────────────────────────────
function analyzeFile(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const result = parseOxcOrThrow(filePath, src);
  const relFile = relPath(ROOT, filePath);

  // import map: local name -> { source, imported, typeOnly }
  const importMap = new Map();
  for (const node of result.program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const isTypeImport = node.importKind === 'type';
    for (const spec of node.specifiers ?? []) {
      if (spec.type === 'ImportSpecifier') {
        importMap.set(spec.local.name, {
          source: node.source.value,
          imported: spec.imported?.name ?? spec.local.name,
          typeOnly: isTypeImport || spec.importKind === 'type',
          kind: 'named',
        });
      } else if (spec.type === 'ImportDefaultSpecifier') {
        importMap.set(spec.local.name, {
          source: node.source.value,
          imported: 'default',
          typeOnly: isTypeImport,
          kind: 'default',
        });
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        importMap.set(spec.local.name, {
          source: node.source.value,
          imported: '*',
          typeOnly: isTypeImport,
          kind: 'namespace',
        });
      }
    }
  }

  // call sites 수집
  // (a) callee가 Identifier → name 으로 매칭
  // (b) callee가 MemberExpression + object가 Identifier + object name이 namespace import면 해당 namespace의 method 호출
  // (c) X.prototype.Y 패턴
  const calls = []; // { calleeName, callSite: 'direct'|'namespace'|'prototype', line }
  const namespaceMethodCalls = []; // { nsName, method, line }
  const prototypeCalls = []; // { owner, method, line }
  const importedObjectMemberCalls = []; // { source, imported, method, start }

  let totalCallExpressions = 0;
  let memberCallCount = 0;
  let boundedOutMemberCalls = 0;

  walk(result.program, (node) => {
    if (node.type !== 'CallExpression') return;
    totalCallExpressions++;
    const callee = node.callee;
    if (!callee) return;

    // (a) direct identifier call
    if (callee.type === 'Identifier') {
      calls.push({ name: callee.name, kind: 'direct', start: node.start });
      return;
    }

    // (b) member call
    if (callee.type === 'MemberExpression') {
      memberCallCount++;
      const obj = callee.object;
      const propName = staticMemberPropertyName(callee);

      // X.prototype.Y(...) — MemberExpression -> object is MemberExpression with property.name='prototype'
      if (
        propName &&
        obj?.type === 'MemberExpression' &&
        !obj.computed &&
        obj.property?.name === 'prototype' &&
        obj.object?.type === 'Identifier'
      ) {
        prototypeCalls.push({
          owner: obj.object.name,
          method: propName,
          start: node.start,
        });
        return;
      }

      if (!propName) {
        const rootName = rootIdentifierOfMemberExpression(callee);
        if (rootName && importMap.has(rootName)) boundedOutMemberCalls++;
        return;
      }

      if (obj?.type === 'MemberExpression') {
        const rootName = rootIdentifierOfMemberExpression(obj);
        if (rootName && importMap.has(rootName)) boundedOutMemberCalls++;
        return;
      }

      // obj.method() — obj가 namespace import인 경우 추적
      if (obj?.type === 'Identifier') {
        const imp = importMap.get(obj.name);
        if (imp && imp.kind === 'namespace') {
          namespaceMethodCalls.push({
            nsName: obj.name,
            source: imp.source,
            method: propName,
            start: node.start,
          });
        } else if (imp && (imp.kind === 'default' || imp.kind === 'named')) {
          importedObjectMemberCalls.push({
            source: imp.source,
            imported: imp.imported,
            method: propName,
            start: node.start,
            typeOnly: imp.typeOnly,
          });
        }
      }
    }
  });

  return {
    filePath,
    importMap,
    exportAliasMap: collectExportAliasMap(result.program, relFile),
    exportedObjectMaps: buildExportedObjectMaps(result.program),
    calls,
    namespaceMethodCalls,
    importedObjectMemberCalls,
    prototypeCalls,
    memberCallCount,
    boundedOutMemberCalls,
    totalCallExpressions,
    loc: src.split('\n').length,
  };
}

// ─── 전체 스캔 ────────────────────────────────────────────
const files = phaseTimer.runPhase('collect-files', () => collectFiles());
console.log(`[scan] ${files.length} files`);

const fileInfo = new Map();
let parseErrors = 0;
const parseErrorDetails = [];
const analyzeFilesStarted = Date.now();
for (const f of files) {
  try {
    fileInfo.set(f, analyzeFile(f));
  } catch (error) {
    parseErrors++;
    parseErrorDetails.push(parseErrorRecord(f, error));
  }
}
phaseTimer.recordPhase('analyze-files', Date.now() - analyzeFilesStarted);
console.log(`[parse errors] ${parseErrors}`);

// ─── cross-file call edge 구축 ───────────────────────────
const assembleCallGraphStarted = Date.now();
const callEdges = []; // { from, to, callee, count }
const edgeMap = new Map(); // key: "from→to→callee" -> count
const boundedOutMemberCallsByAbsFile = new Map();

let totalDirectCalls = 0;
let resolvedDirectCalls = 0;
let typeOnlyResolved = 0;

function addCallEdge(from, to, callee, count = 1) {
  const key = `${from}→${to}→${callee}`;
  if (!edgeMap.has(key)) {
    edgeMap.set(key, { from, to, callee, count: 0 });
  }
  edgeMap.get(key).count += count;
}

function addBoundedOutMemberCall(file, count = 1) {
  boundedOutMemberCallsByAbsFile.set(file, (boundedOutMemberCallsByAbsFile.get(file) ?? 0) + count);
}

for (const [f, info] of fileInfo) {
  if (info.boundedOutMemberCalls > 0) addBoundedOutMemberCall(f, info.boundedOutMemberCalls);

  for (const c of info.calls) {
    if (c.kind !== 'direct') continue;
    totalDirectCalls++;
    const imp = info.importMap.get(c.name);
    if (!imp) continue; // 같은 파일 함수 또는 global
    if (imp.typeOnly) { typeOnlyResolved++; continue; }
    const targetFile = resolveSpecifier(f, imp.source);
    if (!targetFile) continue;
    resolvedDirectCalls++;
    addCallEdge(f, targetFile, imp.imported);
  }

  for (const c of info.importedObjectMemberCalls) {
    if (c.typeOnly) { typeOnlyResolved++; continue; }
    const targetFile = resolveSpecifier(f, c.source);
    if (!targetFile) {
      addBoundedOutMemberCall(f);
      continue;
    }
    const targetInfo = fileInfo.get(targetFile);
    const objectMap = targetInfo?.exportedObjectMaps?.get(c.imported);
    const target = objectMap?.get(c.method);
    if (!target?.calleeName) {
      addBoundedOutMemberCall(f);
      continue;
    }
    resolvedDirectCalls++;
    addCallEdge(f, targetFile, target.calleeName);
  }
}
for (const e of edgeMap.values()) callEdges.push(e);

console.log(`\n[direct calls] total ${totalDirectCalls}`);
console.log(`  resolved cross-file: ${resolvedDirectCalls}`);
console.log(`  type-only (skip): ${typeOnlyResolved}`);
console.log(`[call edges] ${callEdges.length} unique (from, to, callee) triples`);

// ─── Top callees (가장 많이 호출되는 심볼) ───────────────
const exportAliasMap = Object.create(null); // "relFile::exportedName" -> definitionId
const callFanInByIdentity = Object.create(null);
const callFanInByDefinitionId = Object.create(null);
const callSiteFanInByDefinitionId = Object.create(null);

for (const [absFile, info] of fileInfo) {
  const relFile = relPath(ROOT, absFile);
  for (const [exportedName, definitionId] of info.exportAliasMap ?? []) {
    const identity = `${relFile}::${exportedName}`;
    exportAliasMap[identity] = definitionId;
    callFanInByIdentity[identity] = 0;
    if (definitionId && callFanInByDefinitionId[definitionId] === undefined) {
      callFanInByDefinitionId[definitionId] = 0;
      callSiteFanInByDefinitionId[definitionId] = 0;
    }
  }
}

const calleeFreq = new Map(); // "targetFile::name" -> total call count
for (const e of callEdges) {
  const relTarget = relPath(ROOT, e.to);
  const k = `${relTarget}::${e.callee}`;
  calleeFreq.set(k, (calleeFreq.get(k) || 0) + e.count);
  callFanInByIdentity[k] = (callFanInByIdentity[k] ?? 0) + e.count;
  const definitionId = exportAliasMap[k];
  if (definitionId) {
    callFanInByDefinitionId[definitionId] = (callFanInByDefinitionId[definitionId] ?? 0) + e.count;
    callSiteFanInByDefinitionId[definitionId] = (callSiteFanInByDefinitionId[definitionId] ?? 0) + e.count;
  }
}
const topCallees = [...calleeFreq.entries()]
  .map(([k, n]) => {
    const [file, name] = k.split('::');
    return { file, name, count: n };
  })
  .sort((a, b) => b.count - a.count);

console.log(`\n════════ Top 25 callees (가장 많이 호출되는 함수) ════════`);
for (const c of topCallees.slice(0, 25)) {
  console.log(`  ${c.count.toString().padStart(4)}  ${c.name.padEnd(32)}  ${c.file}`);
}

const boundedOutMemberCallsByFile = Object.create(null);
const memberCallsByFile = Object.create(null);
for (const [absFile, info] of fileInfo) {
  const relFile = relPath(ROOT, absFile);
  memberCallsByFile[relFile] = info.memberCallCount ?? 0;
  boundedOutMemberCallsByFile[relFile] = boundedOutMemberCallsByAbsFile.get(absFile) ?? 0;
}

// ─── Semi-dead: import는 있지만 call이 0인 값 import ────
// 각 파일의 named/default import 중 값 (typeOnly false) + 같은 파일 안에서 호출/사용 0인 것
// "사용"을 다시 체크하려면 identifier reference 추적 필요. 간단화:
// - import된 local name이 direct call site에 한 번도 안 나옴 → 호출 안 함.
// - 단, JSX 컴포넌트로 쓰이거나, type annotation value position (as X) 등은 놓침.
// → "import 값인데 call 0"인 리스트만 추출. (false positive 있을 수 있음)

// v0.6.6 FP-19: React JSX-runtime imports are consumed implicitly by the
// JSX transform (classic runtime), not by source-text references.
// `import React from 'react'` appears exactly once (the import line)
// regardless of how many JSX elements render. Same pattern for common
// hooks that are invoked inside JSX expressions where the AST walker
// may miss the callsite. Skip these in `.tsx`/`.jsx` files to de-noise
// the semi-dead list.
const REACT_FRAMEWORK_NAMES = new Set([
  'React',
  'Fragment',
  'useState', 'useEffect', 'useCallback', 'useMemo', 'useRef',
  'useContext', 'useReducer', 'useLayoutEffect', 'useImperativeHandle',
  'useDebugValue', 'useTransition', 'useDeferredValue', 'useId',
  'useSyncExternalStore', 'useInsertionEffect',
  'forwardRef', 'memo', 'lazy', 'Suspense',
  'createContext', 'createRef', 'cloneElement', 'createElement',
  'Children', 'StrictMode',
]);
function isReactRuntimeImport(filePath, localName, source) {
  if (!canContainJsx(filePath)) return false;
  if (source !== 'react' && source !== 'react-dom' &&
      !source.startsWith('react/') && !source.startsWith('react-dom/')) return false;
  return REACT_FRAMEWORK_NAMES.has(localName);
}

let semiDeadCount = 0;
let reactSkipCount = 0; // FP-19 stat
const semiDead = [];
for (const [f, info] of fileInfo) {
  const calledNames = new Set(info.calls.filter(c => c.kind === 'direct').map(c => c.name));
  // namespace member 호출에서의 object name도 "사용"으로 카운트
  for (const nm of info.namespaceMethodCalls) calledNames.add(nm.nsName);
  // memberCalls의 object name도 사용
  for (const [obj, _] of (function*() {
    // dummy iterate — but memberCalls가 함수 밖에서 재수집 안 됨. 건너뜀.
  })()) calledNames.add(obj);

  // 추가 heuristic: import된 local name이 소스 텍스트에 얼마나 등장하는지 grep
  // (느리지만 정확도 ↑)

  for (const [localName, imp] of info.importMap) {
    if (imp.typeOnly) continue;
    if (imp.kind === 'namespace') continue; // namespace는 호출 위치 다름
    // call 위치에 없고, 또한 MemberExpression의 object로도 안 쓰임
    if (calledNames.has(localName)) continue;
    // 텍스트 기반 추가 체크 (JSX, as argument 등)
    const src = readFileSync(f, 'utf8');
    const re = new RegExp(`\\b${localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const hits = (src.match(re) || []).length;
    // import 라인에 최소 1번 등장. 2회 이상이면 사용됐다고 가정.
    if (hits >= 2) continue;
    // FP-19: React runtime imports in .tsx/.jsx are consumed by JSX transform.
    // Filter AFTER other checks so reactSkipCount measures true FP-19 rescues.
    if (isReactRuntimeImport(f, localName, imp.source)) {
      reactSkipCount++;
      continue;
    }
    semiDead.push({
      file: relPath(ROOT, f),
      symbol: localName,
      source: imp.source,
    });
    semiDeadCount++;
  }
}

console.log(`\n\n════════ Semi-dead import (값 import인데 호출/사용 0) ════════`);
console.log(`후보: ${semiDeadCount}건${reactSkipCount > 0 ? ` (FP-19 React JSX runtime 제외: ${reactSkipCount})` : ''}`);
for (const s of semiDead.slice(0, 20)) {
  console.log(`  ${s.file}  ${s.symbol}  (from "${s.source}")`);
}

// ─── Feature envy: 모듈 A가 모듈 B의 심볼을 과도하게 호출 ─
// package 단위보다 1단계 내려가 subdirectory 단위로 봄
function moduleOf(absPath) {
  const rel = relPath(ROOT, absPath);
  // 예: apps/daemon/src/daemon/agent/xxx.ts → apps/daemon/src/daemon/agent
  const parts = rel.split('/');
  if (parts.length <= 3) return parts.slice(0, 2).join('/');
  return parts.slice(0, -1).join('/');
}

const moduleCallCount = new Map(); // "from_module→to_module" -> count
for (const e of callEdges) {
  const fromMod = moduleOf(e.from);
  const toMod = moduleOf(e.to);
  if (fromMod === toMod) continue;
  const k = `${fromMod} → ${toMod}`;
  moduleCallCount.set(k, (moduleCallCount.get(k) || 0) + e.count);
}

console.log(`\n\n════════ Feature envy 상위 20 (cross-module call edge 많은 순) ════════`);
for (const [k, n] of [...moduleCallCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${n.toString().padStart(5)}  ${k}`);
}

// ─── prototype 패치 전체 분포 (레포 전체) ────────────────
let totalProtoCalls = 0;
const protoByFile = new Map();
const protoByOwner = new Map();
for (const [f, info] of fileInfo) {
  if (info.prototypeCalls.length === 0) continue;
  totalProtoCalls += info.prototypeCalls.length;
  protoByFile.set(f, info.prototypeCalls.length);
  for (const p of info.prototypeCalls) {
    if (!protoByOwner.has(p.owner)) protoByOwner.set(p.owner, new Map());
    const m = protoByOwner.get(p.owner);
    m.set(p.method, (m.get(p.method) || 0) + 1);
  }
}
console.log(`\n\n════════ X.prototype.Y() 호출 레포 전체 분포 ════════`);
console.log(`총 prototype method 호출: ${totalProtoCalls}`);
console.log(`\nowner별:`);
for (const [owner, methods] of [...protoByOwner.entries()].sort((a, b) =>
  [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0),
)) {
  const total = [...methods.values()].reduce((x, y) => x + y, 0);
  console.log(`  ${owner}  (${total}회)`);
  for (const [m, n] of [...methods.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`    .${m}()  ${n}`);
  }
}

console.log(`\n파일별 prototype 호출 Top 10:`);
for (const [f, n] of [...protoByFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${n.toString().padStart(3)}  ${relPath(ROOT, f)}`);
}
phaseTimer.recordPhase('assemble-call-graph', Date.now() - assembleCallGraphStarted);

// 저장
const outPath = path.join(output, 'call-graph.json');
const writeArtifactStarted = Date.now();
writeFileSync(outPath, JSON.stringify({
  meta: {
    generated: new Date().toISOString(),
    root: ROOT,
    tool: 'build-call-graph.mjs',
    complete: parseErrors === 0,
    parseErrors,
    filesWithParseErrors: parseErrorDetails,
    warnings: callGraphWarnings(parseErrorDetails),
    supports: {
      callFanInByDefinitionId: true,
      callFanInByIdentity: true,
      callSiteFanInByDefinitionId: true,
      exportAliasMap: true,
      boundedMemberCallResolution: true,
      topCalleesDisplaySlice: 100,
      truncationFix: true,
    },
  },
  summary: {
    files: files.length,
    totalCallExpressions: [...fileInfo.values()].reduce((a, i) => a + i.totalCallExpressions, 0),
    totalDirectCalls,
    resolvedCrossFileCalls: resolvedDirectCalls,
    typeOnlySkipped: typeOnlyResolved,
    callEdges: callEdges.length,
    boundedOutMemberCalls: [...boundedOutMemberCallsByAbsFile.values()].reduce((a, n) => a + n, 0),
    semiDead: semiDeadCount,
    semiDeadReactFiltered: reactSkipCount, // FP-19
    totalPrototypeCalls: totalProtoCalls,
  },
  topCallees: topCallees.slice(0, 100),
  callFanInByDefinitionId,
  callFanInByIdentity,
  callSiteFanInByDefinitionId,
  exportAliasMap,
  boundedOutMemberCallsByFile,
  memberCallsByFile,
  moduleCallCount: [...moduleCallCount.entries()].map(([k, v]) => ({ edge: k, count: v })).sort((a, b) => b.count - a.count).slice(0, 50),
  semiDeadList: semiDead,
  prototypeOwners: [...protoByOwner.entries()].map(([owner, m]) => ({
    owner, methods: Object.fromEntries(m), total: [...m.values()].reduce((x, y) => x + y, 0),
  })),
}, null, 2));
phaseTimer.recordPhase('write-artifact', Date.now() - writeArtifactStarted);
phaseTimer.write();

console.log(`[call-graph] edges: ${callEdges.length}, prototype calls: ${totalProtoCalls}, semi-dead: ${semiDeadCount}`);
console.log(`[call-graph] saved → ${outPath}`);
