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
import { parseCliArgs } from '../lib/cli.mjs';
import { JS_FAMILY_LANGS } from '../lib/lang.mjs';
import { extractTypeEscapes } from '../lib/extract-ts-escapes.mjs';
import { producerMetaBase } from '../lib/artifacts.mjs';
import { atomicWrite } from '../lib/atomic-write.mjs';
import {
  buildContextFingerprint,
  buildRepoSnapshot,
  STRICT_IDENTITY_MODE,
} from '../lib/incremental-snapshot.mjs';
import {
  clearIncrementalCache,
  getReusableFact,
  loadProducerCache,
  openIncrementalCacheStore,
  putFact,
  saveProducerCache,
  strictCacheKeyForEntry,
} from '../lib/incremental-cache-store.mjs';

const cli = parseCliArgs({
  'artifact-name': { type: 'string' },
  'no-incremental': { type: 'boolean', default: false },
  'cache-root': { type: 'string' },
  'clear-incremental-cache': { type: 'boolean', default: false },
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

const PRODUCER_ID = 'any-inventory';
const PRODUCER_VERSION = 1;
const FACT_SCHEMA_VERSION = 1;
const PARSER_IDENTITY = 'oxc-parser:extract-type-escapes-v1';

function sortTypeEscapes(facts) {
  return [...facts].sort((a, b) =>
    String(a.file).localeCompare(String(b.file)) ||
    Number(a.line ?? 0) - Number(b.line ?? 0) ||
    String(a.escapeKind).localeCompare(String(b.escapeKind)) ||
    String(a.occurrenceKey ?? '').localeCompare(String(b.occurrenceKey ?? '')));
}

const contextFingerprint = buildContextFingerprint({
  includeTests: cli.includeTests,
  exclude: cli.exclude ?? [],
  languages: JS_FAMILY_LANGS,
  producerContext: {
    producer: PRODUCER_ID,
    producerVersion: PRODUCER_VERSION,
    factSchemaVersion: FACT_SCHEMA_VERSION,
    parserIdentity: PARSER_IDENTITY,
  },
});

const snapshot = buildRepoSnapshot({
  root: ROOT,
  includeTests: cli.includeTests,
  exclude: cli.exclude,
  languages: JS_FAMILY_LANGS,
  contextFingerprint,
});

const incrementalEnabled = cli.raw?.['no-incremental'] !== true;
const cacheStore = openIncrementalCacheStore({
  root: ROOT,
  cacheRoot: cli.raw?.['cache-root'],
});
if (cli.raw?.['clear-incremental-cache'] === true) {
  clearIncrementalCache(cacheStore);
}

const producerCacheMeta = {
  producerId: PRODUCER_ID,
  producerVersion: PRODUCER_VERSION,
  factSchemaVersion: FACT_SCHEMA_VERSION,
  parserIdentity: PARSER_IDENTITY,
  scanFingerprint: contextFingerprint,
  configFingerprint: contextFingerprint,
};

const priorCache = incrementalEnabled
  ? loadProducerCache(cacheStore, PRODUCER_ID)
  : { entries: {}, meta: { loadStatus: 'disabled' } };
const nextCache = { entries: {}, meta: { loadStatus: 'new' } };

const typeEscapes = [];
const filesWithParseErrors = [];
const currentStrictKeys = new Set();
let changedFiles = 0;
let reusedFiles = 0;
let invalidatedFiles = 0;

for (const entry of Object.values(snapshot.files)) {
  currentStrictKeys.add(strictCacheKeyForEntry(entry));

  if (!entry.readable) {
    changedFiles++;
    filesWithParseErrors.push({
      file: entry.relPath,
      message: `read failed: ${entry.readError?.kind ?? 'unknown'}`,
      line: 0,
    });
    continue;
  }

  const reuse = incrementalEnabled
    ? getReusableFact(priorCache, { snapshotEntry: entry, producerMeta: producerCacheMeta })
    : { status: 'miss', reason: 'disabled-by-flag' };

  if (reuse.status === 'hit') {
    reusedFiles++;
    for (const fact of reuse.payload.typeEscapes ?? []) typeEscapes.push(fact);
    putFact(nextCache, {
      snapshotEntry: entry,
      producerMeta: producerCacheMeta,
      payload: reuse.payload,
    });
    continue;
  }

  if (reuse.reason !== 'missing-entry' && reuse.reason !== 'disabled-by-flag') {
    invalidatedFiles++;
  }
  changedFiles++;

  let src;
  try {
    src = readFileSync(entry.absPath, 'utf8');
  } catch (e) {
    filesWithParseErrors.push({
      file: entry.relPath,
      message: `read failed: ${e.message}`,
      line: 0,
    });
    continue;
  }

  const result = extractTypeEscapes(src, entry.relPath);
  if (result.parseError) {
    filesWithParseErrors.push({
      file: entry.relPath,
      message: result.parseError.slice(0, 200),
      line: 0,
    });
    continue;
  }

  const payload = {
    typeEscapes: Array.isArray(result.typeEscapes) ? result.typeEscapes : [],
  };
  for (const fact of payload.typeEscapes) typeEscapes.push(fact);
  if (incrementalEnabled) {
    putFact(nextCache, {
      snapshotEntry: entry,
      producerMeta: producerCacheMeta,
      payload,
    });
  }
}

const droppedFiles = Object.keys(priorCache.entries ?? {})
  .filter((key) => !currentStrictKeys.has(key)).length;
if (incrementalEnabled) {
  saveProducerCache(cacheStore, PRODUCER_ID, nextCache);
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
    fileCount: Object.keys(snapshot.files).length,
    filesWithParseErrors,
    incremental: {
      enabled: incrementalEnabled,
      identityMode: incrementalEnabled ? STRICT_IDENTITY_MODE : null,
      cacheVersion: 1,
      cacheRoot: incrementalEnabled ? cacheStore.cacheRoot : null,
      changedFiles,
      reusedFiles,
      droppedFiles,
      invalidatedFiles,
      reason: incrementalEnabled ? null : 'disabled-by-flag',
    },
    supports: {
      typeEscapes: true,
      escapeKinds: [...ESCAPE_KINDS],
    },
  },
  typeEscapes: sortTypeEscapes(typeEscapes),
};

const artifactName = validateArtifactName(ARTIFACT_NAME);
const outPath = path.join(OUTPUT, artifactName);
atomicWrite(outPath, JSON.stringify(artifact, null, 2) + '\n');

console.log(`[any-inventory] ${Object.keys(snapshot.files).length} files, ${typeEscapes.length} type-escape occurrences${filesWithParseErrors.length > 0 ? `, ${filesWithParseErrors.length} parse errors` : ''}`);
console.log(`[any-inventory] saved → ${outPath}`);
