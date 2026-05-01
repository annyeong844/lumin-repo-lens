#!/usr/bin/env node
// any-inventory.mjs — P2-0 producer for occurrence-level `type-escape` facts.
//
// Walks TS/JS files (default INCLUDES tests per `_lib/cli.mjs::parseCliArgs`
// codebase convention; pass `--production` or `--no-include-tests` to
// scope to production only) via `_lib/collect-files.mjs` and emits
// `<output>/any-inventory.json` per `canonical/fact-model.md §3.9`
// (post-P2-0 amendment).
//
//   node any-inventory.mjs --root <repo> --output <dir> [--include-tests] [--production]
//   node any-inventory.mjs --root <repo> --output <dir> --artifact-name any-inventory.pre.<id>.json
//
// Output shape per maintainer history notes §4.2. `meta.complete === true` only when
// every scanned file parsed successfully; a single parse error flips it
// to false and surfaces the errored file in `meta.filesWithParseErrors[]`.
//
// All producer spawning (e.g. from pre-write.mjs' P2-0 hook) must use
// `execFileSync` argv arrays per P1-3 shell-safety rule.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from '../lib/cli.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { JS_FAMILY_LANGS } from '../lib/lang.mjs';
import { extractTypeEscapes } from '../lib/extract-ts-escapes.mjs';
import { producerMetaBase } from '../lib/artifacts.mjs';
import { atomicWrite } from '../lib/atomic-write.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cli = parseCliArgs({
  'artifact-name': { type: 'string' },
});  // --root / --output / --include-tests inherited

const ROOT = cli.root;
const OUTPUT = cli.output;
const ARTIFACT_NAME = cli.raw?.['artifact-name'] ?? 'any-inventory.json';

function die(msg, code = 2) {
  process.stderr.write(`[any-inventory] ${msg}\n`);
  process.exit(code);
}

function validateArtifactName(name) {
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
    die(`invalid --artifact-name: ${name}`);
  }
  return name;
}

// Canonical escape-kind list per fact-model.md §3.9. Mirror here so the
// producer contract is self-describing — P2-1 delta reads
// `meta.supports.escapeKinds` straight from this list and diff-checks
// against canonical via tests/test-canonical-fact-model-drift.mjs.
const ESCAPE_KINDS = Object.freeze([
  'explicit-any', 'as-any', 'angle-any', 'as-unknown-as-T',
  'rest-any-args', 'index-sig-any', 'generic-default-any',
  'ts-ignore', 'ts-expect-error', 'no-explicit-any-disable',
  'jsdoc-any',
]);

function toRel(abs) {
  return path.relative(ROOT, abs).replace(/\\/g, '/');
}

const files = collectFiles(ROOT, {
  includeTests: cli.includeTests,
  exclude: cli.exclude,
  languages: JS_FAMILY_LANGS,
});

const typeEscapes = [];
const filesWithParseErrors = [];

for (const abs of files) {
  let src;
  try { src = readFileSync(abs, 'utf8'); }
  catch (e) {
    filesWithParseErrors.push({
      file: toRel(abs),
      message: `read failed: ${e.message}`,
      line: 0,
    });
    continue;
  }

  const relFile = toRel(abs);
  const r = extractTypeEscapes(src, relFile);
  if (r.parseError) {
    filesWithParseErrors.push({
      file: relFile,
      message: r.parseError.slice(0, 200),
      line: 0,
    });
    continue;
  }
  if (Array.isArray(r.typeEscapes)) {
    for (const e of r.typeEscapes) typeEscapes.push(e);
  }
}

// P0 fix (2026-04-21): scope string must reflect actual scan range.
// Hardcoded 'TS/JS production files' lied whenever --include-tests (the
// codebase CLI default) was effective, producing an artifact claiming
// production scope while the file walk had included tests. Scan-range
// parity downstream depended on this string, so the lie cascaded into
// post-write delta behavior.
const scanScope = cli.includeTests
  ? 'TS/JS including tests'
  : 'TS/JS production files';

const artifact = {
  meta: {
    ...producerMetaBase({ tool: 'any-inventory.mjs', root: ROOT }),
    complete: filesWithParseErrors.length === 0,
    scope: scanScope,
    includeTests: cli.includeTests === true,
    exclude: cli.exclude ?? [],
    fileCount: files.length,
    filesWithParseErrors,
    supports: {
      typeEscapes: true,
      escapeKinds: [...ESCAPE_KINDS],
    },
  },
  typeEscapes,
};

const artifactName = validateArtifactName(ARTIFACT_NAME);
const outPath = path.join(OUTPUT, artifactName);
atomicWrite(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`[any-inventory] ${files.length} files, ${typeEscapes.length} type-escape occurrences${filesWithParseErrors.length > 0 ? `, ${filesWithParseErrors.length} parse errors` : ''}`);
console.log(`[any-inventory] saved → ${outPath}`);
