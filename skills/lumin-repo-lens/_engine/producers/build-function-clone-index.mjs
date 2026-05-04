#!/usr/bin/env node
// build-function-clone-index.mjs - deterministic function/helper clone cues.
//
// Emits <output>/function-clones.json. The artifact is intentionally a
// candidate index, not a semantic verdict: the model must inspect the cited
// functions before recommending a merge.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseCliArgs } from '../lib/cli.mjs';
import { JS_FAMILY_LANGS } from '../lib/lang.mjs';
import { producerMetaBase } from '../lib/artifacts.mjs';
import {
  assembleFunctionCloneArtifact,
  extractFunctionCloneFilePayload,
  functionCloneReadErrorPayload,
} from '../lib/function-clone-artifact.mjs';
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
} from '../lib/incremental-cache-store.mjs';

const cli = parseCliArgs({
  'no-incremental': { type: 'boolean', default: false },
  'cache-root': { type: 'string' },
  'clear-incremental-cache': { type: 'boolean', default: false },
});
const ROOT = cli.root;
const OUTPUT = cli.output;

const PRODUCER_ID = 'function-clones';
const PRODUCER_VERSION = 1;
const FACT_SCHEMA_VERSION = 1;
const PARSER_IDENTITY = 'function-clones:oxc-parser+normalizer+scoring-v1';

const contextFingerprint = buildContextFingerprint({
  includeTests: cli.includeTests,
  languages: JS_FAMILY_LANGS,
  exclude: cli.exclude ?? [],
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
const snapshotEntries = Object.values(snapshot.files);

const metaBase = producerMetaBase({ tool: 'build-function-clone-index.mjs', root: ROOT });
const scope = cli.includeTests
  ? 'TS/JS including tests, exported top-level functions only'
  : 'TS/JS production files, exported top-level functions only';

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
const currentRelPaths = new Set();

const aggregate = {
  facts: [],
  diagnostics: [],
  filesWithParseErrors: [],
  filesWithReadErrors: [],
};
let changedFiles = 0;
let reusedFiles = 0;
let invalidatedFiles = 0;

function appendPayload(payload) {
  aggregate.facts.push(...(payload.facts ?? []));
  aggregate.diagnostics.push(...(payload.diagnostics ?? []));
  aggregate.filesWithParseErrors.push(...(payload.filesWithParseErrors ?? []));
  aggregate.filesWithReadErrors.push(...(payload.filesWithReadErrors ?? []));
}

for (const entry of snapshotEntries) {
  currentRelPaths.add(entry.relPath);

  if (!entry.readable) {
    changedFiles++;
    appendPayload(functionCloneReadErrorPayload(
      entry.relPath,
      entry.readError?.message ?? entry.readError?.kind ?? 'unknown'
    ));
    continue;
  }

  const reuse = incrementalEnabled
    ? getReusableFact(priorCache, { snapshotEntry: entry, producerMeta: producerCacheMeta })
    : { status: 'miss', reason: 'disabled-by-flag' };

  if (reuse.status === 'hit') {
    reusedFiles++;
    appendPayload(reuse.payload);
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
    appendPayload(functionCloneReadErrorPayload(entry.relPath, e.message));
    continue;
  }

  const payload = extractFunctionCloneFilePayload({
    src,
    relFile: entry.relPath,
    scope,
  });
  appendPayload(payload);
  if (incrementalEnabled) {
    putFact(nextCache, {
      snapshotEntry: entry,
      producerMeta: producerCacheMeta,
      payload,
    });
  }
}

const droppedFiles = Object.keys(priorCache.entries ?? {})
  .map((key) => priorCache.entries[key]?.identity?.relPath)
  .filter((relPath) => relPath && !currentRelPaths.has(relPath)).length;
if (incrementalEnabled) {
  saveProducerCache(cacheStore, PRODUCER_ID, nextCache);
}

const artifact = assembleFunctionCloneArtifact({
  metaBase,
  includeTests: cli.includeTests,
  exclude: cli.exclude,
  scope,
  observedAt: metaBase.generated,
  fileCount: snapshotEntries.length,
  ...aggregate,
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
if (incrementalEnabled) {
  console.log(
    `[function-clones] incremental: ${changedFiles} changed, ${reusedFiles} reused, ` +
    `${droppedFiles} dropped, ${invalidatedFiles} invalidated`
  );
}
console.log(`[function-clones] saved -> ${outPath}`);
