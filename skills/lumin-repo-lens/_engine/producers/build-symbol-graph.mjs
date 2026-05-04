// build-symbol-graph.mjs — Symbol-level export/import graph (parameterized)
//
// For each file:
// - collect top-level export definitions (not re-exports)
// - collect import/re-export specifiers (uses)
// - build (definition file, symbol) -> consumer set mapping
// - derive: dead exports, symbol fan-in, top consumers
//
// Usage: node build-symbol-graph.mjs --root <repo> [--output <dir>]

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { detectBarrelFiles } from '../lib/alias-map.mjs';
import { extractDefinitionsAndUses } from '../lib/extract-ts.mjs';
import { goExtractShape } from '../lib/extract-go.mjs';
import { pythonExtractShape } from '../lib/extract-py.mjs';
import { parseCliArgs } from '../lib/cli.mjs';
import { detectRepoMode } from '../lib/repo-mode.mjs';
import { buildAliasMap } from '../lib/alias-map.mjs';
import { explainUnresolvedSpecifier, makeResolver } from '../lib/resolver-core.mjs';
import { collectMdxImportConsumers } from '../lib/mdx-consumers.mjs';
import { JS_FAMILY_LANGS } from '../lib/lang.mjs';
import { isTestLikePath } from '../lib/test-paths.mjs';
import { relPath, buildSubmoduleResolver } from '../lib/paths.mjs';
import { buildSymbolsArtifact } from '../lib/symbol-graph-artifact.mjs';
import { buildAnyContaminationFacts } from '../lib/any-contamination.mjs';
import {
  buildContextFingerprint,
  buildRepoSnapshot,
  STRICT_IDENTITY_MODE,
} from '../lib/incremental-snapshot.mjs';
import {
  clearIncrementalCache,
  getReusableFact,
  loadProducerCache,
  openIncrementalCacheStore,
  putFact,
  saveProducerCache,
  strictCacheKeyForEntry,
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

const cli = parseCliArgs({
  incremental: { type: 'boolean', default: false },
  'no-incremental': { type: 'boolean', default: false },
  'cache-root': { type: 'string' },
  'clear-incremental-cache': { type: 'boolean', default: false },
});
const { root: ROOT, output, verbose } = cli;
const pyEnabled = isPythonAvailable();
const tsEnabled = await isTreeSitterAvailable();
const goModule = findGoModule(ROOT);
const languageSupport = {
  ts: { enabled: true, reason: null },
  js: { enabled: true, reason: null },
  python: pyEnabled
    ? { enabled: true, reason: null, extractor: 'python-ast-batch' }
    : { enabled: false, reason: 'python executable unavailable' },
  go: tsEnabled
    ? { enabled: true, reason: null, extractor: 'tree-sitter-wasm' }
    : { enabled: false, reason: 'tree-sitter unavailable' },
};

const repoMode = detectRepoMode(ROOT);
const aliasMap = buildAliasMap(ROOT, repoMode);
const _resolveRaw = makeResolver(ROOT, aliasMap);
// Extension-aware resolver: Python files use the Python module resolver;
// anything else falls through to the TS/JS alias-aware resolver. EXTERNAL
// (stdlib / npm) is collapsed to `null` for consistent downstream handling.
function resolveSpecifier(from, use) {
  // `use` is the richer import record; callers that only have spec string can
  // pass { fromSpec: spec } for legacy behavior.
  const spec = typeof use === 'string' ? use : use.fromSpec;
  if (from.endsWith('.py')) {
    const isFromImport = typeof use === 'object' ? !!use.pyIsFromImport : false;
    const level = typeof use === 'object' ? (use.pyLevel ?? 0) : 0;
    const names =
      typeof use === 'object' && use.name && use.name !== '*' ? [use.name] : [];
    const hits = resolvePythonImport(ROOT, from, spec, isFromImport, names, level);
    return hits[0] ?? null;
  }
  if (from.endsWith('.go')) {
    const hits = resolveGoImport(ROOT, goModule, spec);
    return hits[0] ?? null;
  }
  const r = _resolveRaw(from, spec);
  // v1.9.7: preserve resolver sentinels so the caller can distinguish
  // external packages (react, oxc-parser) from failed local aliases
  // (@/components/X that matched a tsconfig path but the file wasn't
  // found). Both used to collapse to null here, inflating
  // unresolvedUses with legitimate external imports and triggering
  // false resolver-blindness alerts.
  return r;
}

if (verbose) console.error(`[symbols] root: ${ROOT}, mode: ${repoMode.mode}`);

// Per-language extractors live in `_lib/extract-{ts,py,go}.mjs`
// since v1.10.1. Each returns the canonical
// {filePath, defs, uses, reExports, loc, [pyDunderAll]} shape — the
// main scan loop below doesn't switch on language after this point.


// ─── 전체 스캔 (incremental-aware, multi-language) ───────
const langList = [...JS_FAMILY_LANGS];
if (pyEnabled) langList.push('py');
if (tsEnabled) langList.push('go');

const PRODUCER_ID = 'symbols';
const PRODUCER_VERSION = 1;
const FACT_SCHEMA_VERSION = 1;
const PARSER_IDENTITY = 'symbol-graph-extractors:v1';

const contextFingerprint = buildContextFingerprint({
  includeTests: cli.includeTests,
  exclude: cli.exclude,
  languages: langList,
  producerContext: {
    producer: PRODUCER_ID,
    producerVersion: PRODUCER_VERSION,
    factSchemaVersion: FACT_SCHEMA_VERSION,
    parserIdentity: PARSER_IDENTITY,
    repoMode: repoMode.mode,
    pythonEnabled: pyEnabled,
    treeSitterEnabled: tsEnabled,
  },
});
const snapshot = buildRepoSnapshot({
  root: ROOT,
  includeTests: cli.includeTests,
  exclude: cli.exclude,
  languages: langList,
  contextFingerprint,
});
const snapshotEntries = Object.values(snapshot.files);
const files = snapshotEntries.map((entry) => entry.absPath);
const pyTotal = files.filter((f) => f.endsWith('.py')).length;
const goTotal = files.filter((f) => f.endsWith('.go')).length;
console.error(
  `[symbols] scanning ${files.length} files (python=${pyEnabled ? `on, ${pyTotal} .py` : 'off'}, go=${tsEnabled ? `on, ${goTotal} .go` : 'off'})`
);

const incrementalEnabled = cli.raw?.['no-incremental'] !== true;
const cacheStore = openIncrementalCacheStore({
  root: ROOT,
  cacheRoot: cli.raw?.['cache-root'],
});
if (cli.raw?.['clear-incremental-cache'] === true) {
  clearIncrementalCache(cacheStore);
}

const producerCacheMeta = {
  producerId: PRODUCER_ID,
  producerVersion: PRODUCER_VERSION,
  factSchemaVersion: FACT_SCHEMA_VERSION,
  parserIdentity: PARSER_IDENTITY,
  scanFingerprint: contextFingerprint,
  configFingerprint: contextFingerprint,
};
const priorCache = incrementalEnabled
  ? loadProducerCache(cacheStore, PRODUCER_ID)
  : { entries: {}, meta: { loadStatus: 'disabled' } };
const nextProducerCache = { entries: {}, meta: { loadStatus: 'new' } };
const nextCache = { version: 1, entries: {} };
const currentStrictKeys = new Set();
const changed = [];
let changedFiles = 0;
let reusedFiles = 0;
let invalidatedFiles = 0;

for (const entry of snapshotEntries) {
  currentStrictKeys.add(strictCacheKeyForEntry(entry));

  if (!entry.readable) {
    changedFiles++;
    nextCache.entries[entry.absPath] = { parseError: true };
    continue;
  }

  const reuse = incrementalEnabled
    ? getReusableFact(priorCache, { snapshotEntry: entry, producerMeta: producerCacheMeta })
    : { status: 'miss', reason: 'disabled-by-flag' };

  if (reuse.status === 'hit') {
    reusedFiles++;
    nextCache.entries[entry.absPath] = reuse.payload;
    putFact(nextProducerCache, {
      snapshotEntry: entry,
      producerMeta: producerCacheMeta,
      payload: reuse.payload,
    });
    continue;
  }

  if (reuse.reason !== 'missing-entry' && reuse.reason !== 'disabled-by-flag') {
    invalidatedFiles++;
  }
  changedFiles++;
  changed.push(entry.absPath);
}

const droppedFiles = Object.keys(priorCache.entries ?? {})
  .filter((key) => !currentStrictKeys.has(key)).length;

if (incrementalEnabled) {
  console.error(
    `[symbols-incremental] changed=${changedFiles} reused=${reusedFiles} dropped=${droppedFiles} invalidated=${invalidatedFiles}`
  );
}

// Pre-batch Python files among the changed set.
const changedPy = changed.filter((f) => f.endsWith('.py'));
// v1.8.2: collect non-fatal failure records for explicit inclusion in
// the artifact. Previously these went to stderr (or got silently
// swallowed at a deeper level). The `warnings[]` field in
// `symbols.json.meta` lets CI consumers, SARIF emission, and downstream
// tools like `triage-repo` see what couldn't be processed — and decide
// how to react.
const warnings = [];

let pyBatch = new Map();
if (changedPy.length > 0 && pyEnabled) {
  try {
    pyBatch = extractPythonBatch(changedPy) ?? new Map();
    // Python extractor surfaces stream-parse failures via a __meta__ key.
    const pyMeta = pyBatch.get('__meta__');
    if (pyMeta?.parseFailures > 0) {
      warnings.push({
        code: 'python-ndjson-parse-failure',
        count: pyMeta.parseFailures,
        message: `${pyMeta.parseFailures} stray non-JSON lines in extractor stdout`,
      });
    }
    pyBatch.delete('__meta__');
  } catch (e) {
    console.error(`[symbols] python batch failed: ${e.message}`);
    warnings.push({
      code: 'python-batch-crashed',
      message: e.message,
      affected: changedPy.length,
    });
  }
}

// Pre-batch Go files (and any other tree-sitter languages).
const changedTs = changed.filter((f) => f.endsWith('.go'));
let tsBatch = new Map();
if (changedTs.length > 0 && tsEnabled) {
  try {
    tsBatch = (await extractTreeSitterBatch(changedTs)) ?? new Map();
  } catch (e) {
    console.error(`[symbols] tree-sitter batch failed: ${e.message}`);
    warnings.push({
      code: 'tree-sitter-batch-crashed',
      message: e.message,
      affected: changedTs.length,
    });
  }
}

let parseErrors = 0;
for (const f of changed) {
  const entry = snapshot.files[relPath(ROOT, f)];
  try {
    let payload;
    if (f.endsWith('.py')) {
      const pyRec = pyBatch.get(f);
      if (!pyRec || pyRec.error) {
        parseErrors++;
        if (pyRec?.error && verbose) console.error(`py fail: ${f}: ${pyRec.error}`);
        nextCache.entries[f] = { parseError: true };
        if (incrementalEnabled && entry) {
          putFact(nextProducerCache, {
            snapshotEntry: entry,
            producerMeta: producerCacheMeta,
            payload: nextCache.entries[f],
          });
        }
        continue;
      }
      payload = pythonExtractShape(f, pyRec);
    } else if (f.endsWith('.go')) {
      const goRec = tsBatch.get(f);
      if (!goRec || goRec.error) {
        parseErrors++;
        if (goRec?.error && verbose) console.error(`go fail: ${f}: ${goRec.error}`);
        nextCache.entries[f] = { parseError: true };
        if (incrementalEnabled && entry) {
          putFact(nextProducerCache, {
            snapshotEntry: entry,
            producerMeta: producerCacheMeta,
            payload: nextCache.entries[f],
          });
        }
        continue;
      }
      payload = goExtractShape(f, goRec);
    } else {
      payload = extractDefinitionsAndUses(f, { artifactFilePath: relPath(ROOT, f) });
    }
    nextCache.entries[f] = { ...payload, parseError: false };
    if (incrementalEnabled && entry) {
      putFact(nextProducerCache, {
        snapshotEntry: entry,
        producerMeta: producerCacheMeta,
        payload: nextCache.entries[f],
      });
    }
  } catch (e) {
    parseErrors++;
    console.error(`parse fail: ${f}: ${e.message}`);
    nextCache.entries[f] = { parseError: true };
    if (incrementalEnabled && entry) {
      putFact(nextProducerCache, {
        snapshotEntry: entry,
        producerMeta: producerCacheMeta,
        payload: nextCache.entries[f],
      });
    }
  }
}
// Cached parse errors still count in aggregate.
for (const [f, entry] of Object.entries(nextCache.entries)) {
  if (!changed.includes(f) && entry?.parseError) parseErrors++;
}

const fileData = new Map();
for (const [f, entry] of Object.entries(nextCache.entries)) {
  if (entry.parseError || entry.defs === undefined) continue;
  fileData.set(f, {
    filePath: f,
    defs: entry.defs ?? [],
    uses: entry.uses ?? [],
    reExports: entry.reExports ?? [],
    typeEscapes: entry.typeEscapes ?? [],
    loc: entry.loc ?? 0,
    dynamicImportOpacity: entry.dynamicImportOpacity ?? [],
    // v1.7.2: Python-specific `__all__` declaration. Present only for .py
    // files where the module declared `__all__ = [...]`. When present,
    // only the listed names are considered exported; other top-level
    // names are module-private and excluded from the dead-list.
    ...(entry.pyDunderAll !== undefined ? { pyDunderAll: entry.pyDunderAll } : {}),
  });
}

if (incrementalEnabled) saveProducerCache(cacheStore, PRODUCER_ID, nextProducerCache);
console.log(`[parse] errors: ${parseErrors}`);

// ─── 심볼 그래프 구축 ─────────────────────────────────────
// defIndex: Map<filePath, Map<symbolName, defInfo>>
const defIndex = new Map();
for (const [f, info] of fileData) {
  const m = new Map();
  for (const d of info.defs) {
    if (!m.has(d.name)) m.set(d.name, d);
  }
  defIndex.set(f, m);
}

// consumers: Map<filePath, Map<symbolName, Set<consumerFile>>>
const consumers = new Map();
function addConsumer(defFile, name, consumerFile) {
  if (!consumers.has(defFile)) consumers.set(defFile, new Map());
  const m = consumers.get(defFile);
  if (!m.has(name)) m.set(name, new Set());
  m.get(name).add(consumerFile);
}

// namespace import의 정확한 사용을 모르므로 "전체 파일 사용" 으로 기록
const namespaceUsers = new Map(); // defFile -> Set<consumerFile>

let totalUses = 0;
let unresolvedUses = 0;
// v1.9.7 FP-36 counters: external packages vs genuine scanner
// blind spots. Feeds into fix-plan's resolverBlindness gate.
let resolvedInternalUses = 0;
let externalUses = 0;
let unresolvedInternalUses = 0;
let mdxConsumerUses = 0;
const dependencyImportConsumers = [];
// Spec-frequency counter for topUnresolvedSpecifiers artifact.
// Keyed by "prefix" (everything up to first /) so "@/foo/a" and
// "@/foo/b" roll up to "@/" — gives users actionable feedback
// ("add a tsconfig path for `@/`").
const unresolvedInternalByPrefix = new Map();
const prefixExamples = new Map();
// v1.10.0 P1: full set of unique unresolved specifiers for per-finding
// taint matching in classify-dead-exports. Lets the classifier ask "does
// any unresolved import look like it could resolve to THIS dead symbol's
// file?" rather than relying on the repo-wide unresolvedInternalRatio.
const unresolvedInternalSpecifiers = new Set();
const unresolvedInternalSpecifierRecords = [];
const resolvedInternalEdges = [];
function prefixOf(spec) {
  const slash = spec.indexOf('/');
  return slash > 0 ? spec.slice(0, slash + 1) : spec;
}

function edgeKindForUse(use) {
  const kind = typeof use === 'object' ? use.kind : 'import';
  if (kind === 'import') return 'import-named';
  if (kind === 'default') return 'import-default';
  if (kind === 'namespace' || kind === 'namespace-member') return 'import-namespace';
  if (kind === 'import-side-effect') return 'import-side-effect';
  if (kind === 'reExport') return 'reexport-named';
  if (kind === 'reExportAll') return 'reexport-broad';
  if (kind === 'dynamic' || kind === 'dynamic-member') return 'dynamic-literal';
  if (kind === 'cjs-side-effect-only') return 'cjs-side-effect';
  if (kind === 'cjs-require-exact') return 'cjs-require-exact';
  if (kind === 'cjs-namespace-member') return 'cjs-namespace-member';
  if (kind === 'cjs-namespace-escape') return 'cjs-namespace-escape';
  if (kind === 'cjs-reexport-broad') return 'cjs-reexport-broad';
  return kind;
}

function addResolvedInternalEdge(consumerFile, target, use) {
  const fromSpec = typeof use === 'string' ? use : use.fromSpec;
  resolvedInternalEdges.push({
    from: relPath(ROOT, consumerFile),
    to: relPath(ROOT, target),
    kind: edgeKindForUse(use),
    source: fromSpec,
    typeOnly: typeof use === 'object' ? !!use.typeOnly : false,
  });
}

function recordUnresolvedInternalSpecifier(consumerFile, use) {
  const spec = typeof use === 'string' ? use : use.fromSpec;
  if (typeof spec !== 'string' || spec.length === 0) return;
  const explanation = explainUnresolvedSpecifier(ROOT, aliasMap, consumerFile, spec) ?? {};
  unresolvedInternalSpecifiers.add(spec);
  unresolvedInternalSpecifierRecords.push({
    specifier: spec,
    consumerFile: relPath(ROOT, consumerFile),
    fromHint: relPath(ROOT, consumerFile),
    kind: typeof use === 'object' ? (use.kind ?? 'import') : 'import',
    ...explanation,
  });
}

function packageRootFromSpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0) return null;
  if (spec.startsWith('.') || spec.startsWith('/')) return null;
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    if (parts.length < 2 || parts[1].length === 0) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return spec.split('/')[0];
}

