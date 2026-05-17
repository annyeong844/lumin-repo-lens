#!/usr/bin/env node
// build-unused-deps.mjs - review-only declared dependency hygiene evidence.

import path from 'node:path';

import { atomicWrite } from '../lib/atomic-write.mjs';
import { readJsonFile } from '../lib/artifacts.mjs';
import { parseCliArgs } from '../lib/cli.mjs';
import { relPath } from '../lib/paths.mjs';
import { detectRepoMode } from '../lib/repo-mode.mjs';
import { buildUnusedDepsArtifact } from '../lib/unused-deps-artifact.mjs';

const cli = parseCliArgs({});
const ROOT = cli.root;
const OUTPUT = cli.output;

function packageRecordsFromRepoMode(root, repoMode) {
  const records = [{
    root,
    relRoot: '.',
    packageJson: repoMode.rootPkgJson ?? readJsonFile(path.join(root, 'package.json')) ?? {},
  }];
  for (const workspaceRoot of repoMode.workspaceDirs ?? []) {
    records.push({
      root: workspaceRoot,
      relRoot: relPath(root, workspaceRoot),
      packageJson: readJsonFile(path.join(workspaceRoot, 'package.json')) ?? {},
    });
  }
  return records;
}

const repoMode = detectRepoMode(ROOT);
const symbols = readJsonFile(path.join(OUTPUT, 'symbols.json'), {
  tag: 'build-unused-deps',
});

const artifact = buildUnusedDepsArtifact({
  root: ROOT,
  includeTests: cli.includeTests,
  exclude: cli.exclude,
  packageRecords: packageRecordsFromRepoMode(ROOT, repoMode),
  symbols,
});

const outPath = path.join(OUTPUT, 'unused-deps.json');
atomicWrite(outPath, JSON.stringify(artifact, null, 2));

console.log('\n══════ unused dependency evidence ══════');
console.log(`  status              : ${artifact.status}`);
console.log(`  packages            : ${artifact.summary.packageCount}`);
console.log(`  declared deps       : ${artifact.summary.declaredDependencyCount}`);
console.log(`  review-unused       : ${artifact.summary.reviewUnusedCount}`);
console.log(`  muted               : ${artifact.summary.mutedCount}`);
console.log(`  wrote               : ${outPath}`);
