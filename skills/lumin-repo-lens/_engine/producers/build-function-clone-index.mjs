#!/usr/bin/env node
// build-function-clone-index.mjs - deterministic function/helper clone cues.
//
// Emits <output>/function-clones.json. The artifact is intentionally a
// candidate index, not a semantic verdict: the model must inspect the cited
// functions before recommending a merge.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseCliArgs } from '../lib/cli.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { JS_FAMILY_LANGS } from '../lib/lang.mjs';
import { producerMetaBase } from '../lib/artifacts.mjs';
import { buildFunctionCloneArtifact } from '../lib/function-clone-artifact.mjs';

const cli = parseCliArgs({});
const ROOT = cli.root;
const OUTPUT = cli.output;

const files = collectFiles(ROOT, {
  includeTests: cli.includeTests,
  exclude: cli.exclude,
  languages: JS_FAMILY_LANGS,
});

const metaBase = producerMetaBase({ tool: 'build-function-clone-index.mjs', root: ROOT });
const scope = cli.includeTests
  ? 'TS/JS including tests, exported top-level functions only'
  : 'TS/JS production files, exported top-level functions only';

const artifact = buildFunctionCloneArtifact({
  root: ROOT,
  files,
  readFile: readFileSync,
  metaBase,
  includeTests: cli.includeTests,
  exclude: cli.exclude,
  scope,
  observedAt: metaBase.generated,
});

const outPath = path.join(OUTPUT, 'function-clones.json');
writeFileSync(outPath, JSON.stringify(artifact, null, 2));

const errors =
  artifact.meta.filesWithReadErrors.length + artifact.meta.filesWithParseErrors.length;
console.log(
  `[function-clones] ${artifact.meta.fileCount} files, ${artifact.meta.factCount} function facts` +
  `, ${artifact.meta.exactBodyGroupCount} exact groups` +
  `, ${artifact.meta.structureGroupCount} structure groups` +
  `, ${artifact.meta.nearFunctionCandidateCount} near candidates` +
  `${errors > 0 ? `, ${errors} file errors` : ''}`
);
console.log(`[function-clones] saved -> ${outPath}`);
