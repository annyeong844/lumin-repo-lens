#!/usr/bin/env node
// m2s1-topology.mjs — File-level import graph (parameterized)
//
// Usage:
//   node measure-topology.mjs --root <repo> [--output <dir>] [--include-tests] \
//        [--include-type-edges] [--cache-root <dir>] [--no-incremental] \
//        [--clear-incremental-cache] [--verbose]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseOxcOrThrow } from '../lib/parse-oxc.mjs';
import { parseCliArgs } from '../lib/cli.mjs';
import { detectRepoMode } from '../lib/repo-mode.mjs';
import { buildAliasMap } from '../lib/alias-map.mjs';
import { makeResolver, isNonSourceAssetResolution, isResolvedFile } from '../lib/resolver-core.mjs';
import { producerMetaBase } from '../lib/artifacts.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { JS_FAMILY_LANGS } from '../lib/lang.mjs';
import { relPath, buildSubmoduleResolver } from '../lib/paths.mjs';
import {
  MODULE_EDGE_SCANNER_POLICY_VERSION,
  scanJsModuleEdgesFast,
} from '../lib/js-module-edge-scanner.mjs';
import {
  loadCache,
  saveCache,
  pickChangedFiles,
  cacheBanner,
} from '../lib/incremental.mjs';
import {
  clearIncrementalCache,
  openIncrementalCacheStore,
} from '../lib/incremental-cache-store.mjs';
import {
  isPythonAvailable,
  extractPythonBatch,
  resolvePythonImport,
} from '../lib/python.mjs';
import {
  isTreeSitterAvailable,
  extractTreeSitterBatch,
  findGoModule,
  resolveGoImport,
} from '../lib/tree-sitter-langs.mjs';
import { createProducerPhaseTimer } from '../lib/producer-phase-timing.mjs';

const cli = parseCliArgs({
  'no-incremental': { type: 'boolean', default: false },
  'cache-root': { type: 'string' },
  'clear-incremental-cache': { type: 'boolean', default: false },
  'include-type-edges': { type: 'boolean', default: false },
});
const { root, output, verbose } = cli;
const phaseTimer = createProducerPhaseTimer({
  producer: 'measure-topology.mjs',
  output,
});
const isIncremental = cli.raw['no-incremental'] !== true;
const cacheStore = openIncrementalCacheStore({
  root,
  cacheRoot: cli.raw['cache-root'],
});
if (cli.raw['clear-incremental-cache'] === true) {
  clearIncrementalCache(cacheStore);
}
const topologyCacheDir = path.join(cacheStore.repoCacheDir, 'legacy');
// Two lenses for SCC analysis:
//   default (runtime lens) — type-only imports excluded; tracks what actually
//     ships to production. `import type {X}` is erased at compile.
//   --include-type-edges (static lens) — matches dep-cruiser's
//     --ts-pre-compilation-deps: includes the compile-time type-layer graph.
// Report findings with the lens explicitly labeled.
const includeTypeEdges = !!cli.raw['include-type-edges'];

if (verbose) console.error(`[m2s1] root: ${root}`);
const repoMode = detectRepoMode(root);
if (verbose) console.error(`[m2s1] mode: ${repoMode.mode}, workspaces: ${repoMode.workspaceDirs.length}`);

const aliasMap = buildAliasMap(root, repoMode, { exclude: cli.exclude });
if (verbose) console.error(`[m2s1] alias entries: ${aliasMap.size}`);

const resolve = makeResolver(root, aliasMap);
const candidateLangList = [...JS_FAMILY_LANGS, 'py', 'go'];
const candidateFiles = phaseTimer.runPhase('collect-files', () => collectFiles(root, {
  includeTests: cli.includeTests,
  exclude: cli.exclude,
  languages: candidateLangList,
}));
const pyCandidates = candidateFiles.filter((f) => f.endsWith('.py'));
const goCandidates = candidateFiles.filter((f) => f.endsWith('.go'));
const pyEnabled = pyCandidates.length > 0 ? isPythonAvailable() : false;
const tsEnabled = goCandidates.length > 0 ? await isTreeSitterAvailable() : false;
const files = candidateFiles.filter((f) => {
  if (f.endsWith('.py')) return pyEnabled;
  if (f.endsWith('.go')) return tsEnabled;
  return true;
});
phaseTimer.setCounter('filesCollected', files.length);
const pyTotal = pyCandidates.length;
const goTotal = goCandidates.length;
const pythonStatus = pyTotal === 0
  ? 'skipped, 0 .py'
  : `${pyEnabled ? 'on' : 'off'}, ${pyTotal} .py`;