function addDependencyImportConsumer(consumerFile, use, source) {
  const fromSpec = typeof use === 'string' ? use : use.fromSpec;
  const depRoot = packageRootFromSpec(fromSpec);
  if (!depRoot) return;
  const rec = {
    file: relPath(ROOT, consumerFile),
    fromSpec,
    depRoot,
    kind: typeof use === 'object' ? (use.kind ?? 'import') : 'import',
    source,
  };
  if (typeof use === 'object' && typeof use.typeOnly === 'boolean') {
    rec.typeOnly = use.typeOnly;
  }
  dependencyImportConsumers.push(rec);
}

for (const [consumerFile, info] of fileData) {
  for (const u of info.uses) {
    const target = resolveSpecifier(consumerFile, u);
    if (target === 'EXTERNAL') {
      // External npm package. NOT a blind spot for dead-export
      // analysis — external packages don't consume internal exports.
      externalUses++;
      addDependencyImportConsumer(consumerFile, u, 'source-import');
      unresolvedUses++; // legacy counter for backward-compat
      continue;
    }
    if (target === 'UNRESOLVED_INTERNAL') {
      // Local alias matched (e.g. `@/*` from tsconfig paths) but no
      // target file. THIS is a real blind spot — we probably missed
      // a legitimate consumer.
      unresolvedInternalUses++;
      unresolvedUses++;
      const spec = typeof u === 'string' ? u : u.fromSpec;
      const p = prefixOf(spec);
      unresolvedInternalByPrefix.set(p, (unresolvedInternalByPrefix.get(p) ?? 0) + 1);
      if (!prefixExamples.has(p)) prefixExamples.set(p, spec);
      recordUnresolvedInternalSpecifier(consumerFile, u);
      continue;
    }
    if (!target) {
      // null — relative path that didn't resolve, or malformed spec.
      // Treat conservatively as internal: a relative path that
      // doesn't find a file is more likely a scanner/parse issue than
      // an external package.
      unresolvedInternalUses++;
      unresolvedUses++;
      recordUnresolvedInternalSpecifier(consumerFile, u);
      continue;
    }
    totalUses++;
    resolvedInternalUses++;
    addResolvedInternalEdge(consumerFile, target, u);
    // v0.6.6 FP-18: dynamic `import()` treated like namespace — whole-file
    // consumer, since we can't statically know which symbol the caller uses.
    // PCEF P0: CJS side-effect-only imports evaluate the file but do not
    // consume named exports, while CJS namespace escapes/re-exports are broad.
    if (u.kind === 'cjs-side-effect-only' || u.kind === 'import-side-effect') {
      continue;
    }
    if (u.kind === 'namespace' ||
        u.kind === 'reExportAll' ||
        u.kind === 'dynamic' ||
        u.kind === 'cjs-namespace-escape' ||
        u.kind === 'cjs-reexport-broad') {
      if (!namespaceUsers.has(target)) namespaceUsers.set(target, new Set());
      namespaceUsers.get(target).add(consumerFile);
    } else {
      addConsumer(target, u.name, consumerFile);
    }
  }
}

