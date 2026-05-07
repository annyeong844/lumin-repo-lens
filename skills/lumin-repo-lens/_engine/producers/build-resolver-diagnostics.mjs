#!/usr/bin/env node
// build-resolver-diagnostics.mjs - Resolver capability matrix + per-run diagnostics.

import path from 'node:path';

import { atomicWrite } from '../lib/atomic-write.mjs';
import { loadIfExists } from '../lib/artifacts.mjs';
import { parseCliArgs } from '../lib/cli.mjs';
import {
  buildResolverCapabilitiesArtifact,
  buildResolverDiagnosticsArtifact,
} from '../lib/resolver-capabilities.mjs';

const cli = parseCliArgs({});
const ROOT = cli.root;
const OUTPUT = cli.output;

const symbolsData = loadIfExists(OUTPUT, 'symbols.json', { tag: 'build-resolver-diagnostics' });
if (!symbolsData) {
  console.error('[resolver-diagnostics] symbols.json is required. Run build-symbol-graph.mjs first.');
  process.exit(1);
}

const capabilities = buildResolverCapabilitiesArtifact({ root: ROOT });
const diagnostics = buildResolverDiagnosticsArtifact(symbolsData);

const capabilitiesPath = path.join(OUTPUT, 'resolver-capabilities.json');
const diagnosticsPath = path.join(OUTPUT, 'resolver-diagnostics.json');
atomicWrite(capabilitiesPath, JSON.stringify(capabilities, null, 2));
atomicWrite(diagnosticsPath, JSON.stringify(diagnostics, null, 2));

console.log('\n══════ resolver diagnostics ══════');
console.log(`  families        : ${capabilities.families.length}`);
console.log(`  unresolved      : ${diagnostics.summary.unresolvedImportCount}`);
console.log(`  blind zones     : ${diagnostics.summary.blindZoneCount}`);
console.log(`  candidate paths : ${diagnostics.summary.candidateTargetCount}`);
console.log(`  wrote           : ${capabilitiesPath}`);
console.log(`  wrote           : ${diagnosticsPath}`);