const goStatus = goTotal === 0
  ? 'skipped, 0 .go'
  : `${tsEnabled ? 'on' : 'off'}, ${goTotal} .go`;
console.error(
  `[m2s1] scanning ${files.length} files (python=${pythonStatus}, go=${goStatus}) ...`
);
const goModule = goTotal > 0 && tsEnabled ? findGoModule(root) : null;
if (goTotal > 0 && verbose) console.error(`[m2s1] go.mod: ${goModule?.moduleName ?? 'none'}`);

// ─── per-file processor (pure: file → {loc, edges, externalCount, unresolvedCount, parseError}) ─
// Dispatches on file extension:
//   .py  → Python AST via subprocess batch (python.mjs)
//   .go  → Tree-sitter WASM batch (tree-sitter-langs.mjs)
//   else → oxc-parser (TypeScript/JavaScript)
let pyResults = new Map();
let tsResults = new Map(); // tree-sitter results (go, future: rust, java...)
const scannerRiskCounts = new Map();
const scannerFallbackExamples = new Map();
const SCANNER_FALLBACK_EXAMPLE_LIMIT = 5;

function recordScannerFallbackRisk(reason, file) {
  const key = String(reason ?? 'unknown');
  scannerRiskCounts.set(key, (scannerRiskCounts.get(key) ?? 0) + 1);
  phaseTimer.incrementCounter(`scannerRisk_${key}`);
  const examples = scannerFallbackExamples.get(key) ?? [];
  if (examples.length < SCANNER_FALLBACK_EXAMPLE_LIMIT) {
    examples.push(relPath(root, file));
    scannerFallbackExamples.set(key, examples);
  }
}

function resolveTopologyEdge(fromFile, source, flags, edgesOut) {
  const target = resolve(fromFile, source);
  if (target === 'EXTERNAL') return 'external';
  if (isNonSourceAssetResolution(target)) return 'asset';
  if (isResolvedFile(target)) {
    edgesOut.push({
      to: target,
      typeOnly: !!flags.typeOnly,
      ...(flags.dynamic ? { dynamic: true } : {}),
      ...(flags.reExport ? { reExport: true } : {}),
    });
    return 'resolved';
  }
  return 'unresolved';
}

function processFilePython(f) {
  const r = pyResults.get(f);
  if (!r) return { readError: true };
  if (r.error) {
    if (verbose) console.error(`[m2s1] py error: ${relPath(root, f)}: ${r.error}`);
    return { loc: r.loc ?? 0, edges: [], externalCount: 0, unresolvedCount: 0, parseError: true };
  }
  const edges = [];
  let externalCount = 0;
  for (const imp of r.imports ?? []) {
    const hits = resolvePythonImport(
      root, f, imp.source, imp.isFromImport, imp.imported, imp.level
    );
    if (hits.length === 0) {
      externalCount++;
    } else {
      for (const hit of hits) edges.push({ to: hit });
    }
  }
  return { loc: r.loc ?? 0, edges, externalCount, unresolvedCount: 0, parseError: false };
}

function processFileGo(f) {
  const r = tsResults.get(f);
  if (!r) return { readError: true };
  if (r.error) {
    if (verbose) console.error(`[m2s1] go error: ${relPath(root, f)}: ${r.error}`);
    return { loc: r.loc ?? 0, edges: [], externalCount: 0, unresolvedCount: 0, parseError: true };
  }
  const edges = [];
  let externalCount = 0;
  for (const imp of r.imports ?? []) {
    const hits = resolveGoImport(root, goModule, imp.source);
    if (hits.length === 0) {
      externalCount++; // stdlib or 3rd-party
    } else {
      for (const hit of hits) edges.push({ to: hit });
    }
  }
  return { loc: r.loc ?? 0, edges, externalCount, unresolvedCount: 0, parseError: false };
}

