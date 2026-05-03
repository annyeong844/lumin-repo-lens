// classify-dead-exports.mjs — Orchestrator.
//
// Reads `symbols.json` (from build-symbol-graph), applies framework
// exclusion policies, extracts per-symbol facts (occurrence count,
// predicate partner, aliasing), assigns each to a category based on the
// occurrence count, and emits a structured `dead-classify.json` proposal
// list.
//
// Category rules:
//   C (0 uses)    → definition can be fully removed
//   A (1–2 uses)  → drop `export` keyword, demote to file-internal
//   B (3+ uses)   → review — likely intentional public API
//
// Aliased `export { local as public }` with a dead `public` goes to its
// own bucket (`proposal_remove_export_specifier`) because removing the
// "definition" would delete the local symbol, which may still be used.
//
// Policy / fact extraction split in v1.7.0:
//   _lib/classify-policies.mjs → config / sentinel / Nuxt detection
//   _lib/classify-facts.mjs    → occurrence counting, predicate, aliasing

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseCliArgs } from '../lib/cli.mjs';
import { detectRepoMode } from '../lib/repo-mode.mjs';
import { buildAliasMap } from '../lib/alias-map.mjs';
import { makeResolver, isResolvedFile } from '../lib/resolver-core.mjs';
import { buildSubmoduleResolver } from '../lib/paths.mjs';
import { collectTestPinnedExports, findTestPinnedExport } from '../lib/contract-pinned-exports.mjs';
import {
  collectHtmlModuleEntrypointFiles,
  collectPackagePublicSurfaceFiles,
  collectScriptEntrypointFiles,
  indexPublicSurfaceEntries,
} from '../lib/public-surface.mjs';
import {
  ACTION_MUTE,
  classifyFrameworkPolicy,
  isConfigFile,
  createFrameworkPolicyContextForRepo,
  createFrameworkPolicyCounters,
  detectVitePress,
  isVitePressSentinel,
  isDeclarationSidecar,
  recordFrameworkPolicyDecision,
} from '../lib/classify-policies.mjs';
import {
  countOccurrencesExceptDefLine,
  countExcludingDeclAndExport,
  countFileReferencesAstMany,
  hasPredicatePartner,
  isAliasedSpec,
} from '../lib/classify-facts.mjs';
import { computeFindingProvenance } from '../lib/finding-provenance.mjs';
import { EVIDENCE, provenanceFields } from '../lib/vocab.mjs';

const cli = parseCliArgs({
  'classify-candidate-limit': { type: 'string' },
  'classify-max-file-bytes': { type: 'string' },
  'classify-progress-ms': { type: 'string' },
  'classify-time-budget-ms': { type: 'string' },
});
const { root: ROOT, output, includeTests, exclude } = cli;

const symbolsPath = path.join(output, 'symbols.json');
const symbolsData = JSON.parse(readFileSync(symbolsPath, 'utf8'));
const classifyStartedAt = Date.now();

function positiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function nonNegativeInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

const configuredCandidateLimit = positiveInt(
  cli.raw['classify-candidate-limit'] ?? process.env.LUMIN_REPO_LENS_CLASSIFY_CANDIDATE_LIMIT,
);
const progressEveryMs = positiveInt(
  cli.raw['classify-progress-ms'] ?? process.env.LUMIN_REPO_LENS_CLASSIFY_PROGRESS_MS,
) ?? 30000;
const timeBudgetMs = nonNegativeInt(
  cli.raw['classify-time-budget-ms'] ?? process.env.LUMIN_REPO_LENS_CLASSIFY_TIME_BUDGET_MS,
) ?? 180000;
const maxClassifyFileBytes = nonNegativeInt(
  cli.raw['classify-max-file-bytes'] ?? process.env.LUMIN_REPO_LENS_CLASSIFY_MAX_FILE_BYTES,
) ?? 0;

function isTimeBudgetExceeded() {
  return timeBudgetMs > 0 && Date.now() - classifyStartedAt >= timeBudgetMs;
}

const allDeadCandidates = Array.isArray(symbolsData.deadProdList)
  ? symbolsData.deadProdList
  : [];
const candidateLimitApplied =
  configuredCandidateLimit !== null && allDeadCandidates.length > configuredCandidateLimit;
const deadList = candidateLimitApplied
  ? allDeadCandidates.slice(0, configuredCandidateLimit)
  : allDeadCandidates;

console.log(
  `[classify] production dead candidates: ${deadList.length}` +
  (candidateLimitApplied ? ` (limited from ${allDeadCandidates.length})` : ''),
);
if (candidateLimitApplied) {
  console.log(
    `[classify] warning: candidate limit applied; artifact is incomplete ` +
    `(limit=${configuredCandidateLimit}).`,
  );
}

