// _lib/incremental.mjs — Legacy producer-local cache helper.
//
// New strict shared incremental work must use `_lib/incremental-snapshot.mjs`
// and `_lib/incremental-cache-store.mjs`. This helper intentionally preserves
// historical stat-first-cut behavior for existing producer-local caches until
// each producer is migrated through a compatibility adapter.
//
// Usage pattern (per script):
//
//   import { loadCache, saveCache, pickChangedFiles } from './_lib/incremental.mjs';
//
//   const cache = loadCache(outputDir, 'topology');
//   const { changed, unchanged, dropped, nextCache } = pickChangedFiles(files, cache);
//
//   for (const f of changed) {
//     const payload = reprocess(f);
//     nextCache.entries[f] = { ...nextCache.entries[f], ...payload };
//   }
//   // unchanged entries already carry their prior payload in nextCache.
//
//   saveCache(outputDir, 'topology', nextCache);
//
// Cache lives alongside the artifact as `<name>.cache.json`. Safe to delete —
// next run will rebuild it. Hash is content-based (sha256, truncated to 16 hex
// chars), so branch switches / stashes / out-of-band edits are all detected.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

// Cache version history:
//   v1 — initial content-hash layout.
//   v2 (v0.6.6) — `uses` schema extended for dynamic imports (FP-18);
//                 pre-v0.6.6 entries lacked dynamic edges.
//   v3 (2026-04-20, E-6) — entries now carry `{hash, mtimeMs, size}`
//                 for stat-first-cut: skip the content hash when
//                 mtime + size match a prior entry. v2 entries lack
//                 mtime/size, so a v3 load forces re-hashing on first
//                 use and converges to v3 shape on save.
const CACHE_VERSION = 3;

function hashFile(abs) {
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function statFile(abs) {
  try {
    const st = statSync(abs);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

export function loadCache(outputDir, name) {
  const p = path.join(outputDir, `${name}.cache.json`);
  if (!existsSync(p)) return { version: CACHE_VERSION, entries: {} };
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    if (data.version !== CACHE_VERSION) return { version: CACHE_VERSION, entries: {} };
    return data;
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

export function saveCache(outputDir, name, data) {
  const p = path.join(outputDir, `${name}.cache.json`);
  writeFileSync(p, JSON.stringify(data, null, 2));
}

// Partition the provided file list into (changed, unchanged, dropped)
// relative to the cache.
//
// Stat-first-cut (E-6): cheap stat() decides whether to content-hash at
// all. When `prior.mtimeMs` AND `prior.size` match the current file's
// stat, the content is assumed unchanged and the hash is NOT recomputed —
// prior entry is carried into `nextCache` verbatim. This is the common
// case (most files don't change between audit runs) and avoids re-reading
// file bytes just to confirm they're identical.
//
// Trade-off: a file whose mtime+size are identical but content differs
// would be a false cache hit. That requires (a) overwriting with a
// same-size, byte-different payload AND (b) matching the exact mtimeMs
// (sub-ms). Not observed in practice; document and accept.
//
// When stat differs (mtime OR size), fall back to full content hash.
// If the recomputed hash matches prior.hash, the file classifies as
// unchanged (e.g., `touch` that bumped mtime without changing bytes);
// otherwise changed.
export function pickChangedFiles(files, cache) {
  const changed = [];
  const unchanged = [];
  const nextCache = { version: CACHE_VERSION, entries: {} };

  for (const f of files) {
    const st = statFile(f);
    if (!st) continue; // unreadable — leave out

    const prior = cache.entries[f];

    // Fast path: stat-first-cut. mtime+size match → trust prior hash.
    if (prior && prior.mtimeMs === st.mtimeMs && prior.size === st.size) {
      unchanged.push(f);
      nextCache.entries[f] = prior;
      continue;
    }

    // Slow path: content hash.
    const h = hashFile(f);
    if (!h) continue;
    if (prior && prior.hash === h) {
      unchanged.push(f);
    } else {
      changed.push(f);
    }
    nextCache.entries[f] = { hash: h, mtimeMs: st.mtimeMs, size: st.size };
  }

  const currentSet = new Set(files);
  const dropped = Object.keys(cache.entries).filter((f) => !currentSet.has(f));

  return { changed, unchanged, dropped, nextCache };
}

// Small convenience for scripts that want to print a one-line cache banner.
export function cacheBanner(name, changed, unchanged, dropped) {
  const total = changed.length + unchanged.length;
  const pct = total === 0 ? 0 : Math.round((unchanged.length / total) * 100);
  return `[${name}] incremental: ${changed.length} changed, ${unchanged.length} cached (${pct}%), ${dropped.length} dropped`;
}