for (const u of collectMdxImportConsumers({
  root: ROOT,
  includeTests: cli.includeTests,
  exclude: cli.exclude,
})) {
  const target = resolveSpecifier(u.consumerFile, u);
  if (target === 'EXTERNAL') {
    externalUses++;
    addDependencyImportConsumer(u.consumerFile, u, 'mdx-import');
    unresolvedUses++;
    continue;
  }
  if (target === 'UNRESOLVED_INTERNAL') {
    unresolvedInternalUses++;
    unresolvedUses++;
    const p = prefixOf(u.fromSpec);
    unresolvedInternalByPrefix.set(p, (unresolvedInternalByPrefix.get(p) ?? 0) + 1);
    if (!prefixExamples.has(p)) prefixExamples.set(p, u.fromSpec);
    recordUnresolvedInternalSpecifier(u.consumerFile, u);
    continue;
  }
  if (!target) {
    unresolvedInternalUses++;
    unresolvedUses++;
    recordUnresolvedInternalSpecifier(u.consumerFile, u);
    continue;
  }
  totalUses++;
  resolvedInternalUses++;
  mdxConsumerUses++;
  addResolvedInternalEdge(u.consumerFile, target, u);
  if (u.kind === 'namespace') {
    if (!namespaceUsers.has(target)) namespaceUsers.set(target, new Set());
    namespaceUsers.get(target).add(u.consumerFile);
  } else {
    addConsumer(target, u.name, u.consumerFile);
  }
}