// ─── FP-23 / FP-25: public API file set ──────────────────────
// A file reached from any `exports` entry — or transitively from a
// re-export barrel rooted at one — is public API surface. External npm
// dependents may import from it, so the internal-use count is misleading.
// This block owns the graph walk; policies.mjs stays pure.
const repoMode = detectRepoMode(ROOT);
const aliasMap = buildAliasMap(ROOT, repoMode);
const resolve = makeResolver(ROOT, aliasMap);
const submoduleOf = buildSubmoduleResolver(ROOT, repoMode);
const isVitePress = detectVitePress(repoMode.rootPkgJson, repoMode.workspaceDirs);
const frameworkPolicyContext = createFrameworkPolicyContextForRepo({
  root: ROOT,
  repoMode,
  symbolsData,
  deadList,
  includeTests,
  exclude,
});
const frameworkPolicyCounters = createFrameworkPolicyCounters(frameworkPolicyContext);
const isNuxtNitro = frameworkPolicyContext.packages.some((pkg) => pkg.frameworks?.has?.('nuxt'));
const testPins = includeTests === false
  ? collectTestPinnedExports({ root: ROOT, resolve, exclude })
  : { symbolPins: new Map(), namespacePins: new Map(), diagnostics: [] };

const publicApiFiles = new Set();
const publicApiEvidenceByFile = new Map();
const scriptEntrypointFiles = new Set();
const scriptEntrypointEvidenceByFile = new Map();
const htmlEntrypointFiles = new Set();
const htmlEntrypointEvidenceByFile = new Map();

function addEvidenceFile(targetSet, evidenceMap, relPath, evidence) {
  const rel = relPath.replace(/\\/g, '/');
  targetSet.add(rel);
  if (evidence !== undefined) {
    if (!evidenceMap.has(rel)) evidenceMap.set(rel, []);
    evidenceMap.get(rel).push(evidence);
  }
}

function addFileVariants(targetSet, evidenceMap, relPath, evidence) {
  const rel = relPath.replace(/\\/g, '/');
  const variants = new Set([rel]);
  if (/\.tsx$/.test(rel)) variants.add(rel.replace(/\.tsx$/, '.jsx'));
  else if (/\.jsx$/.test(rel)) variants.add(rel.replace(/\.jsx$/, '.tsx'));
  else if (/\.ts$/.test(rel) && !/\.d\.[cm]?ts$/.test(rel)) {
    variants.add(rel.replace(/\.ts$/, '.js'));
  } else if (/\.js$/.test(rel)) {
    variants.add(rel.replace(/\.js$/, '.ts'));
  }
  for (const variant of variants) addEvidenceFile(targetSet, evidenceMap, variant, evidence);
}

function addPublicApiVariants(relPath, evidence) {
  addFileVariants(publicApiFiles, publicApiEvidenceByFile, relPath, evidence);
}

function addScriptEntrypointVariants(relPath, evidence) {
  addFileVariants(scriptEntrypointFiles, scriptEntrypointEvidenceByFile, relPath, evidence);
}

function addHtmlEntrypointVariants(relPath, evidence) {
  addFileVariants(htmlEntrypointFiles, htmlEntrypointEvidenceByFile, relPath, evidence);
}

const publicSurface = indexPublicSurfaceEntries(
  collectPackagePublicSurfaceFiles({ root: ROOT, repoMode }));
for (const [rel, evidence] of publicSurface) {
  for (const item of evidence) addPublicApiVariants(rel, item);
}

const scriptEntrypoints = indexPublicSurfaceEntries(
  collectScriptEntrypointFiles({ root: ROOT, repoMode }));
for (const [rel, evidence] of scriptEntrypoints) {
  for (const item of evidence) addScriptEntrypointVariants(rel, item);
}

const htmlEntrypoints = indexPublicSurfaceEntries(
  collectHtmlModuleEntrypointFiles({ root: ROOT, repoMode }));
for (const [rel, evidence] of htmlEntrypoints) {
  for (const item of evidence) addHtmlEntrypointVariants(rel, item);
}

for (const [spec, entry] of aliasMap) {
  // Node `package.imports` entries (`#internal/*`) are internal aliases,
  // not externally importable package surface. They help the resolver find
  // consumers, but must not mute dead exports as publicApi_FP23.
  if (typeof spec === 'string' && spec.startsWith('#')) continue;
  if (entry.source === 'imports') continue;
  if (entry.type === 'exact' && entry.path) {
    const rel = path.relative(ROOT, entry.path).replace(/\\/g, '/');
    addPublicApiVariants(rel, {
      source: 'alias-map.exact',
      aliasSource: entry.source ?? null,
      resolvedFile: rel,
    });
  }
}

// FP-25 transitive: barrels (`export * from './y'`, `export { X } from './y'`)
// extend the public API set — files reachable from a public entry via
// re-export chains are also public.
let transitiveAdded = 0;
const reExportsByFile = symbolsData.reExportsByFile ?? {};
if (publicApiFiles.size > 0 && Object.keys(reExportsByFile).length > 0) {
  const visited = new Set();
  const queue = [...publicApiFiles].filter((p) => reExportsByFile[p] !== undefined
                                              || publicApiFiles.has(p));
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    const reExports = reExportsByFile[current];
    if (!reExports) continue;
    for (const r of reExports) {
      if (!r.source) continue;
      const fromAbs = path.join(ROOT, current);
      const resolved = resolve(fromAbs, r.source);
      if (!isResolvedFile(resolved)) continue;
      const rel = path.relative(ROOT, resolved).replace(/\\/g, '/');
      if (!publicApiFiles.has(rel)) {
        addPublicApiVariants(rel, {
          source: 'public-reexport',
          fromFile: current,
          specifier: r.source,
          resolvedFile: rel,
        });
        transitiveAdded++;
      }
      if (!visited.has(rel)) queue.push(rel);
    }
  }
}