function processFileTs(f) {
  let src;
  try {
    src = readFileSync(f, 'utf8');
  } catch {
    return { readError: true };
  }
  phaseTimer.incrementCounter('jsFilesProcessed');
  phaseTimer.incrementCounter('jsBytesRead', Buffer.byteLength(src, 'utf8'));
  const loc = src.split('\n').length;
  const edgesOut = [];
  let externalCount = 0;
  let unresolvedCount = 0;

  const scannerStarted = Date.now();
  phaseTimer.incrementCounter('scannerFilesAttempted');
  const scanned = scanJsModuleEdgesFast(src, { filename: f });
  phaseTimer.incrementCounter('scannerMs', Date.now() - scannerStarted);
  if (scanned.ok) {
    phaseTimer.incrementCounter('scannerAcceptedFiles');
    for (const edge of scanned.edges ?? []) {
      const outcome = resolveTopologyEdge(f, edge.source, edge, edgesOut);
      if (outcome === 'external') externalCount++;
      else if (outcome === 'unresolved') unresolvedCount++;
    }
    return {
      loc: scanned.loc ?? loc,
      edges: edgesOut,
      externalCount,
      unresolvedCount,
      parseError: false,
      scannerMode: 'fast-module-edge',
    };
  }
  phaseTimer.incrementCounter('scannerFallbackFiles');
  for (const reason of scanned.risk ?? []) recordScannerFallbackRisk(reason, f);

  // v0.6.8 FP-18 sync-back: dynamic `import('./x')` edges must surface in
  // topology — SKILL.md promises dynamic imports are ALWAYS in both the
  // runtime and static lens. Previously only top-level ImportDeclaration and
  // re-export with source were read; dynamic imports live inside function
  // bodies, arrow expressions, conditionals, object literals, etc. so we
  // need a recursive walker (same logic as build-symbol-graph.mjs). Edges
  // get `dynamic: true` for provenance; `typeOnly: false` so they survive
  // the runtime-lens filter.
  function walkDynamic(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportExpression') {
      const s = node.source;
      if (s && (s.type === 'Literal' || s.type === 'StringLiteral') &&
          typeof s.value === 'string') {
        const outcome = resolveTopologyEdge(f, s.value, { typeOnly: false, dynamic: true }, edgesOut);
        if (outcome === 'external') externalCount++;
        else if (outcome === 'unresolved') unresolvedCount++;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const n of v) walkDynamic(n);
      } else if (v && typeof v === 'object' && typeof v.type === 'string') {
        walkDynamic(v);
      }
    }
  }

  // v1.8.3: helper centralizes oxc error escalation; see _lib/parse-oxc.mjs.
  try {
    phaseTimer.incrementCounter('oxcParseCalls');
    const r = parseOxcOrThrow(f, src);
    for (const node of r.program.body) {
      if (node.type === 'ImportDeclaration') {
        const outcome = resolveTopologyEdge(f, node.source.value, {
          typeOnly: node.importKind === 'type',
        }, edgesOut);
        if (outcome === 'external') externalCount++;
        else if (outcome === 'unresolved') unresolvedCount++;
      } else if (
        (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
        node.source
      ) {
        // v1.8.3: detect type-only re-exports so the runtime-lens
        // topology doesn't attribute cycles to `export type { X } from
        // './types'`. Three TypeScript syntactic forms:
        //   (1) `export type { X } from ...`      → node.exportKind === 'type'
        //   (2) `export type * from ...`          → node.exportKind === 'type'
        //   (3) `export { type X, type Y } ...`   → every specifier has exportKind='type'
        // Mixed forms (e.g. `export { X, type Y }`) must keep the edge
        // because X is still a runtime re-export.
        const specs = node.specifiers ?? [];
        const allSpecsTypeOnly = specs.length > 0 && specs.every((s) => s.exportKind === 'type');
        const typeOnly = node.exportKind === 'type' || allSpecsTypeOnly;
        const outcome = resolveTopologyEdge(f, node.source.value, {
          reExport: true,
          typeOnly,
        }, edgesOut);
        if (outcome === 'external') externalCount++;
        else if (outcome === 'unresolved') unresolvedCount++;
      }
    }
    // Sweep the entire AST once for dynamic import() expressions anywhere.
    walkDynamic(r.program);
  } catch (e) {
    phaseTimer.incrementCounter('oxcParseErrors');
    if (verbose) console.error(`[m2s1] parse error: ${relPath(root, f)}: ${e.message}`);
    return { loc, edges: [], externalCount: 0, unresolvedCount: 0, parseError: true };
  }
  return { loc, edges: edgesOut, externalCount, unresolvedCount, parseError: false };
}