console.log(`[uses] total ${totalUses}, unresolved ${unresolvedUses}`);
console.log(`[uses] resolvedInternal: ${resolvedInternalUses}, external: ${externalUses}, unresolvedInternal: ${unresolvedInternalUses}`);
console.log(`[defs] total symbols: ${[...defIndex.values()].reduce((a, m) => a + m.size, 0)}`);

// ─── Dead export 탐지 ─────────────────────────────────────
// Barrel files (workspace package main entries) are skipped —
// they serve as re-export hubs, not definition sources. Detection
// lives in `_lib/alias-map.mjs::detectBarrelFiles` since v1.10.1 so
// it can share `mapOutputToSource` with the resolver (keeps the
// `.dist/index.mjs → src/index.ts` mapping consistent, FP-40 class).
const BARREL_FILES = detectBarrelFiles(ROOT, repoMode);

const dead = [];
for (const [defFile, defs] of defIndex) {
  if (BARREL_FILES.has(defFile)) continue; // barrel 자체는 "외부 re-export 허브"
  const fileNamespaceUsed = namespaceUsers.has(defFile); // 누군가 `import * as X` 로 사용중
  const fileConsumers = consumers.get(defFile);
  // v1.7.2 Python convention gate: if the module declares `__all__`,
  // only names in that list are considered publicly exported. Everything
  // else is implicitly private — not a dead-export candidate even with
  // zero cross-file consumers. Mirrors Python's own import semantics
  // (`from m import *` only imports __all__ when declared).
  const fileInfo = fileData.get(defFile);
  const dunderAll = fileInfo?.pyDunderAll;   // array | undefined
  const hasDunderAll = Array.isArray(dunderAll);
  const publicSet = hasDunderAll ? new Set(dunderAll) : null;

  for (const [name, defInfo] of defs) {
    const directConsumers = fileConsumers?.get(name);
    if (directConsumers && directConsumers.size > 0) continue;

    // v1.7.2 policy filters (Python only; JS/TS files have neither flag
    // so these short-circuit out):
    //   - If __all__ is declared and this name is NOT in it, the symbol
    //     is module-private by convention — skip.
    //   - If the def carries `frameworkRegistered` (Typer/Flask/Celery
    //     decorator), the framework invokes it by dispatch, not by JS-
    //     style import + call. Analogous to FP-27 for Next.js routing.
    if (hasDunderAll && !publicSet.has(name)) continue;
    if (defInfo.frameworkRegistered) continue;

    dead.push({
      file: relPath(ROOT, defFile),
      symbol: name,
      kind: defInfo.kind,
      line: defInfo.line,
      ...(defInfo.localName ? { localName: defInfo.localName } : {}),
      namespaceShadowed: fileNamespaceUsed,
    });
  }
}

