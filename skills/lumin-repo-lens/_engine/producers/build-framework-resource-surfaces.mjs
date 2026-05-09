#!/usr/bin/env node
// build-framework-resource-surfaces.mjs - classify existing non-source surfaces.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { atomicWrite } from '../lib/atomic-write.mjs';
import { readJsonFile } from '../lib/artifacts.mjs';
import { parseCliArgs } from '../lib/cli.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import {
  classifyFrameworkResourceSurfaces,
} from '../lib/framework-resource-surfaces.mjs';
import { relPath } from '../lib/paths.mjs';
import { detectRepoMode } from '../lib/repo-mode.mjs';

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

function collectHandlebarsResources(root) {
  const out = [];
  const prune = new Set(['node_modules', '.git', 'coverage']);
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (prune.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (entry.isFile() && /\.hbs$/i.test(entry.name)) {
        out.push(relPath(root, full));
      }
    }
  }
  walk(root);
  return out;
}

function readCandidateContent(root, relFile) {
  if (!/\.[cm]?jsx?$/.test(relFile)) return '';
  const abs = path.join(root, relFile);
  if (!existsSync(abs)) return '';
  try {
    const raw = readFileSync(abs, 'utf8');
    return raw.slice(0, 64 * 1024);
  } catch {
    return '';
  }
}

const repoMode = detectRepoMode(ROOT);
const sourceFiles = collectFiles(ROOT, {
  includeTests: cli.includeTests,
  exclude: cli.exclude,
}).map((file) => relPath(ROOT, file));
const files = [...new Set([
  ...sourceFiles,
  ...collectHandlebarsResources(ROOT),
])].sort();

const contentsByFile = Object.fromEntries(
  files
    .map((file) => [file, readCandidateContent(ROOT, file)])
    .filter(([, content]) => content)
);

const artifact = classifyFrameworkResourceSurfaces({
  root: ROOT,
  files,
  packageRecords: packageRecordsFromRepoMode(ROOT, repoMode),
  contentsByFile,
});

const outPath = path.join(OUTPUT, 'framework-resource-surfaces.json');
atomicWrite(outPath, JSON.stringify(artifact, null, 2));

console.log('\n══════ framework/resource surfaces ══════');
console.log(`  files with surfaces : ${artifact.summary.totalFilesWithSurfaces}`);
console.log(`  surface lanes       : ${artifact.summary.totalSurfaceLanes}`);
console.log(`  wrote               : ${outPath}`);