function processFile(f) {
  if (f.endsWith('.py')) return processFilePython(f);
  if (f.endsWith('.go')) return processFileGo(f);
  return processFileTs(f);
}

// ─── incremental-aware processing loop ───────────────────
const cache = isIncremental ? loadCache(topologyCacheDir, 'topology') : { version: 1, entries: {} };
const { changed, unchanged, dropped, nextCache } = isIncremental
  ? pickChangedFiles(files, cache)
  : { changed: files, unchanged: [], dropped: [], nextCache: { version: 1, entries: {} } };
phaseTimer.setCounter('changedFiles', changed.length);
phaseTimer.setCounter('unchangedFiles', unchanged.length);
phaseTimer.setCounter('droppedFiles', dropped.length);

if (isIncremental) {
  console.error(cacheBanner('m2s1', changed, unchanged, dropped));
}

// Pre-batch Python files among the changed set (one subprocess).
const processChangedFilesStarted = Date.now();
const changedPy = changed.filter((f) => f.endsWith('.py'));
if (changedPy.length > 0 && pyEnabled) {
  try {
    pyResults = extractPythonBatch(changedPy) ?? new Map();
    if (verbose) console.error(`[m2s1] python batch: ${pyResults.size}/${changedPy.length}`);
  } catch (e) {
    console.error(`[m2s1] python batch failed: ${e.message}`);
  }
}

// Pre-batch tree-sitter languages (currently Go) among changed set.
const changedTs = changed.filter((f) => f.endsWith('.go'));
if (changedTs.length > 0 && tsEnabled) {
  try {
    tsResults = (await extractTreeSitterBatch(changedTs)) ?? new Map();
    if (verbose) console.error(`[m2s1] tree-sitter batch: ${tsResults.size}/${changedTs.length}`);
  } catch (e) {
    console.error(`[m2s1] tree-sitter batch failed: ${e.message}`);
  }
}

for (const f of changed) {
  const payload = processFile(f);
  if (payload.readError) continue;
  nextCache.entries[f] = { ...(nextCache.entries[f] ?? {}), ...payload };
}
phaseTimer.recordPhase('process-changed-files', Date.now() - processChangedFilesStarted);

// ─── aggregate ───────────────────────────────────────────
const assembleGraphStarted = Date.now();
const nodes = new Map();
const edges = [];
let totalLoc = 0;
let parseErrors = 0;
let externalEdges = 0;
let unresolvedEdges = 0;

const sourceEntries = isIncremental ? nextCache.entries : null;
if (isIncremental) {
  for (const [f, entry] of Object.entries(sourceEntries)) {
    if (entry.loc === undefined) continue;
    nodes.set(f, { loc: entry.loc });
    totalLoc += entry.loc;
    externalEdges += entry.externalCount ?? 0;
    unresolvedEdges += entry.unresolvedCount ?? 0;
    if (entry.parseError) parseErrors++;
    for (const e of entry.edges ?? []) {
      edges.push({ from: f, ...e });
    }
  }
} else {
  // changed == files in non-incremental mode; iterate fresh payloads.
  for (const f of files) {
    const entry = nextCache.entries[f];
    if (!entry || entry.loc === undefined) { parseErrors++; continue; }
    nodes.set(f, { loc: entry.loc });
    totalLoc += entry.loc;
    externalEdges += entry.externalCount ?? 0;
    unresolvedEdges += entry.unresolvedCount ?? 0;
    if (entry.parseError) parseErrors++;
    for (const e of entry.edges ?? []) {
      edges.push({ from: f, ...e });
    }
  }
}

if (isIncremental) {
  mkdirSync(topologyCacheDir, { recursive: true });
  saveCache(topologyCacheDir, 'topology', nextCache);
}

const fanIn = new Map();
const fanOut = new Map();
for (const e of edges) {
  fanIn.set(e.to, (fanIn.get(e.to) || 0) + 1);
  fanOut.set(e.from, (fanOut.get(e.from) || 0) + 1);
}