// ─── Symbol fan-in Top-N ─────────────────────────────────
const symbolFanIn = []; // { defFile, symbol, consumerCount, kind }
// P1-0 preparatory: full identity-keyed fan-in map. `topSymbolFanIn` is a
// Top-50 display slice; `fanInByIdentity` is the complete `ownerFile::
// exportedName → count` map P1 pre-write lookup needs. Keyed by identity
// so consumers never conflate two identities sharing a name (see
// canonical/identity-and-alias.md §3).
//
// Contract with supports.identityFanIn=true: EVERY identity that appears
// in `defIndex` gets an entry in `fanInByIdentity`, with value 0 when
// there are no consumers. This lets downstream distinguish "zero observed
// consumers" (grounded 0) from "producer didn't emit" ([확인 불가]). The
// two-pass build below enforces the contract.
const fanInByIdentity = Object.create(null);
// Pass 1: seed every defIndex identity with 0.
for (const [defFile, m] of defIndex) {
  const relFile = relPath(ROOT, defFile);
  for (const symbol of m.keys()) {
    fanInByIdentity[`${relFile}::${symbol}`] = 0;
  }
}
// Pass 2: overlay actual consumer counts.
for (const [defFile, m] of consumers) {
  const relFile = relPath(ROOT, defFile);
  for (const [symbol, cs] of m) {
    symbolFanIn.push({
      defFile: relFile,
      symbol,
      count: cs.size,
      kind: defIndex.get(defFile)?.get(symbol)?.kind ?? 'unknown',
    });
    fanInByIdentity[`${relFile}::${symbol}`] = cs.size;
  }
}
symbolFanIn.sort((a, b) => b.count - a.count);

