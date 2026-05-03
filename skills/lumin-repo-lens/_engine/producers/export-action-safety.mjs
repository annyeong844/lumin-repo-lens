#!/usr/bin/env node
// Select proof-carrying safe edit actions for dead-export findings.
//
// Input: dead-classify.json
// Output: export-action-safety.json

import path from 'node:path';

import { loadIfExists } from '../lib/artifacts.mjs';
import { parseCliArgs } from '../lib/cli.mjs';
import { atomicWrite } from '../lib/atomic-write.mjs';
import { buildExportActionSafetyArtifact } from '../lib/export-action-safety.mjs';

const { root, output } = parseCliArgs();
const ROOT = path.resolve(root);
const OUT = path.resolve(output);

const deadClassify = loadIfExists(OUT, 'dead-classify.json', { tag: 'export-action-safety' });
if (!deadClassify) {
  console.error('[export-action-safety] dead-classify.json is required. Run classify-dead-exports.mjs first.');
  process.exit(1);
}

const artifact = buildExportActionSafetyArtifact({ root: ROOT, deadClassify });
const outPath = path.join(OUT, 'export-action-safety.json');
atomicWrite(outPath, JSON.stringify(artifact, null, 2));

console.log('\n══════ export action safety ══════');
console.log(`  findings      : ${artifact.meta.total}`);
console.log(`  warnings      : ${artifact.meta.warnings.length}`);
console.log(`  wrote         : ${outPath}`);
