// Shared strict incremental cache store.
//
// Cache files are untrusted source-derived artifacts. A cache entry is a
// strict hit only when the current snapshot entry and producer context match.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { atomicWrite } from './atomic-write.mjs';
import { repoFingerprintForRoot } from './incremental-snapshot.mjs';

export const CACHE_STORE_SCHEMA_VERSION = 1;

function emptyCache(loadStatus = 'empty') {
  return {
    schemaVersion: CACHE_STORE_SCHEMA_VERSION,
    meta: { loadStatus },
    entries: {},
  };
}

export function defaultAuditCacheRoot({ root }) {
  return path.join(path.resolve(root), '.audit', '.cache');
}

export function openIncrementalCacheStore({ root, cacheRoot = null, repoFingerprint = null } = {}) {
  const resolvedRoot = path.resolve(root);
  const fingerprint = repoFingerprint ?? repoFingerprintForRoot(resolvedRoot);
  const baseCacheRoot = cacheRoot ? path.resolve(cacheRoot) : defaultAuditCacheRoot({ root: resolvedRoot });
  const repoCacheDir = path.join(baseCacheRoot, 'incremental', fingerprint.replace(/^sha256:/, ''));
  return {
    root: resolvedRoot,
    cacheRoot: baseCacheRoot,
    repoFingerprint: fingerprint,
    repoCacheDir,
  };
}

function producerCachePath(store, producerId) {
  return path.join(store.repoCacheDir, `${producerId}.cache.json`);
}

export function loadProducerCache(store, producerId) {
  const file = producerCachePath(store, producerId);
  if (!existsSync(file)) return emptyCache();

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (
      parsed?.schemaVersion !== CACHE_STORE_SCHEMA_VERSION ||
      !parsed.entries ||
      typeof parsed.entries !== 'object'
    ) {
      return emptyCache('ignored-incompatible');
    }
    return {
      schemaVersion: CACHE_STORE_SCHEMA_VERSION,
      meta: { loadStatus: 'ok' },
      entries: parsed.entries,
    };
  } catch {
    return emptyCache('ignored-malformed');
  }
}

export function saveProducerCache(store, producerId, cache) {
  mkdirSync(store.repoCacheDir, { recursive: true });
  const file = producerCachePath(store, producerId);
  const stableEntries = Object.fromEntries(
    Object.entries(cache.entries ?? {}).sort(([a], [b]) => a.localeCompare(b))
  );
  atomicWrite(file, JSON.stringify({
    schemaVersion: CACHE_STORE_SCHEMA_VERSION,
    entries: stableEntries,
  }, null, 2) + '\n');
}

export function clearIncrementalCache(store) {
  rmSync(store.repoCacheDir, { recursive: true, force: true });
}

export function strictCacheKeyForEntry(snapshotEntry) {
  return [
    snapshotEntry.relPath,
    snapshotEntry.language,
    snapshotEntry.isTestLike ? 'test' : 'prod',
    snapshotEntry.packageScope,
  ].join('|');
}

function sameProducerMeta(a = {}, b = {}) {
  return (
    a.producerId === b.producerId &&
    a.producerVersion === b.producerVersion &&
    a.factSchemaVersion === b.factSchemaVersion &&
    a.parserIdentity === b.parserIdentity &&
    a.scanFingerprint === b.scanFingerprint &&
    a.configFingerprint === b.configFingerprint
  );
}

export function putFact(cache, { snapshotEntry, producerMeta, payload }) {
  const key = strictCacheKeyForEntry(snapshotEntry);
  cache.entries[key] = {
    key,
    identity: {
      relPath: snapshotEntry.relPath,
      language: snapshotEntry.language,
      isTestLike: snapshotEntry.isTestLike === true,
      packageScope: snapshotEntry.packageScope,
      contextFingerprint: snapshotEntry.contextFingerprint,
      contentHash: snapshotEntry.contentHash,
    },
    producerMeta: { ...producerMeta },
    payload,
  };
}

export function getReusableFact(cache, { snapshotEntry, producerMeta }) {
  if (!snapshotEntry?.readable || !snapshotEntry.contentHash) {
    return { status: 'miss', reason: 'current-file-unreadable' };
  }

  const prior = cache.entries?.[strictCacheKeyForEntry(snapshotEntry)];
  if (!prior) return { status: 'miss', reason: 'missing-entry' };

  if (!sameProducerMeta(prior.producerMeta, producerMeta)) {
    return { status: 'miss', reason: 'producer-or-context-mismatch' };
  }

  const identity = prior.identity ?? {};
  if (identity.contextFingerprint !== snapshotEntry.contextFingerprint) {
    return { status: 'miss', reason: 'context-fingerprint-mismatch' };
  }
  if (identity.contentHash !== snapshotEntry.contentHash) {
    return { status: 'miss', reason: 'content-hash-mismatch' };
  }

  return { status: 'hit', payload: prior.payload };
}