const anyContaminationFacts = buildAnyContaminationFacts({
  root: ROOT,
  defIndex,
  fileData,
});

// ─── 리포트 ───────────────────────────────────────────────
console.log(`\n\n════════ 1. Top 25 심볼 fan-in ════════`);
for (const s of symbolFanIn.slice(0, 25)) {
  console.log(`  ${s.count.toString().padStart(3)}  ${s.symbol.padEnd(28)}  ${s.kind.padEnd(22)}  ${s.defFile}`);
}

// ─── Dead 요약 ───────────────────────────────────────────
console.log(`\n\n════════ 2. Dead export 후보 ════════`);
console.log(`총 ${dead.length}건 (namespace 사용에 가려진 것 포함)`);
const trulyDead = dead.filter((d) => !d.namespaceShadowed);
const namespaceShadowed = dead.filter((d) => d.namespaceShadowed);
console.log(`  순수 dead (namespace로도 접근 못함): ${trulyDead.length}`);
console.log(`  namespace import로 접근 가능성 있음: ${namespaceShadowed.length}`);

// 순수 dead 세부 (submodule별 분포) — shared workspace-aware classifier.
const submoduleOf = buildSubmoduleResolver(ROOT, repoMode);
const pkgOf = submoduleOf;
const deadByPkg = new Map();
for (const d of trulyDead) {
  const p = pkgOf(d.file);
  if (!deadByPkg.has(p)) deadByPkg.set(p, []);
  deadByPkg.get(p).push(d);
}
console.log(`\n  순수 dead package별 분포:`);
for (const [p, list] of [...deadByPkg.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`    ${p.padEnd(14)}  ${list.length}건`);
}

