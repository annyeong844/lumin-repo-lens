#!/usr/bin/env node
// build-module-reachability.mjs - PCEF P2 entry-rooted file reachability.

import path from 'node:path';

import { atomicWrite } from '../lib/atomic-write.mjs';
import { loadIfExists } from '../lib/artifacts.mjs';
import { parseCliArgs } from '../lib/cli.mjs';
import { buildModuleReachabilityArtifact } from '../lib/module-reachability.mjs';

function readPositiveInteger(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

const cli = parseCliArgs({
  'max-files-visited': { type: 'string' },
  'max-edges-visited': { type: 'string' },
});
const ROOT = cli.root;
const OUTPUT = cli.output;

const symbolsData = loadIfExists(OUTPUT, 'symbols.json', { tag: 'build-module-reachability' });
if (!symbolsData) {
  console.error('[module-reachability] symbols.json is required. Run build-symbol-graph.mjs first.');
  process.exit(1);
}
const entrySurface = loadIfExists(OUTPUT, 'entry-surface.json', { tag: 'build-module-reachability' });
if (!entrySurface) {
  console.error('[module-reachability] entry-surface.json is required. Run build-entry-surface.mjs first.');
  process.exit(1);
}

const artifact = buildModuleReachabilityArtifact({
  root: ROOT,
  symbolsData,
  entrySurface,
  maxFilesVisited: readPositiveInteger(cli.raw['max-files-visited'], 200000, '--max-files-visited'),
  maxEdgesVisited: readPositiveInteger(cli.raw['max-edges-visited'], 400000, '--max-edges-visited'),
});

const outPath = path.join(OUTPUT, 'module-reachability.json');
atomicWrite(outPath, JSON.stringify(artifact, null, 2));

console.log('\n══════ module reachability ══════');
console.log(`  runtime reachable : ${artifact.summary.runtimeReachable}`);
console.log(`  type reachable    : ${artifact.summary.typeReachable}`);
console.log(`  unreachable       : ${artifact.summary.unreachable}`);
console.log(`  bounded out       : ${artifact.summary.boundedOut}`);
console.log(`  wrote             : ${outPath}`);