// Tarjan SCC. Default lens = runtime (type-only edges excluded, since
// `import type {X}` is elided at compile time and never ships). With
// --include-type-edges, the type-only edges participate too — this matches
// dep-cruiser's --ts-pre-compilation-deps static lens.
const adj = new Map();
for (const e of edges) {
  if (e.typeOnly && !includeTypeEdges) continue;
  if (!adj.has(e.from)) adj.set(e.from, []);
  adj.get(e.from).push(e.to);
}
let idx = 0;
const indices = new Map(), lows = new Map(), onStack = new Set(), stack = [];
const sccs = [];
function sccFn(v) {
  indices.set(v, idx); lows.set(v, idx); idx++;
  stack.push(v); onStack.add(v);
  for (const w of adj.get(v) || []) {
    if (!indices.has(w)) { sccFn(w); lows.set(v, Math.min(lows.get(v), lows.get(w))); }
    else if (onStack.has(w)) lows.set(v, Math.min(lows.get(v), indices.get(w)));
  }
  if (lows.get(v) === indices.get(v)) {
    const s = [];
    let w;
    do { w = stack.pop(); onStack.delete(w); s.push(w); } while (w !== v);
    if (s.length > 1) sccs.push(s);
  }
}
for (const v of nodes.keys()) if (!indices.has(v)) sccFn(v);

const submoduleOf = buildSubmoduleResolver(root, repoMode);
const subEdges = new Map();
for (const e of edges) {
  const fs = submoduleOf(e.from), ts = submoduleOf(e.to);
  if (fs === ts) continue;
  const k = `${fs} → ${ts}`;
  subEdges.set(k, (subEdges.get(k) || 0) + 1);
}

const bigFiles = [...nodes.entries()]
  .map(([f, n]) => ({ file: relPath(root, f), loc: n.loc }))
  .filter(x => x.loc >= 400)
  .sort((a, b) => b.loc - a.loc);

for (const counterName of [
  'scannerFilesAttempted',
  'scannerAcceptedFiles',
  'scannerFallbackFiles',
  'scannerMs',
  'oxcParseCalls',
  'oxcParseErrors',
]) {
  phaseTimer.setCounter(counterName, phaseTimer.counters[counterName] ?? 0);
}

const resolverMemoStats = typeof resolve.memoStats === 'function'
  ? resolve.memoStats()
  : { hits: 0, misses: 0, size: 0 };
phaseTimer.setCounter('resolverMemoHits', resolverMemoStats.hits);
phaseTimer.setCounter('resolverMemoMisses', resolverMemoStats.misses);
phaseTimer.setCounter('resolverMemoSize', resolverMemoStats.size);

