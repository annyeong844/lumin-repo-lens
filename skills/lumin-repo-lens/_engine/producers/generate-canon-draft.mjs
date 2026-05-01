#!/usr/bin/env node
// generate-canon-draft.mjs — P3 CLI entry for canon draft generation.
//
// Flags per `maintainer history notes` v2 §4.4 + `maintainer history notes` v2 §4.4:
//   --root <path>                             repository root (required)
//   --output <dir>                            pipeline artifact dir (required)
//   --canon-output <dir>                      draft output dir (default: <root>/canonical-draft/)
//   --source <type-ownership | helper-registry>  P3-1 / P3-2 supported
//   --include-tests / --no-include-tests / --production / --exclude  scan-range flags
//
// Exit codes:
//   0 — draft emitted
//   1 — missing required flag, unsupported --source, fatal I/O
//
// This is a STANDALONE CLI. The `audit-repo.mjs --canon-draft` orchestrator
// hook lands in P3-4. Invoking `audit-repo.mjs --canon-draft` before P3-4
// should fail; this file does not guard that — `audit-repo.mjs` does.

import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseCliArgs } from '../lib/cli.mjs';
import { loadIfExists } from '../lib/artifacts.mjs';
import {
  CANON_DRAFT_SOURCES,
  LOW_INFO_NAMES,
  LOW_INFO_HELPER_NAMES,
} from '../lib/canon-draft-utils.mjs';
import { collectTypeIdentities, renderTypeOwnership } from '../lib/canon-draft-types.mjs';
import { collectHelperIdentities, renderHelperRegistry } from '../lib/canon-draft-helpers.mjs';
import { collectTopologyStructure, renderTopology } from '../lib/canon-draft-topology.mjs';
import { collectNamingCohorts, renderNaming } from '../lib/canon-draft-naming.mjs';
import { atomicWrite } from '../lib/atomic-write.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { extractDefinitionsAndUses } from '../lib/extract-ts.mjs';
import { detectRepoMode } from '../lib/repo-mode.mjs';
import { buildAliasMap } from '../lib/alias-map.mjs';
import { makeResolver, isResolvedFile } from '../lib/resolver-core.mjs';

function die(msg, code = 1) {
  process.stderr.write(`[canon-draft] ${msg}\n`);
  process.exit(code);
}

// ── Parse args ───────────────────────────────────────────────

const args = parseCliArgs({
  'canon-output': { type: 'string' },
  source: { type: 'string' },
  'no-include-tests': { type: 'boolean', default: false },
});

if (!args.raw?.root) die('--root <path> is required');
if (!args.raw?.output) die('--output <dir> is required');

const source = args.raw?.source;
const ACCEPTED_SOURCES = new Set(CANON_DRAFT_SOURCES);
if (!ACCEPTED_SOURCES.has(source)) {
  die(`--source must be one of {${CANON_DRAFT_SOURCES.join(', ')}} (got: ${source ?? '<missing>'}).`);
}

const ROOT = args.root;
const OUTPUT = args.output;
const CANON_OUT = args.raw?.['canon-output']
  ? path.resolve(args.raw['canon-output'])
  : path.join(ROOT, 'canonical-draft');
mkdirSync(CANON_OUT, { recursive: true });

// ── Non-overwrite versioning (shared across sources) ──────

/**
 * Pick `<baseName>.md` if absent; else the next `<stem>.v{N}.md`.
 * Deterministic, race-tolerant-enough for dev flow (manual review follows).
 */
