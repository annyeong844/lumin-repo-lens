#!/usr/bin/env node
// check-canon.mjs — P5 canon drift detector CLI.
//
// v4 (P5-4): --source type-ownership | helper-registry | topology | naming | all.
// `all` is single-invocation aggregation across all 4 engines. All deferred
// sources empty — P5 source enum complete.
//
// Contract: canonical/canon-drift.md v1.1 §6 JSON shape + exit code matrices
// from maintainer history notes §4.3 (type-ownership) + maintainer history notes §4.3 (helper-registry)
// + maintainer history notes §4.3 (topology) + maintainer history notes §4.3 (naming + --source all).
//
// Exit codes (single source):
//   0 — perSource[source].status === "clean"
//   1 — driftCount > 0
//   2 — parse-error / skipped-unrecognized-schema / skipped-missing-canon /
//       missing-required-flag / unknown-source /
//       (type-ownership only) missing or corrupt symbols.json
//       (topology only)       missing or corrupt topology.json
//
// Exit codes (--source all, p5-4.md §4.3 checked-source rule):
//   Aggregate by checked-source (status ∈ {clean, drift}) — missing canon
//   on some sources does NOT hard-fail the aggregate.
//     checked.length === 0           → 2
//     any failed (parse-error/…)     → 2
//     any drift in checked           → 1
//     else                           → 0

import path from 'node:path';
import { existsSync } from 'node:fs';
import { parseCliArgs } from '../lib/cli.mjs';
import { readJsonFile, loadIfExists, producerMetaBase } from '../lib/artifacts.mjs';
import {
  buildCanonDriftJsonObject,
  TYPE_LABEL_SET,
  HELPER_LABEL_SET,
  TOPOLOGY_LABEL_SET,
  NAMING_LABEL_SET,
} from '../lib/check-canon-utils.mjs';
import { writeCanonDriftArtifacts } from '../lib/check-canon-artifact.mjs';
import { detectTypeOwnershipDrift } from '../lib/check-canon-types.mjs';
import { detectHelperRegistryDrift } from '../lib/check-canon-helpers.mjs';
import { detectTopologyDrift } from '../lib/check-canon-topology.mjs';
import { detectNamingDrift } from '../lib/check-canon-naming.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { extractDefinitionsAndUses } from '../lib/extract-ts.mjs';
import { detectRepoMode } from '../lib/repo-mode.mjs';
import { buildAliasMap } from '../lib/alias-map.mjs';
import { makeResolver, isResolvedFile } from '../lib/resolver-core.mjs';
import { LOW_INFO_NAMES, LOW_INFO_HELPER_NAMES } from '../lib/canon-draft-utils.mjs';
import { buildSubmoduleResolver } from '../lib/paths.mjs';

function die(msg, code = 2) {
  process.stderr.write(`[check-canon] ${msg}\n`);
  process.exit(code);
}

const DEFERRED_SOURCES = {};  // P5 source enum complete

const SINGLE_SOURCES = ['type-ownership', 'helper-registry', 'topology', 'naming'];
const SUPPORTED_SOURCES = new Set([...SINGLE_SOURCES, 'all']);

const cli = parseCliArgs({
  source:     { type: 'string' },
  'canon-dir': { type: 'string' },
  strict:     { type: 'boolean', default: false },
});

const source = cli.raw.source;
if (!source) {
  die('--source required (v4: type-ownership | helper-registry | topology | naming | all)');
}

if (source in DEFERRED_SOURCES) {
  die(`--source=${source} not yet implemented.`);
}

if (!SUPPORTED_SOURCES.has(source)) {
  die(`unknown --source value: ${source}. Supported: ${[...SUPPORTED_SOURCES].join(', ')}.`);
}

const canonDir = cli.raw['canon-dir']
  ? path.resolve(cli.raw['canon-dir'])
  : path.join(cli.root, 'canonical');

const output = cli.output;

// ─── Per-source dispatchers ──────────────────────────────────

function dispatchTypeOwnership() {
  const canonPath = path.join(canonDir, 'type-ownership.md');
  const symbolsPath = path.join(output, 'symbols.json');
  if (!existsSync(symbolsPath)) {
    die(`symbols.json not found in --output directory: ${output}. Run 'build-symbol-graph.mjs --output ${output}' or 'audit-repo.mjs --pre-write --output ${output}' first.`);
  }
  let symbols;
  try {
    symbols = readJsonFile(symbolsPath, { tag: 'check-canon', strict: true });
  } catch (e) {
    die(`failed to load symbols.json at ${symbolsPath}: ${e.message}`, 2);
  }
  if (!symbols) die(`failed to load symbols.json at ${symbolsPath}`, 2);
  const shapeIndex = loadIfExists(output, 'shape-index.json', { tag: 'check-canon' });

  emitStaleWarning(symbolsPath, 'symbols.json', 'build-symbol-graph.mjs');
  const scopeHint = symbols.meta?.scope ?? 'unspecified';
  const result = detectTypeOwnershipDrift({
    canonPath, symbols, canonLabelSet: TYPE_LABEL_SET, shapeIndex,
  });
  return { source: 'type-ownership', canonPath, scopeHint, result };
}