// Test/production partition for reporting uses the shared classifier in
// `_lib/test-paths.mjs` (absorbs the FP-31 additions once kept locally here).
const deadInTest = trulyDead.filter((d) => isTestLikePath(d.file));
const deadInProd = trulyDead.filter((d) => !isTestLikePath(d.file));
console.log(`\n  순수 dead 중 test 파일: ${deadInTest.length}`);
console.log(`  순수 dead 중 production 파일: ${deadInProd.length}`);

console.log(`\n  ─ production dead 샘플 (최대 25) ─`);
for (const d of deadInProd.slice(0, 25)) {
  console.log(`    ${d.file}:${d.line}  ${d.symbol}  (${d.kind})`);
}

// ─── 저장 ─────────────────────────────────────────────────
const outPath = path.join(output, 'symbols.json');
const artifact = buildSymbolsArtifact({
  root: ROOT,
  files,
  defIndex,
  fileData,
  parseErrors,
  warnings,
  nextCache,
  unresolvedInternalByPrefix,
  prefixExamples,
  unresolvedInternalSpecifiers,
  unresolvedInternalSpecifierRecords,
  languageSupport,
  totalUses,
  unresolvedUses,
  resolvedInternalUses,
  externalUses,
  dependencyImportConsumers,
  resolvedInternalEdges,
  unresolvedInternalUses,
  mdxConsumerUses,
  dead,
  trulyDead,
  deadInProd,
  deadInTest,
  symbolFanIn,
  fanInByIdentity,
  anyContaminationFacts,
  incremental: {
    enabled: incrementalEnabled,
    identityMode: incrementalEnabled ? STRICT_IDENTITY_MODE : null,
    cacheVersion: 1,
    cacheRoot: incrementalEnabled ? cacheStore.cacheRoot : null,
    changedFiles,
    reusedFiles,
    droppedFiles,
    invalidatedFiles,
    reason: incrementalEnabled ? null : 'disabled-by-flag',
  },
});
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`[symbols] ${files.length} files, dead production candidates: ${deadInProd.length}`);
console.log(`[symbols] saved → ${outPath}`);