function versionedDraftPath(baseName) {
  const basePath = path.join(CANON_OUT, baseName);
  if (!existsSync(basePath)) return basePath;
  const stem = baseName.replace(/\.md$/, '');
  const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\.v(\\d+)\\.md$`);
  const entries = readdirSync(CANON_OUT);
  let maxN = 1;
  for (const e of entries) {
    const m = e.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxN) maxN = n;
    }
  }
  return path.join(CANON_OUT, `${stem}.v${maxN + 1}.md`);
}

// ── Scope string (honesty: reflects actual includeTests) ──

const scope = args.includeTests
  ? 'TS/JS including tests'
  : 'TS/JS production files';

// ── Emit helper (B-1 dispatch dedup) ──────────────────────
//
// Each source block used to repeat versionedDraftPath + atomicWrite +
// stderr + exit. Consolidated here so a new source (or `check-canon` in
// Post-P3) reuses the same tail.
function emitDraft({ baseName, md, summaryLine }) {
  const writePath = versionedDraftPath(baseName);
  atomicWrite(writePath, md);
  process.stderr.write(`[canon-draft] ${summaryLine}\n`);
  process.stderr.write(`[canon-draft] saved → ${writePath}\n`);
  process.exit(0);
}

// ══ Source dispatch ═════════════════════════════════════

if (source === 'type-ownership') {
  const symbols = loadIfExists(OUTPUT, 'symbols.json', { tag: 'canon-draft' });
  const shapeIndex = loadIfExists(OUTPUT, 'shape-index.json', { tag: 'canon-draft' });
  if (!symbols) {
    process.stderr.write(`[canon-draft] symbols.json not found in ${OUTPUT} — drafting from empty aggregation (fresh AST pass not wired in P3-1 v1).\n`);
  }

  const {
    typeDefsByIdentity,
    identitiesByName,
    typeUsesByIdentity,
    diagnostics,
  } = collectTypeIdentities({
    symbols,
    root: ROOT,
    includeTests: args.includeTests,
    exclude: args.exclude,
  });

  const existingCanon = existsSync(path.join(ROOT, 'canonical', 'type-ownership.md'));
  const md = renderTypeOwnership({
    typeDefsByIdentity,
    identitiesByName,
    typeUsesByIdentity,
    diagnostics,
    shapeIndex,
    meta: {
      scope,
      source: symbols ? 'symbols.json' : 'fresh-ast-pass',
      barrelsOpaque: !symbols,
      existingCanon,
      generated: new Date().toISOString(),
      inputsPresence: {
        'symbols.json': Boolean(symbols),
        'shape-index.json': Boolean(shapeIndex),
      },
    },
  });

  emitDraft({
    baseName: 'type-ownership.md',
    md,
    summaryLine: `${typeDefsByIdentity.size} type identities, ${diagnostics.length} diagnostics`,
  });
}

// ── helper-registry path (P3-2) ───────────────────────────

if (source === 'helper-registry') {
  // Fresh AST pass is the primary data source per maintainer history notes v2 PF-3.
  // call-graph.json + symbols.json are OPTIONAL enrichment / cross-check.
  const files = collectFiles(ROOT, {
    includeTests: args.includeTests,
    exclude: args.exclude,
  });

  // Resolver wrapper — normalizes sentinels to null (only real file paths
  // count as "resolved" for helper-owner attribution).
  const repoMode = detectRepoMode(ROOT);
  const aliasMap = buildAliasMap(ROOT, repoMode);
  const rawResolver = makeResolver(ROOT, aliasMap);
  function resolveSpecifier(fromFile, spec) {
    const r = rawResolver(fromFile, spec);
    return isResolvedFile(r) ? r : null;
  }

  const symbols = loadIfExists(OUTPUT, 'symbols.json', { tag: 'canon-draft' });
  const callGraph = loadIfExists(OUTPUT, 'call-graph.json', { tag: 'canon-draft' });
  if (!callGraph) {
    process.stderr.write(`[canon-draft] call-graph.json not found in ${OUTPUT} — helper fan-in derives from AST only; cross-check diagnostics skipped.\n`);
  }

  const {
    helperDefsByIdentity,
    helpersByName,
    distinctConsumerFiles,
    diagnostics,
    meta: aggregateMeta,
  } = collectHelperIdentities({
    files,
    root: ROOT,
    extractFn: extractDefinitionsAndUses,
    resolveSpecifier,
    symbols,
    callGraph,
  });

  const existingCanon = existsSync(path.join(ROOT, 'canonical', 'helper-registry.md'));

  // Compute the call-graph age (hours) for the header warning — the aggregator
  // already classified staleness, but the renderer wants the age value in prose.
  let callGraphAgeHours;
  if (callGraph?.meta?.generated) {
    const ts = Date.parse(callGraph.meta.generated);
    if (Number.isFinite(ts)) {
      callGraphAgeHours = (Date.now() - ts) / (1000 * 60 * 60);
    }
  }

  const md = renderHelperRegistry({
    helperDefsByIdentity,
    helpersByName,
    distinctConsumerFiles,
    diagnostics,
    meta: {
      scope,
      source: symbols ? 'fresh-ast-pass + symbols.json' : 'fresh-ast-pass',
      helperContamination: aggregateMeta.helperContamination,
      callGraphStaleness: aggregateMeta.callGraphStaleness,
      callGraphAgeHours,
      existingCanon,
      generated: new Date().toISOString(),
      inputsPresence: {
        'symbols.json': Boolean(symbols),
        'symbols.json.reExportsByFile': Boolean(symbols?.reExportsByFile),
        'symbols.json.helperOwnersByIdentity': Boolean(symbols?.helperOwnersByIdentity),
        'call-graph.json': Boolean(callGraph),
      },
    },
  });

  emitDraft({
    baseName: 'helper-registry.md',
    md,
    summaryLine: `${helperDefsByIdentity.size} helper identities, ${diagnostics.length} diagnostics (mode=${aggregateMeta.helperContamination}, callGraph=${aggregateMeta.callGraphStaleness})`,
  });
}

// ── topology path (P3-3) ──────────────────────────────────
//
// Hard dependency on `topology.json` (PF-4). Absent → exit 2.
// `triage.json` is optional secondary input.

if (source === 'topology') {
  const topology = loadIfExists(OUTPUT, 'topology.json', { tag: 'canon-draft' });
  if (!topology) {
    process.stderr.write(`[canon-draft] topology.json not found in ${OUTPUT}. Run: node measure-topology.mjs --root ${ROOT} --output ${OUTPUT}\n`);
    process.exit(2);
  }

  const triage = loadIfExists(OUTPUT, 'triage.json', { tag: 'canon-draft' });
  if (!triage) {
    process.stderr.write(`[canon-draft] triage.json not found in ${OUTPUT} — workspace boundaries section omitted; submodule inventory derives from topology.nodes top-dir fallback.\n`);
  }

  const {
    submodulesByPath,
    crossEdgesForDisplay,
    sccs,
    oversizeFiles,
    workspaces,
    diagnostics,
    meta: aggregateMeta,
  } = collectTopologyStructure({ topology, triage });

  const existingCanon = existsSync(path.join(ROOT, 'canonical', 'topology.md'));

  const md = renderTopology({
    submodulesByPath,
    crossEdgesForDisplay,
    sccs,
    oversizeFiles,
    workspaces,
    diagnostics,
    meta: {
      ...aggregateMeta,
      scope,
      source: triage ? 'topology.json + triage.json' : 'topology.json',
      existingCanon,
      generated: new Date().toISOString(),
    },
  });

  emitDraft({
    baseName: 'topology.md',
    md,
    summaryLine: `${submodulesByPath.size} submodules, ${sccs.length} SCCs, ${oversizeFiles.length} oversize files, ${diagnostics.length} diagnostics (crossEdgeSource=${aggregateMeta.crossEdgeSource}, confidence=${aggregateMeta.classificationConfidence})`,
  });
}

// ── naming path (P3-4) ────────────────────────────────────
//
// Fresh AST pass. File cohorts ALWAYS use collectFiles (P0-6).
// Symbol cohorts from fresh `extractDefinitionsAndUses`.

if (source === 'naming') {
  const files = collectFiles(ROOT, {
    includeTests: args.includeTests,
    exclude: args.exclude,
  });

  // Reuse submodule resolver from paths.mjs (same pattern as topology).
  const { buildSubmoduleResolver } = await import('../lib/paths.mjs');
  const { detectRepoMode: detectMode } = await import('../lib/repo-mode.mjs');
  const repoMode = detectMode(ROOT);
  const submoduleOf = buildSubmoduleResolver(ROOT, repoMode);

  const {
    fileCohorts,
    symbolCohorts,
    perItemRows,
    diagnostics,
    meta: aggregateMeta,
  } = collectNamingCohorts({
    files,
    root: ROOT,
    extractFn: extractDefinitionsAndUses,
    submoduleOf,
    lowInfoNames: new Set(LOW_INFO_NAMES),
    lowInfoHelperNames: new Set(LOW_INFO_HELPER_NAMES),
  });

  const existingCanon = existsSync(path.join(ROOT, 'canonical', 'naming.md'));

  const md = renderNaming({
    fileCohorts,
    symbolCohorts,
    perItemRows,
    diagnostics,
    meta: {
      scope,
      source: 'fresh-ast-pass',
      existingCanon,
      generated: new Date().toISOString(),
    },
  });

  emitDraft({
    baseName: 'naming.md',
    md,
    summaryLine: `${fileCohorts.size} file cohorts, ${symbolCohorts.size} symbol cohorts, ${aggregateMeta.outlierCount} outliers, ${aggregateMeta.lowInfoExcludedCount} low-info-excluded, ${diagnostics.length} diagnostics`,
  });
}