function dispatchHelperRegistry() {
  const canonPath = path.join(canonDir, 'helper-registry.md');
  const symbols = loadIfExists(output, 'symbols.json', { tag: 'check-canon' });
  const callGraph = loadIfExists(output, 'call-graph.json', { tag: 'check-canon' });
  if (!callGraph) {
    process.stderr.write(`[check-canon] call-graph.json not found in ${output}; cross-check diagnostics skipped.\n`);
  }
  const files = collectFiles(cli.root, {
    includeTests: cli.includeTests,
    exclude: cli.exclude,
  });
  const repoMode = detectRepoMode(cli.root);
  const aliasMap = buildAliasMap(cli.root, repoMode);
  const rawResolver = makeResolver(cli.root, aliasMap);
  function resolveSpecifier(fromFile, spec) {
    const r = rawResolver(fromFile, spec);
    return isResolvedFile(r) ? r : null;
  }
  const result = detectHelperRegistryDrift({
    canonPath,
    scanContext: {
      files, root: cli.root,
      extractFn: extractDefinitionsAndUses,
      resolveSpecifier, symbols, callGraph,
    },
    canonLabelSet: HELPER_LABEL_SET,
  });
  return { source: 'helper-registry', canonPath, scopeHint: 'fresh-ast', result };
}

function dispatchTopology() {
  const canonPath = path.join(canonDir, 'topology.md');
  const topologyPath = path.join(output, 'topology.json');
  if (!existsSync(topologyPath)) {
    die(`topology.json not found in --output directory: ${output}. Run 'measure-topology.mjs --output ${output}' first.`);
  }
  let topology;
  try {
    topology = readJsonFile(topologyPath, { tag: 'check-canon', strict: true });
  } catch (e) {
    die(`failed to load topology.json at ${topologyPath}: ${e.message}`, 2);
  }
  if (!topology) die(`failed to load topology.json at ${topologyPath}`, 2);
  const triage = loadIfExists(output, 'triage.json', { tag: 'check-canon' });
  emitStaleWarning(topologyPath, 'topology.json', 'measure-topology.mjs');
  const scopeHint = topology.meta?.scope ?? 'topology-json';
  const result = detectTopologyDrift({
    canonPath, topology, triage, canonLabelSet: TOPOLOGY_LABEL_SET,
  });
  return { source: 'topology', canonPath, scopeHint, result };
}

function dispatchNaming() {
  const canonPath = path.join(canonDir, 'naming.md');
  const files = collectFiles(cli.root, {
    includeTests: cli.includeTests,
    exclude: cli.exclude,
  });
  const repoMode = detectRepoMode(cli.root);
  const submoduleOf = buildSubmoduleResolver(cli.root, repoMode);
  const result = detectNamingDrift({
    canonPath,
    scanContext: {
      files, root: cli.root,
      extractFn: extractDefinitionsAndUses,
      submoduleOf,
      lowInfoNames: new Set(LOW_INFO_NAMES),
      lowInfoHelperNames: new Set(LOW_INFO_HELPER_NAMES),
    },
    canonLabelSet: NAMING_LABEL_SET,
  });
  return { source: 'naming', canonPath, scopeHint: 'fresh-ast', result };
}

function emitStaleWarning(artifactPath, artifactName, producerName) {
  try {
    const { statSync } = require('node:fs');
    const artMtime = statSync(artifactPath).mtimeMs;
    const srcFiles = collectFiles(cli.root, {
      includeTests: cli.includeTests,
      exclude: cli.exclude,
    });
    let staleCount = 0;
    const staleExamples = [];
    for (const f of srcFiles) {
      try {
        if (statSync(f).mtimeMs > artMtime) {
          staleCount += 1;
          if (staleExamples.length < 3) staleExamples.push(path.relative(cli.root, f));
        }
      } catch { /* skip */ }
    }
    if (staleCount > 0) {
      process.stderr.write(
        `[check-canon] warning: ${artifactName} mtime is older than ${staleCount} source file(s) ` +
        `(e.g. ${staleExamples.join(', ')}). ` +
        `Drift results may be stale; re-run '${producerName}' to refresh.\n`);
    }
  } catch { /* best-effort */ }
}
// Shim for `require` in ESM context — statSync is synchronously needed.
const require = (await import('node:module')).createRequire(import.meta.url);

