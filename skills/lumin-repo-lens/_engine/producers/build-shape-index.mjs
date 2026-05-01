#!/usr/bin/env node
// build-shape-index.mjs - P4-2 producer for shape-hash facts.
//
// Walks TS/JS files and emits <output>/shape-index.json. The producer is
// conservative: unsupported shapes are diagnostics, not fabricated facts.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseCliArgs } from '../lib/cli.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { JS_FAMILY_LANGS } from '../lib/lang.mjs';
import { producerMetaBase } from '../lib/artifacts.mjs';
import { buildShapeIndexArtifact } from '../lib/shape-index-artifact.mjs';

const cli = parseCliArgs({});
const ROOT = cli.root;
const OUTPUT = cli.output;

const files = collectFiles(ROOT, {
  includeTests: cli.includeTests,
  exclude: cli.exclude,
  languages: JS_FAMILY_LANGS,
});

const metaBase = producerMetaBase({ tool: 'build-shape-index.mjs', root: ROOT });
const scope = cli.includeTests
  ? 'TS/JS including tests, exported types only'
  : 'TS/JS production files, exported types only';

const artifact = buildShapeIndexArtifact({
  root: ROOT,
  files,
  readFile: readFileSync,
  metaBase,
  includeTests: cli.includeTests,
  exclude: cli.exclude,
  scope,
  observedAt: metaBase.generated,
});

const outPath = path.join(OUTPUT, 'shape-index.json');
writeFileSync(outPath, JSON.stringify(artifact, null, 2));

const errors =
  artifact.meta.filesWithReadErrors.length + artifact.meta.filesWithParseErrors.length;
console.log(
  `[shape-index] ${artifact.meta.fileCount} files, ${artifact.meta.factCount} shape-hash facts` +
  `${artifact.meta.diagnosticCount > 0 ? `, ${artifact.meta.diagnosticCount} diagnostics` : ''}` +
  `${errors > 0 ? `, ${errors} file errors` : ''}`
);
console.log(`[shape-index] saved -> ${outPath}`);
