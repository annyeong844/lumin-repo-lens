#!/usr/bin/env node
// build-block-clone-index.mjs - repeated block/region review evidence.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { atomicWrite } from "../lib/atomic-write.mjs";
import { producerMetaBase } from "../lib/artifacts.mjs";
import {
  assembleBlockCloneArtifact,
  BLOCK_CLONE_NOISE_POLICY_ID,
  BLOCK_CLONE_NORMALIZATION_POLICY_ID,
  BLOCK_CLONE_POLICY_VERSION,
  BLOCK_CLONE_SCHEMA_VERSION,
  BLOCK_CLONE_THRESHOLD_POLICY_ID,
  DEFAULT_BLOCK_CLONE_THRESHOLDS,
  tokenizeBlockCloneSource,
} from "../lib/block-clone-artifact.mjs";
import { parseCliArgs } from "../lib/cli.mjs";
import {
  buildContextFingerprint,
  buildRepoSnapshot,
  hashJson,
  STRICT_IDENTITY_MODE,
} from "../lib/incremental-snapshot.mjs";
import {
  clearIncrementalCache,
  openIncrementalCacheStore,
} from "../lib/incremental-cache-store.mjs";
import { JS_FAMILY_LANGS } from "../lib/lang.mjs";
import { createProducerPhaseTimer } from "../lib/producer-phase-timing.mjs";

const cli = parseCliArgs({
  "no-incremental": { type: "boolean", default: false },
  "cache-root": { type: "string" },
  "clear-incremental-cache": { type: "boolean", default: false },
});
const ROOT = cli.root;
const OUTPUT = cli.output;

const PRODUCER_ID = "block-clones";
const PRODUCER_VERSION = 1;
const CACHE_SCHEMA_VERSION = 1;
const PARSER_IDENTITY = "block-clones:oxc-parser+normalizer+suffix-array-v1";
const incrementalEnabled = cli.raw?.["no-incremental"] !== true;
const cacheStore = openIncrementalCacheStore({
  root: ROOT,
  cacheRoot: cli.raw?.["cache-root"],
});
if (cli.raw?.["clear-incremental-cache"] === true) {
  clearIncrementalCache(cacheStore);
}
const blockCloneCacheDir = path.join(cacheStore.repoCacheDir, PRODUCER_ID);
const blockCloneCachePath = path.join(blockCloneCacheDir, "block-clones.cache.json");

const contextFingerprint = buildContextFingerprint({
  includeTests: cli.includeTests,
  exclude: cli.exclude ?? [],
  languages: JS_FAMILY_LANGS,
  producerContext: {
    producer: PRODUCER_ID,
    producerVersion: PRODUCER_VERSION,
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    parserIdentity: PARSER_IDENTITY,
    schemaVersion: BLOCK_CLONE_SCHEMA_VERSION,
    policyVersion: BLOCK_CLONE_POLICY_VERSION,
    normalizationPolicyId: BLOCK_CLONE_NORMALIZATION_POLICY_ID,
    thresholdPolicyId: BLOCK_CLONE_THRESHOLD_POLICY_ID,
    noisePolicyId: BLOCK_CLONE_NOISE_POLICY_ID,
    thresholds: DEFAULT_BLOCK_CLONE_THRESHOLDS,
  },
});

mkdirSync(OUTPUT, { recursive: true });
const phaseTimer = createProducerPhaseTimer({
  producer: "build-block-clone-index.mjs",
  output: OUTPUT,
});

function emptyBlockCloneCache(loadStatus = "empty") {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    meta: { loadStatus },
    entries: {},
  };
}

function loadBlockCloneCache() {
  if (!existsSync(blockCloneCachePath)) return emptyBlockCloneCache();
  try {
    const parsed = JSON.parse(readFileSync(blockCloneCachePath, "utf8"));
    if (
      parsed?.schemaVersion !== CACHE_SCHEMA_VERSION ||
      !parsed.entries ||
      typeof parsed.entries !== "object"
    ) {
      return emptyBlockCloneCache("ignored-incompatible");
    }
    return {
      schemaVersion: CACHE_SCHEMA_VERSION,
      meta: { loadStatus: "ok" },
      entries: parsed.entries,
    };
  } catch {
    return emptyBlockCloneCache("ignored-malformed");
  }
}