// ─── Main dispatch ────────────────────────────────────────────

const dispatchers = {
  'type-ownership': dispatchTypeOwnership,
  'helper-registry': dispatchHelperRegistry,
  'topology': dispatchTopology,
  'naming': dispatchNaming,
};

const sourcesToRun = source === 'all' ? SINGLE_SOURCES : [source];

const perSource = {};
const allDrifts = [];
let scopeHint = 'unspecified';

for (const s of sourcesToRun) {
  const dispatched = dispatchers[s]();
  scopeHint = dispatched.scopeHint;
  const { result } = dispatched;
  const entry = {
    status: result.status,
    driftCount: result.drifts.length,
    diagnostics: result.diagnostics ?? [],
  };
  if (result.status === 'drift' || result.status === 'clean') {
    entry.reportPath = path.join(output, `canon-drift.${s}.md`);
  }
  perSource[s] = entry;
  for (const d of result.drifts) allDrifts.push(d);
  // Write per-source MD immediately (only when drift or clean).
  if (result.status === 'drift' || result.status === 'clean') {
    writeCanonDriftArtifacts({
      output,
      driftObject: buildCanonDriftJsonObject({
        meta: { tool: 'check-canon.mjs' },
        perSource: { [s]: entry },
        drifts: result.drifts,
      }),
      reportMarkdown: result.reportMarkdown,
      source: s,
    });
  }
}

// Build merged driftObject and write canon-drift.json once (the MD files
// were written above during iteration; this write just updates the JSON).
const driftObject = buildCanonDriftJsonObject({
  meta: {
    ...producerMetaBase({ tool: 'check-canon.mjs', root: cli.root }),
    canonDir,
    scope: source === 'all' ? 'multi-source' : scopeHint,
    strict: cli.raw.strict,
  },
  perSource,
  drifts: allDrifts,
});
const paths = writeCanonDriftArtifacts({
  output, driftObject,
  reportMarkdown: null,  // MD files already written per-source above
  source: sourcesToRun[0],
});
const jsonPath = paths.jsonPath;

// ─── Exit-code computation ────────────────────────────────────

function computeExit(perSourceEntries) {
  const entries = Object.values(perSourceEntries);
  const failed  = entries.filter((e) =>
    e.status === 'parse-error' || e.status === 'skipped-unrecognized-schema');
  const checked = entries.filter((e) =>
    e.status === 'clean' || e.status === 'drift');
  if (checked.length === 0) return 2;
  if (failed.length > 0) return 2;
  if (checked.some((e) => e.status === 'drift')) return 1;
  return 0;
}

let exitCode;
let statusLine;

if (source === 'all') {
  exitCode = computeExit(perSource);
  const parts = SINGLE_SOURCES.map((s) => {
    const e = perSource[s];
    if (e.status === 'drift') return `${s}: drift (${e.driftCount})`;
    if (e.status === 'clean') return `${s}: clean`;
    return `${s}: ${e.status}`;
  });
  statusLine = `[check-canon] all: ${parts.join(' / ')}`;
} else {
  const entry = perSource[source];
  switch (entry.status) {
    case 'clean':
      exitCode = 0;
      statusLine = `[check-canon] ${source}: clean`;
      break;
    case 'drift':
      exitCode = 1;
      statusLine = `[check-canon] ${source}: ${entry.driftCount} drifts`;
      break;
    case 'skipped-missing-canon': {
      exitCode = 2;
      const canonFileBySource = {
        'type-ownership': 'type-ownership.md',
        'helper-registry': 'helper-registry.md',
        'topology': 'topology.md',
        'naming': 'naming.md',
      };
      statusLine = `[check-canon] ${source}: skipped (canonical/${canonFileBySource[source]} absent)`;
      break;
    }
    case 'skipped-unrecognized-schema':
      exitCode = 2;
      statusLine = `[check-canon] ${source}: skipped (unrecognized canon schema)`;
      break;
    case 'parse-error':
      exitCode = 2;
      statusLine = `[check-canon] ${source}: parse-error`;
      break;
    default:
      exitCode = 2;
      statusLine = `[check-canon] ${source}: unknown status: ${entry.status}`;
  }
}

process.stdout.write(`${statusLine}\n`);
process.stdout.write(`  json:   ${jsonPath}\n`);
process.exit(exitCode);