const artifact = {
  meta: {
    ...producerMetaBase({ tool: 'm2s1-topology.mjs', root }),
    mode: repoMode.mode,
    rootPkgName: repoMode.rootPkgName,
    // P1-2 preparatory: `complete: true` is the producer's explicit
    // promise that `nodes` enumerates every file that `collectFiles()`
    // returned AND successfully parsed. Parse-errored files are NOT in
    // `nodes` — they appear in `symbols.json.filesWithParseErrors[]`.
    // P1 pre-write file lookup that wants to claim `NEW_FILE` must
    // therefore check BOTH: absent from `topology.nodes` AND absent
    // from `symbols.filesWithParseErrors`. Otherwise the honest answer
    // is `FILE_STATUS_UNKNOWN`. See canonical/pre-write-gate.md §5 +
    // maintainer history notes §4.1 for the three-way result contract.
    complete: true,
  },
  summary: {
    files: files.length,
    totalLoc,
    meanLocPerFile: Math.round(totalLoc / Math.max(files.length, 1)),
    parseErrors,
    internalEdges: edges.length,
    externalEdges,
    unresolvedEdges,
    // Which lens produced the SCC numbers. Runtime lens excludes `import type`
    // edges (elided at compile). Static lens matches dep-cruiser's
    // --ts-pre-compilation-deps behavior.
    lens: includeTypeEdges ? 'static' : 'runtime',
    sccCount: sccs.length,
    maxSccSize: sccs.reduce((max, s) => Math.max(max, s.length), 0),
    typeOnlyEdges: edges.filter((e) => e.typeOnly).length,
    bigFiles: bigFiles.length,
    oneThousandPlusFiles: bigFiles.filter(x => x.loc >= 1000).length,
    performance: {
      filesCollected: phaseTimer.counters.filesCollected ?? files.length,
      changedFiles: phaseTimer.counters.changedFiles ?? changed.length,
      unchangedFiles: phaseTimer.counters.unchangedFiles ?? unchanged.length,
      droppedFiles: phaseTimer.counters.droppedFiles ?? dropped.length,
      jsFilesProcessed: phaseTimer.counters.jsFilesProcessed ?? 0,
      jsBytesRead: phaseTimer.counters.jsBytesRead ?? 0,
      scannerPolicyVersion: MODULE_EDGE_SCANNER_POLICY_VERSION,
      scannerFilesAttempted: phaseTimer.counters.scannerFilesAttempted ?? 0,
      scannerAcceptedFiles: phaseTimer.counters.scannerAcceptedFiles ?? 0,
      scannerFallbackFiles: phaseTimer.counters.scannerFallbackFiles ?? 0,
      scannerMs: phaseTimer.counters.scannerMs ?? 0,
      scannerRiskCounts: Object.fromEntries([...scannerRiskCounts.entries()].sort(([a], [b]) =>
        a.localeCompare(b))),
      scannerFallbackExamples: Object.fromEntries([...scannerFallbackExamples.entries()].sort(([a], [b]) =>
        a.localeCompare(b))),
      oxcParseCalls: phaseTimer.counters.oxcParseCalls ?? 0,
      oxcParseErrors: phaseTimer.counters.oxcParseErrors ?? 0,
      resolverMemoHits: phaseTimer.counters.resolverMemoHits ?? 0,
      resolverMemoMisses: phaseTimer.counters.resolverMemoMisses ?? 0,
      resolverMemoSize: phaseTimer.counters.resolverMemoSize ?? 0,
    },
  },
  // P1-2 / P2-0 contract: `nodes` lists every successfully-parsed file
  // so pre-write file lookup can distinguish FILE_EXISTS / NEW_FILE
  // against `meta.complete` (per maintainer history notes §4.1). Keys are root-relative
  // forward-slash paths; values carry `{ loc }` so checklist-facts and
  // P1 lookup can use LOC when needed. `edges` carries the same array
  // downstream consumers traverse for inbound fan-in.
  nodes: Object.fromEntries(
    [...nodes.entries()].map(([abs, info]) => [relPath(root, abs), info])
  ),
  edges: edges.map((e) => ({
    from: relPath(root, e.from),
    to: e.to?.startsWith?.('external:') || e.to?.startsWith?.('unresolved:')
      ? e.to
      : relPath(root, e.to),
    typeOnly: e.typeOnly ?? false,
  })),
  topFanIn: [...fanIn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([f, n]) => ({ file: relPath(root, f), count: n })),
  topFanOut: [...fanOut.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([f, n]) => ({ file: relPath(root, f), count: n })),
  sccs: sccs.slice().sort((a, b) => b.length - a.length).slice(0, 10)
    .map(s => ({ size: s.length, members: s.map(f => relPath(root, f)) })),
  // P3-3-pre (2026-04-21): full untruncated cross-submodule edge list.
  // `crossSubmoduleEdges` is the classification source for P3-3 topology canon
  // draft per `maintainer history notes` v3 PF-6 — top-30 truncation in `crossSubmoduleTop`
  // made `isolated-submodule` / `shared-submodule` labels unreliable against
  // long-tail edges. Full list is structured (`{from, to, count}`) so consumers
  // can aggregate per-submodule in/out-degree without parsing `"a → b"` strings.
  // `crossSubmoduleTop` stays unchanged for existing consumers and display.
  crossSubmoduleEdges: [...subEdges.entries()]
    .map(([k, n]) => {
      const arrow = k.indexOf(' → ');
      return { from: k.slice(0, arrow), to: k.slice(arrow + 3), count: n };
    })
    .sort((a, b) => (b.count - a.count) || (a.from.localeCompare(b.from)) || (a.to.localeCompare(b.to))),
  crossSubmoduleTop: [...subEdges.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([k, n]) => ({ edge: k, count: n })),
  largestFiles: bigFiles.slice(0, 20),
};
phaseTimer.recordPhase('assemble-graph', Date.now() - assembleGraphStarted);

const outPath = path.join(output, 'topology.json');
const writeArtifactStarted = Date.now();
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
phaseTimer.recordPhase('write-artifact', Date.now() - writeArtifactStarted);
phaseTimer.write();

const lensLabel = includeTypeEdges ? 'static' : 'runtime';
console.log(`[m2s1] ${files.length} files, ${totalLoc.toLocaleString()} LOC, ${edges.length} edges (lens: ${lensLabel})`);
console.log(`[m2s1] SCC ${sccs.length} (max ${artifact.summary.maxSccSize}), 1000 LOC+ ${artifact.summary.oneThousandPlusFiles}`);
console.log(`[m2s1] saved → ${outPath}`);