function isPublicApiFile(relPath) {
  return publicApiFiles.has(relPath.replace(/\\/g, '/'));
}

function isScriptEntrypointFile(relPath) {
  return scriptEntrypointFiles.has(relPath.replace(/\\/g, '/'));
}

function isHtmlEntrypointFile(relPath) {
  return htmlEntrypointFiles.has(relPath.replace(/\\/g, '/'));
}

function findPublicApiEvidence(relPath) {
  return publicApiEvidenceByFile.get(relPath.replace(/\\/g, '/')) ?? [];
}

function findScriptEntrypointEvidence(relPath) {
  return scriptEntrypointEvidenceByFile.get(relPath.replace(/\\/g, '/')) ?? [];
}

function findHtmlEntrypointEvidence(relPath) {
  return htmlEntrypointEvidenceByFile.get(relPath.replace(/\\/g, '/')) ?? [];
}

// v1.10.0 P1: finding-local provenance inputs from symbols.json.
// Pure-function helpers live in `_lib/classify-facts.mjs` so they can
// be unit-tested; here we just wire the orchestrator state to them.
const filesWithParseErrors = Array.isArray(symbolsData.filesWithParseErrors)
  ? symbolsData.filesWithParseErrors
  : [];
const unresolvedInternalSpecifiers = Array.isArray(symbolsData.unresolvedInternalSpecifiers)
  ? symbolsData.unresolvedInternalSpecifiers
  : [];
const unresolvedInternalSpecifierRecords = Array.isArray(symbolsData.unresolvedInternalSpecifierRecords)
  ? symbolsData.unresolvedInternalSpecifierRecords
  : unresolvedInternalSpecifiers;

// ─── Main classification loop ────────────────────────────────
const classified = [];
const fileCache = new Map();
let excludedConfig = 0;
let excludedPublicApi = 0;
let excludedScriptEntrypoint = 0;
let excludedHtmlEntrypoint = 0;
let excludedFramework = 0;
let excludedNuxtNitro = 0;
let excludedVitePress = 0;
let excludedDeclarationSidecar = 0;
let excludedTestConsumer = 0;
let excludedDynamicImportOpacity = 0;

// v1.9.6: materialize exclusions so downstream (rank-fixes.mjs) can
// surface them in the MUTED tier rather than silently dropping them.
// Previously only counts were kept; users saw MUTED always = 0 in
// fix-plan summaries and couldn't audit what the classifier hid.
const excludedCandidates = [];
const unprocessedCandidates = [];

function recordExcluded(d, reason, extra = {}) {
  excludedCandidates.push({
    file: d.file,
    line: d.line,
    symbol: d.symbol,
    kind: d.kind,
    reason,
    ...extra,
  });
}

const dynamicImportOpacityTargets = Array.isArray(symbolsData.dynamicImportOpacity)
  ? symbolsData.dynamicImportOpacity.filter((e) => typeof e?.targetDir === 'string' && e.targetDir.length > 0)
  : [];

function findDynamicImportOpacityEvidence(relPath) {
  const rel = relPath.replace(/\\/g, '/');
  return dynamicImportOpacityTargets.filter((e) => rel.startsWith(e.targetDir));
}

function countNameForEntry(d) {
  return isAliasedSpec(d) ? d.localName : d.symbol;
}

function maybeLogProgress({ phase, processed, total, lastLoggedAtRef }) {
  if (progressEveryMs <= 0) return lastLoggedAtRef.value;
  const now = Date.now();
  if (processed < total && now - lastLoggedAtRef.value < progressEveryMs) {
    return lastLoggedAtRef.value;
  }
  console.log(
    `[classify] progress ${phase}: ${processed}/${total} ` +
    `elapsedMs=${now - classifyStartedAt}`,
  );
  return now;
}

function zeroReferenceResult() {
  return {
    count: 0,
    evidence: EVIDENCE.TEXT_ZERO_REF_COUNT,
    typeRefs: 0,
    valueRefs: 0,
    exportedDeclarationRefs: 0,
    exportedDeclarationRefLines: [],
  };
}