function saveBlockCloneCache(cache) {
  mkdirSync(blockCloneCacheDir, { recursive: true });
  const stableEntries = Object.fromEntries(
    Object.entries(cache.entries ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
  atomicWrite(
    blockCloneCachePath,
    JSON.stringify(
      {
        schemaVersion: CACHE_SCHEMA_VERSION,
        entries: stableEntries,
      },
      null,
      2,
    ) + "\n",
  );
}

function cacheKeyForSnapshot(snapshotEntries) {
  return hashJson({
    schemaVersion: CACHE_SCHEMA_VERSION,
    contextFingerprint,
    files: snapshotEntries.map((entry) => ({
      relPath: entry.relPath,
      language: entry.language,
      isTestLike: entry.isTestLike === true,
      packageScope: entry.packageScope,
      readable: entry.readable === true,
      contentHash: entry.contentHash ?? null,
      readError: entry.readError?.kind ?? null,
    })),
  });
}

function incrementalMeta({ reusedResult, reason, cacheKey }) {
  if (!incrementalEnabled) {
    return {
      enabled: false,
      identityMode: null,
      reason: "disabled-by-flag",
    };
  }
  return {
    enabled: true,
    identityMode: STRICT_IDENTITY_MODE,
    cacheVersion: 1,
    cacheRoot: cacheStore.cacheRoot,
    repoFingerprint: cacheStore.repoFingerprint,
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    cacheKey,
    reusedResult,
    reason,
  };
}

function restampArtifact(artifact, incremental) {
  return {
    ...artifact,
    generated: new Date().toISOString(),
    root: ROOT,
    scanRange: {
      includeTests: cli.includeTests,
      exclude: cli.exclude ?? [],
    },
    meta: {
      ...(artifact.meta ?? {}),
      generated: new Date().toISOString(),
      root: ROOT,
      incremental,
    },
  };
}

function readErrorTokenPayload(entry) {
  return {
    relFile: entry.relPath,
    tokens: [],
    skipped: null,
    diagnostics: [
      {
        file: entry.relPath,
        kind: "read-error",
        message: entry.readError?.kind ?? "read-failed",
      },
    ],
  };
}

const snapshot = phaseTimer.runPhase("collect-files", () =>
  buildRepoSnapshot({
    root: ROOT,
    includeTests: cli.includeTests,
    exclude: cli.exclude ?? [],
    languages: JS_FAMILY_LANGS,
    contextFingerprint,
  }),
);
const snapshotEntries = Object.values(snapshot.files);
phaseTimer.setCounter("filesCollected", snapshotEntries.length);

const cacheKey = incrementalEnabled ? cacheKeyForSnapshot(snapshotEntries) : null;
const priorCache = incrementalEnabled
  ? loadBlockCloneCache()
  : emptyBlockCloneCache("disabled");
if (incrementalEnabled) {
  const cached = priorCache.entries?.[cacheKey]?.artifact;
  if (cached) {
    const artifact = restampArtifact(
      cached,
      incrementalMeta({
        reusedResult: true,
        reason: "cache-hit",
        cacheKey,
      }),
    );
    phaseTimer.setCounter("cacheReusedResult", 1);
    phaseTimer.setCounter("tokenizedFiles", 0);
    phaseTimer.setCounter("tokenCount", 0);
    phaseTimer.setCounter("reviewGroupCount", artifact.summary.reviewGroupCount);
    phaseTimer.setCounter("mutedGroupCount", artifact.summary.mutedGroupCount);
    phaseTimer.setCounter("artifactTokenCount", artifact.summary.tokenCount);
    const outPath = path.join(OUTPUT, "block-clones.json");
    phaseTimer.runPhase("write-artifact", () => {
      writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n");
    });
    phaseTimer.write();
    console.log(
      `[block-clones] reused cached result, ` +
        `${artifact.summary.reviewGroupCount} review groups, ` +
        `${artifact.summary.mutedGroupCount} muted groups, status=${artifact.status}`,
    );
    console.log(`[block-clones] saved -> ${outPath}`);
    process.exit(0);
  }
}

const tokenized = phaseTimer.runPhase("tokenize-files", () =>
  snapshotEntries.map((entry) => {
    if (!entry.readable) return readErrorTokenPayload(entry);
    let src = "";
    try {
      src = readFileSync(entry.absPath, "utf8");
    } catch (error) {
      return {
        relFile: entry.relPath,
        tokens: [],
        skipped: null,
        diagnostics: [
          {
            file: entry.relPath,
            kind: "read-error",
            message: error?.message ?? String(error),
          },
        ],
      };
    }
    return tokenizeBlockCloneSource({ root: ROOT, filePath: entry.absPath, src });
  }),
);
phaseTimer.setCounter("tokenizedFiles", tokenized.length);
phaseTimer.setCounter(
  "tokenCount",
  tokenized.reduce((sum, file) => sum + (file.tokens?.length ?? 0), 0),
);

const artifact = restampArtifact(
  phaseTimer.runPhase("assemble-artifact", () =>
    assembleBlockCloneArtifact({
      root: ROOT,
      files: tokenized,
      includeTests: cli.includeTests,
      exclude: cli.exclude ?? [],
      generated: producerMetaBase({
        tool: "build-block-clone-index.mjs",
        root: ROOT,
      }).generated,
    }),
  ),
  incrementalMeta({
    reusedResult: false,
    reason: incrementalEnabled ? "cache-miss" : "disabled-by-flag",
    cacheKey,
  }),
);

if (incrementalEnabled) {
  saveBlockCloneCache({
    schemaVersion: CACHE_SCHEMA_VERSION,
    entries: {
      ...(priorCache.entries ?? {}),
      [cacheKey]: { artifact },
    },
  });
}

phaseTimer.setCounter("reviewGroupCount", artifact.summary.reviewGroupCount);
phaseTimer.setCounter("mutedGroupCount", artifact.summary.mutedGroupCount);
phaseTimer.setCounter("artifactTokenCount", artifact.summary.tokenCount);

const outPath = path.join(OUTPUT, "block-clones.json");
phaseTimer.runPhase("write-artifact", () => {
  writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n");
});
phaseTimer.write();

console.log(
  `[block-clones] ${artifact.summary.fileCount} files, ` +
    `${artifact.summary.reviewGroupCount} review groups, ` +
    `${artifact.summary.mutedGroupCount} muted groups, status=${artifact.status}`,
);
console.log(`[block-clones] saved -> ${outPath}`);
