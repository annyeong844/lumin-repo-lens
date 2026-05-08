#!/usr/bin/env node
// build-inline-pattern-index.mjs - repeated inline statement review cues.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { producerMetaBase } from '../lib/artifacts.mjs';
import { parseCliArgs } from '../lib/cli.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import {
  assembleInlinePatternArtifact,
  extractInlinePatternFilePayload,
  inlinePatternReadErrorPayload,
} from '../lib/inline-pattern-artifact.mjs';
import { JS_FAMILY_LANGS } from '../lib/lang.mjs';

const cli = parseCliArgs();
const ROOT = cli.root;
const OUTPUT = cli.output;

const files = collectFiles(ROOT, {
  includeTests: cli.includeTests,
  exclude: cli.exclude,
  languages: JS_FAMILY_LANGS,
});

const payloads = [];
for (const file of files) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch (e) {
    payloads.push(inlinePatternReadErrorPayload(
      path.relative(ROOT, file).replace(/\\/g, '/'),
      e.message
    ));
    continue;
  }

  const relFile = path.relative(ROOT, file).replace(/\\/g, '/');
  payloads.push(extractInlinePatternFilePayload({ src, relFile }));
}

const artifact = assembleInlinePatternArtifact({
  metaBase: producerMetaBase({ tool: 'build-inline-pattern-index.mjs', root: ROOT }),
  includeTests: cli.includeTests,
  exclude: cli.exclude,
  files: payloads.flatMap((payload) => payload.files ?? []),
});

const outPath = path.join(OUTPUT, 'inline-patterns.json');
writeFileSync(outPath, JSON.stringify(artifact, null, 2));

const errorCount = artifact.diagnostics.length;
console.log(
  `[inline-patterns] ${artifact.meta.fileCount} files, ` +
  `${artifact.meta.patternOccurrenceCount} occurrences, ${artifact.meta.groupCount} groups` +
  `${errorCount > 0 ? `, ${errorCount} diagnostics` : ''}`
);
console.log(`[inline-patterns] saved -> ${outPath}`);