function escapeRegexLiteral(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function hasEscapedIdentifierSyntax(src) {
  return /\\(?:u\{?[0-9a-fA-F]|x[0-9a-fA-F]{2})/.test(src);
}

function isAsciiIdentifierName(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function splitTextZeroRequests(src, requests) {
  const astRequests = [];
  const zeroResults = new Map();
  if (requests.length === 0) return { astRequests, zeroResults };

  // Identifier escapes can make a real reference invisible to literal text
  // matching. In that case we keep the existing AST path for the whole file.
  if (hasEscapedIdentifierSyntax(src)) {
    return { astRequests: requests, zeroResults };
  }

  const eligible = [];
  const ineligible = new Set();
  for (const request of requests) {
    if (isAsciiIdentifierName(request.symbolName)) eligible.push(request);
    else ineligible.add(request.key);
  }
  if (eligible.length === 0) return { astRequests: requests, zeroResults };

  const names = [...new Set(eligible.map((r) => r.symbolName))];
  const byName = new Map();
  for (const request of eligible) {
    if (!byName.has(request.symbolName)) byName.set(request.symbolName, []);
    byName.get(request.symbolName).push(request);
  }

  const occurrenceByKey = new Map();
  for (const request of eligible) {
    occurrenceByKey.set(request.key, { count: 0, lines: new Set() });
  }

  const identBoundary = '[A-Za-z0-9_$]';
  const rx = new RegExp(
    `(^|[^A-Za-z0-9_$])(${names.map(escapeRegexLiteral).join('|')})(?!${identBoundary})`,
    'g',
  );
  const lines = src.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    rx.lastIndex = 0;
    let match;
    while ((match = rx.exec(line)) !== null) {
      const name = match[2];
      const matchingRequests = byName.get(name) ?? [];
      for (const request of matchingRequests) {
        const record = occurrenceByKey.get(request.key);
        record.count++;
        record.lines.add(lineIndex + 1);
      }
    }
  }

  for (const request of requests) {
    if (ineligible.has(request.key)) {
      astRequests.push(request);
      continue;
    }
    const record = occurrenceByKey.get(request.key);
    const onlyDeclarationName =
      record?.count === 1 &&
      record.lines.size === 1 &&
      record.lines.has(request.declLine);
    if (onlyDeclarationName) zeroResults.set(request.key, zeroReferenceResult());
    else astRequests.push(request);
  }

  return { astRequests, zeroResults };
}

const astBatchStartedAt = Date.now();
const astResultByEntry = new Map();
const oversizedAstEntries = new Set();
const astBatchStats = {
  filesAttempted: 0,
  filesRead: 0,
  filesParsed: 0,
  filesWithParseErrors: 0,
  filesWithReadErrors: 0,
  filesSkippedBySize: 0,
  candidatesCounted: 0,
  textZeroCandidates: 0,
  textZeroFiles: 0,
  timeBudgetExceeded: false,
};

const candidatesByFile = new Map();
for (const d of deadList) {
  if (!candidatesByFile.has(d.file)) candidatesByFile.set(d.file, []);
  candidatesByFile.get(d.file).push(d);
}

const astProgressLog = { value: Date.now() };
let astCandidateProgress = 0;
for (const [relFile, entries] of candidatesByFile) {
  if (isTimeBudgetExceeded()) {
    astBatchStats.timeBudgetExceeded = true;
    console.log(
      `[classify] warning: time budget exceeded during ast-batch ` +
      `(budgetMs=${timeBudgetMs}, processed=${astCandidateProgress}/${deadList.length}).`,
    );
    break;
  }
  astBatchStats.filesAttempted++;
  const abs = path.join(ROOT, relFile);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
    fileCache.set(abs, text);
    astBatchStats.filesRead++;
  } catch {
    astBatchStats.filesWithReadErrors++;
    astCandidateProgress += entries.length;
    astProgressLog.value = maybeLogProgress({
      phase: 'ast-batch',
      processed: astCandidateProgress,
      total: deadList.length,
      lastLoggedAtRef: astProgressLog,
    });
    continue;
  }

  const fileBytes = Buffer.byteLength(text, 'utf8');
  if (maxClassifyFileBytes > 0 && fileBytes > maxClassifyFileBytes) {
    astBatchStats.filesSkippedBySize++;
    for (const entry of entries) oversizedAstEntries.add(entry);
    astCandidateProgress += entries.length;
    astProgressLog.value = maybeLogProgress({
      phase: 'ast-batch',
      processed: astCandidateProgress,
      total: deadList.length,
      lastLoggedAtRef: astProgressLog,
    });
    continue;
  }

  const requests = entries.map((d, i) => ({
    key: String(i),
    symbolName: countNameForEntry(d),
    declLine: d.line,
  }));
  const { astRequests, zeroResults } = splitTextZeroRequests(text, requests);
  let fileHadTextZero = false;
  for (let i = 0; i < entries.length; i++) {
    const result = zeroResults.get(String(i));
    if (!result) continue;
    astResultByEntry.set(entries[i], result);
    astBatchStats.textZeroCandidates++;
    fileHadTextZero = true;
  }
  if (fileHadTextZero) astBatchStats.textZeroFiles++;
  if (astRequests.length === 0) {
    astCandidateProgress += entries.length;
    astProgressLog.value = maybeLogProgress({
      phase: 'ast-batch',
      processed: astCandidateProgress,
      total: deadList.length,
      lastLoggedAtRef: astProgressLog,
    });
    continue;
  }

  const results = countFileReferencesAstMany(text, abs, astRequests);
  let fileHadParseError = false;
  for (const request of astRequests) {
    const result = results.get(request.key);
    if (result?.count === null) fileHadParseError = true;
    astResultByEntry.set(entries[Number(request.key)], result);
  }
  if (fileHadParseError) astBatchStats.filesWithParseErrors++;
  else astBatchStats.filesParsed++;
  astBatchStats.candidatesCounted += astRequests.length;
  astCandidateProgress += entries.length;
  astProgressLog.value = maybeLogProgress({
    phase: 'ast-batch',
    processed: astCandidateProgress,
    total: deadList.length,
    lastLoggedAtRef: astProgressLog,
  });
}

function recordUnprocessed(d, reason, extra = {}) {
  unprocessedCandidates.push({
    file: d.file,
    line: d.line,
    symbol: d.symbol,
    kind: d.kind,
    reason,
    ...extra,
  });
}
const astBatchMs = Date.now() - astBatchStartedAt;

const provenanceBaseByFile = new Map();

function computeCachedFindingProvenance(d, evidence, count) {
  const fileKey = String(d.file ?? '').replace(/\\/g, '/');
  let base = provenanceBaseByFile.get(fileKey);
  if (!base) {
    const computed = computeFindingProvenance(d, {
      filesWithParseErrors,
      unresolvedInternalSpecifiers: unresolvedInternalSpecifierRecords,
      aliasMap,
      submoduleOf,
      root: ROOT,
      astEvidence: evidence,
      astCount: count,
    });
    base = {
      taintedBy: computed.taintedBy,
      resolverConfidence: computed.resolverConfidence,
      parseStatus: computed.parseStatus,
    };
    provenanceBaseByFile.set(fileKey, base);
  }
  return {
    supportedBy: [{ kind: evidence, count }],
    taintedBy: base.taintedBy,
    resolverConfidence: base.resolverConfidence,
    parseStatus: base.parseStatus,
  };
}

const classifyLoopStartedAt = Date.now();
const classifyProgressLog = { value: Date.now() };
let classifyProcessed = 0;

for (const d of deadList) {
  classifyProcessed++;
  classifyProgressLog.value = maybeLogProgress({
    phase: 'classify-loop',
    processed: classifyProcessed,
    total: deadList.length,
    lastLoggedAtRef: classifyProgressLog,
  });

  // Policy filters — in order. Each short-circuits the symbol out of
  // classification but still records it in excludedCandidates.
  if (isConfigFile(d.file))                          { excludedConfig++;    recordExcluded(d, 'config_FP22');             continue; }
  if (isPublicApiFile(d.file))                       { excludedPublicApi++; recordExcluded(d, 'publicApi_FP23', { policyEvidence: findPublicApiEvidence(d.file) }); continue; }
  if (isScriptEntrypointFile(d.file))                 { excludedScriptEntrypoint++; recordExcluded(d, 'scriptEntrypoint_FP45', { policyEvidence: findScriptEntrypointEvidence(d.file) }); continue; }
  if (isHtmlEntrypointFile(d.file))                   { excludedHtmlEntrypoint++; recordExcluded(d, 'htmlEntrypoint_FP47', { policyEvidence: findHtmlEntrypointEvidence(d.file) }); continue; }
  const frameworkPolicyDecision = classifyFrameworkPolicy(frameworkPolicyContext, {
    file: d.file,
    exportName: d.symbol,
    kind: d.kind,
  });
  recordFrameworkPolicyDecision(frameworkPolicyCounters, frameworkPolicyDecision, d);
  if (frameworkPolicyDecision.action === ACTION_MUTE) {
    if (frameworkPolicyDecision.reason === 'nuxtNitro_FP30') excludedNuxtNitro++;
    else excludedFramework++;
    recordExcluded(d, frameworkPolicyDecision.reason, {
      policyEvidence: frameworkPolicyDecision.evidence,
    });
    continue;
  }
  if (isVitePress && isVitePressSentinel(d.file))     { excludedVitePress++; recordExcluded(d, 'vitePress_FP46');          continue; }
  if (isDeclarationSidecar(d.file, ROOT))             { excludedDeclarationSidecar++; recordExcluded(d, 'declarationSidecar_FP48'); continue; }
  const dynamicOpacityEvidence = findDynamicImportOpacityEvidence(d.file);
  if (dynamicOpacityEvidence.length > 0) {
    excludedDynamicImportOpacity++;
    recordExcluded(d, 'dynamicImportOpacity_FP18', {
      policyEvidence: dynamicOpacityEvidence.slice(0, 5),
    });
    continue;
  }
  const testPin = findTestPinnedExport(testPins, d);
  if (testPin) {
    excludedTestConsumer++;
    recordExcluded(d, 'testConsumer_FP44', { policyEvidence: testPin });
    continue;
  }

  // Load source once per file — cached so repeated dead symbols in the
  // same file don't re-read.
  const abs = path.join(ROOT, d.file);
  let text = fileCache.get(abs);
  if (text === undefined) {
    try { text = readFileSync(abs, 'utf8'); fileCache.set(abs, text); }
    catch { continue; }
  }

  // Fact extraction. For aliased specs we count the LOCAL name's uses
  // (not the exported alias, which only appears on the export line).
  //
  // v1.10.0: AST identifier references are primary. Regex-text counting
  // is retained as a fallback for files whose source text doesn't parse
  // (malformed code, WIP edits, etc.) — `countFileReferencesAst` returns
  // `{count: null, evidence: 'parse-error'}` in that case and we demote
  // to the old regex path. Evidence label propagates to the artifact so
  // downstream consumers (rank-fixes, SARIF, Claude) know which rung of
  // precision produced this finding.
  const aliased = isAliasedSpec(d);
  const nameForCount = aliased ? d.localName : d.symbol;
  const astResult = astResultByEntry.get(d);
  if (!astResult) {
    const reason = oversizedAstEntries.has(d)
      ? 'classify-max-file-bytes'
      : astBatchStats.timeBudgetExceeded
        ? 'classify-time-budget'
        : 'source-read-error';
    recordUnprocessed(d, reason);
    continue;
  }

  let occ, evidence, typeRefs, valueRefs, parseError;
  let exportedDeclarationRefs = 0;
  let exportedDeclarationRefLines = [];
  if (astResult.count !== null) {
    occ = astResult.count;
    evidence = astResult.evidence; // 'ast-ident-ref-count'
    typeRefs = astResult.typeRefs;
    valueRefs = astResult.valueRefs;
    exportedDeclarationRefs = astResult.exportedDeclarationRefs ?? 0;
    exportedDeclarationRefLines = astResult.exportedDeclarationRefLines ?? [];
  } else {
    // Parse failed — fall back to regex counting, mark evidence so the
    // downgraded confidence is visible.
    occ = aliased
      ? countExcludingDeclAndExport(text, d.localName, d.line)
      : countOccurrencesExceptDefLine(text, d.symbol, d.line);
    evidence = EVIDENCE.REGEX_FALLBACK;
    typeRefs = 0;
    valueRefs = 0;
    parseError = astResult.parseError;
  }
  const predicate = hasPredicatePartner(text, d.symbol);

  // Categorize on occurrence count. Counter completeness matters —
  // `occ === 0` means "zero Identifier + JSXIdentifier + JSXMember-top
  // references", not "zero occurrences via any mechanism". Adding a new
  // reference surface to the AST walker (future TS proposals, etc.)
  // must be paired with re-evaluation of these boundaries. FP-41 was
  // precisely this shape: the walker missed JSXIdentifier, so compound-
  // component symbols hit occ === 0 and escalated to Tier C.
  let category;
  if (occ === 0)      category = 'C-completely-dead';
  else if (occ <= 2)  category = 'A-remove-export';
  else                category = 'B-file-internal-hub';

  // v1.10.0 P1: per-finding provenance. Replaces the repo-global
  // unresolvedInternalRatio gate with local taint evidence so findings
  // in unaffected parts of the repo keep their normal tier.
  const provenance = computeCachedFindingProvenance(d, evidence, occ);

  classified.push({
    ...d,
    fileInternalUses: occ,
    fileInternalUsesEvidence: evidence,
    // Provenance split (value vs type position). Empty on parse-error
    // fallback — the regex counter can't distinguish.
    fileInternalRefs: { typeRefs, valueRefs },
    ...(exportedDeclarationRefs > 0
      ? {
          declarationExportDependency: true,
          declarationExportRefs: {
            count: exportedDeclarationRefs,
            lines: exportedDeclarationRefLines.slice(0, 10),
          },
        }
      : {}),
    ...(parseError ? { parseError } : {}),
    ...(aliased ? { localInternalUses: occ } : {}),
    predicatePartner: predicate,
    category,
    supportedBy: provenance.supportedBy,
    taintedBy: provenance.taintedBy,
    resolverConfidence: provenance.resolverConfidence,
    parseStatus: provenance.parseStatus,
  });
}

const classifyLoopMs = Date.now() - classifyLoopStartedAt;

// ─── Reporting ───────────────────────────────────────────────
const byCategory = {
  'C-completely-dead': [],
  'A-remove-export': [],
  'B-file-internal-hub': [],
};
for (const c of classified) byCategory[c.category].push(c);

const excludedAny = excludedConfig || excludedPublicApi || excludedScriptEntrypoint ||
  excludedHtmlEntrypoint || transitiveAdded || excludedFramework || excludedNuxtNitro ||
  excludedVitePress || excludedDeclarationSidecar || excludedDynamicImportOpacity ||
  excludedTestConsumer;
if (excludedAny) {
  console.log(`\n  [FP-22 excluded] config files: ${excludedConfig}`);
  console.log(`  [FP-23 excluded] public API (pkg.exports target): ${excludedPublicApi}`);
  console.log(`  [FP-45 excluded] script-driven build entrypoints: ${excludedScriptEntrypoint}`);
  console.log(`  [FP-47 excluded] HTML module entrypoints: ${excludedHtmlEntrypoint}`);
  if (transitiveAdded > 0) {
    console.log(`  [FP-25 expanded] transitive barrel re-exports: +${transitiveAdded} files reachable via public entries`);
  }
  console.log(`  [FP-27 excluded] framework sentinel files (Next.js / SvelteKit routing): ${excludedFramework}`);
  if (isNuxtNitro) {
    console.log(`  [FP-30 excluded] Nuxt/Nitro filesystem-routed files: ${excludedNuxtNitro}`);
  }
  if (isVitePress) {
    console.log(`  [FP-46 excluded] VitePress convention files: ${excludedVitePress}`);
  }
  console.log(`  [FP-48 excluded] JS declaration sidecars: ${excludedDeclarationSidecar}`);
  console.log(`  [FP-18 excluded] dynamic import opacity target dirs: ${excludedDynamicImportOpacity}`);
  if (includeTests === false) {
    console.log(`  [FP-44 excluded] test-pinned contract exports: ${excludedTestConsumer}`);
  }
}

console.log(`\n══════ 분류 결과 ══════`);
console.log(`  C (완전 dead, 내부 사용 0회)    : ${byCategory['C-completely-dead'].length}건`);
console.log(`  A (export 제거 가능, 1~2회)     : ${byCategory['A-remove-export'].length}건`);
console.log(`  B (파일 내부 중심, 3회+)        : ${byCategory['B-file-internal-hub'].length}건`);
if (unprocessedCandidates.length > 0) {
  console.log(`  DEGRADED (classify 미완료)       : ${unprocessedCandidates.length}건`);
}
console.log(`  합계                            : ${classified.length}건`);

const withPredicate = classified.filter((c) => c.predicatePartner);
console.log(`\n  predicate 동반 (isX/assertX 등): ${withPredicate.length}건`);
console.log(`    → 이 중 A 카테고리: ${withPredicate.filter((c) => c.category === 'A-remove-export').length}`);
console.log(`    → 이 중 B 카테고리: ${withPredicate.filter((c) => c.category === 'B-file-internal-hub').length}`);
console.log(`    → 이 중 C 카테고리: ${withPredicate.filter((c) => c.category === 'C-completely-dead').length}`);

console.log(`\n  kind 분포:`);
const byKind = new Map();
for (const c of classified) byKind.set(c.kind, (byKind.get(c.kind) || 0) + 1);
for (const [k, v] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(25)}  ${v}건`);
}

// Package breakdown — shared workspace-aware classifier (see _lib/paths.mjs).
const pkgOf = submoduleOf;

const pkgCat = {};
for (const c of classified) {
  const p = pkgOf(c.file);
  if (!pkgCat[p]) pkgCat[p] = { C: 0, A: 0, B: 0, total: 0 };
  if (c.category === 'C-completely-dead') pkgCat[p].C++;
  else if (c.category === 'A-remove-export') pkgCat[p].A++;
  else pkgCat[p].B++;
  pkgCat[p].total++;
}
console.log(`\n  package별 × category:`);
const labelWidth = Math.max(14, ...Object.keys(pkgCat).map((k) => k.length));
console.log(`    ${'package'.padEnd(labelWidth)}    C(완전dead)  A(export제거)  B(내부hub)  합`);
for (const [p, s] of Object.entries(pkgCat)) {
  console.log(
    `    ${p.padEnd(labelWidth)}    ${s.C.toString().padStart(4)}         ${s.A.toString().padStart(4)}          ${s.B.toString().padStart(4)}      ${s.total}`,
  );
}

function printSamples(label, list, n) {
  console.log(`\n── ${label} 샘플 (${list.length}건 중 최대 ${n}) ──`);
  for (const c of list.slice(0, n)) {
    const pred = c.predicatePartner ? `  [predicate: ${c.predicatePartner}]` : '';
    console.log(`  ${c.file}:${c.line}  ${c.symbol}  (${c.kind}, 내부사용 ${c.fileInternalUses}회)${pred}`);
  }
}

printSamples('C (완전 dead)', byCategory['C-completely-dead'], 20);
printSamples('A (export 제거 가능)', byCategory['A-remove-export'], 20);
printSamples('B (파일 내부 hub)', byCategory['B-file-internal-hub'], 20);

// ─── Proposal artifact ───────────────────────────────────────
const aliasedDead = classified.filter(isAliasedSpec);
const nonAliasedC = byCategory['C-completely-dead'].filter((c) => !isAliasedSpec(c));
const nonAliasedA = byCategory['A-remove-export'].filter((c) => !isAliasedSpec(c));
const nonAliasedB = byCategory['B-file-internal-hub'].filter((c) => !isAliasedSpec(c));
const classifyIncomplete = candidateLimitApplied ||
  astBatchStats.timeBudgetExceeded ||
  unprocessedCandidates.length > 0;

// Provenance forwarder moved to `_lib/vocab.mjs` in v1.10.1 — one
// definition, every bucket mapper uses it via `...provenanceFields(c)`.
// Adding a new provenance field is a single-point change in vocab.mjs.

const removalProposal = {
  summary: {
    total: classified.length,
    category_C: byCategory['C-completely-dead'].length,
    category_A: byCategory['A-remove-export'].length,
    category_B: byCategory['B-file-internal-hub'].length,
    aliased_export_specifier: aliasedDead.length,
    with_predicate: withPredicate.length,
    excluded: {
      config_FP22: excludedConfig,
      publicApi_FP23: excludedPublicApi,
      scriptEntrypoint_FP45: excludedScriptEntrypoint,
      htmlEntrypoint_FP47: excludedHtmlEntrypoint,
      frameworkSentinel_FP27: excludedFramework,
      nuxtNitro_FP30: excludedNuxtNitro,
      vitePress_FP46: excludedVitePress,
      declarationSidecar_FP48: excludedDeclarationSidecar,
      dynamicImportOpacity_FP18: excludedDynamicImportOpacity,
      testConsumer_FP44: excludedTestConsumer,
      transitiveBarrelAdded_FP25: transitiveAdded,
      isNuxtNitroDetected: isNuxtNitro,
      testConsumerDiagnostics_FP44: testPins.diagnostics.length,
    },
    frameworkPolicy: frameworkPolicyCounters,
    incomplete: classifyIncomplete,
    performance: {
      deadCandidatesTotal: allDeadCandidates.length,
      deadCandidatesProcessed: deadList.length,
      candidateLimit: configuredCandidateLimit,
      candidateLimitApplied,
      timeBudgetMs,
      timeBudgetExceeded: astBatchStats.timeBudgetExceeded,
      maxFileBytes: maxClassifyFileBytes,
      unprocessedCandidates: unprocessedCandidates.length,
      fileCacheEntries: fileCache.size,
      astFilesAttempted: astBatchStats.filesAttempted,
      astFilesRead: astBatchStats.filesRead,
      astFilesParsed: astBatchStats.filesParsed,
      astParseErrorFiles: astBatchStats.filesWithParseErrors,
      astReadErrorFiles: astBatchStats.filesWithReadErrors,
      astFilesSkippedBySize: astBatchStats.filesSkippedBySize,
      astCandidatesCounted: astBatchStats.candidatesCounted,
      textZeroCandidates: astBatchStats.textZeroCandidates,
      textZeroFiles: astBatchStats.textZeroFiles,
      provenanceCacheEntries: provenanceBaseByFile.size,
      astBatchMs,
      classifyLoopMs,
      totalMs: Date.now() - classifyStartedAt,
    },
  },
  proposal_remove_export_specifier: aliasedDead.map((c) => {
    const localAlsoDead = (c.localInternalUses ?? 0) === 0;
    return {
      file: c.file,
      line: c.line,
      symbol: c.symbol,
      localName: c.localName,
      kind: c.kind,
      localInternalUses: c.localInternalUses ?? 0,
      localAlsoDead,
      action: localAlsoDead
        ? `\`export { ${c.localName} as ${c.symbol} }\` 제거. 참고: \`${c.localName}\` 도 파일 내 다른 곳에서 쓰이지 않음 — 정의도 함께 제거 후보.`
        : `\`export { ${c.localName} as ${c.symbol} }\` 제거만. \`${c.localName}\` 은 파일 내부에서 사용 중이므로 정의는 유지.`,
      ...provenanceFields(c),
    };
  }),
  proposal_C_remove_symbol: nonAliasedC.map((c) => ({
    file: c.file,
    line: c.line,
    symbol: c.symbol,
    kind: c.kind,
    fileInternalUses: c.fileInternalUses,
    action: '정의 자체 제거 가능. 어디서도 쓰이지 않음.',
    ...provenanceFields(c),
  })),
  proposal_A_demote_to_internal: nonAliasedA.map((c) => ({
    file: c.file,
    line: c.line,
    symbol: c.symbol,
    kind: c.kind,
    fileInternalUses: c.fileInternalUses,
    action: 'export 제거. 파일 내부 타입/함수로 강등.',
    ...provenanceFields(c),
  })),
  proposal_B_review: nonAliasedB.map((c) => ({
    file: c.file,
    line: c.line,
    symbol: c.symbol,
    kind: c.kind,
    fileInternalUses: c.fileInternalUses,
    predicatePartner: c.predicatePartner,
    action:
      c.predicatePartner
        ? `predicate(${c.predicatePartner}) 존재. type + predicate 패턴일 가능성. 유지 권장.`
        : '파일 내 중심 타입. 설계상 public API 의도인지 확인 후 결정.',
    ...provenanceFields(c),
  })),
  proposal_DEGRADED_unprocessed: unprocessedCandidates.map((c) => ({
    file: c.file,
    line: c.line,
    symbol: c.symbol,
    kind: c.kind,
    reason: c.reason,
    action: 'classification incomplete; rerun with a larger classify time budget before making removal claims.',
  })),
  // v1.9.6: exposed for rank-fixes → fix-plan.MUTED tier materialization.
  // Each entry has {file, line, symbol, kind, reason}. reason is one of:
  //   config_FP22 / publicApi_FP23 / frameworkSentinel_FP27 / nuxtNitro_FP30
  //   / testConsumer_FP44 / scriptEntrypoint_FP45 / vitePress_FP46 / htmlEntrypoint_FP47
  //   / dynamicImportOpacity_FP18
  excludedCandidates,
};

const outPath = path.join(output, 'dead-classify.json');
writeFileSync(outPath, JSON.stringify(removalProposal, null, 2));
console.log(`[classify] saved → ${outPath}`);
