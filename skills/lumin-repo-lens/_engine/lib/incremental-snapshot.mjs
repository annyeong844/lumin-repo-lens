// Strict repo snapshot helpers for the shared incremental engine.
//
// This module is the new content-hash based path. It intentionally does
// not use `_lib/incremental.mjs`'s legacy stat-first-cut helper.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { collectFiles } from './collect-files.mjs';
import { JS_FAMILY_LANGS } from './lang.mjs';
import { isTestLikePath } from './test-paths.mjs';

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const STRICT_IDENTITY_MODE = 'strict-content-hash';

function posixRel(value) {
  return String(value).replace(/\\/g, '/');
}

export function normalizeRepoRel(root, absPath) {
  const rel = path.relative(path.resolve(root), path.resolve(absPath));
  return posixRel(rel);
}

export function languageOf(absPath) {
  return path.extname(absPath).slice(1).toLowerCase();
}

export function hashBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function hashJson(value) {
  return hashBytes(Buffer.from(JSON.stringify(value), 'utf8'));
}

export function buildContextFingerprint({
  includeTests,
  exclude = [],
  languages = JS_FAMILY_LANGS,
  producerContext = {},
}) {
  return hashJson({
    includeTests: includeTests === true,
    exclude: [...exclude].map(String).sort(),
    languages: [...languages].map(String).sort(),
    producerContext,
  });
}

function isInsideOrSame(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function defaultPackageScopeOf(root, absPath) {
  const resolvedRoot = path.resolve(root);
  let dir = path.dirname(path.resolve(absPath));

  while (isInsideOrSame(dir, resolvedRoot)) {
    if (existsSync(path.join(dir, 'package.json'))) {
      const rel = normalizeRepoRel(resolvedRoot, dir);
      return rel === '' ? '.' : rel;
    }
    if (dir === resolvedRoot) return '.';
    const parent = path.dirname(dir);
    if (parent === dir) return '.';
    dir = parent;
  }

  return '.';
}

export function repoFingerprintForRoot(root) {
  let realRoot = path.resolve(root);
  try {
    realRoot = realpathSync.native(root);
  } catch {
    realRoot = path.resolve(root);
  }

  const marker = existsSync(path.join(realRoot, '.git'))
    ? 'git-worktree'
    : existsSync(path.join(realRoot, 'package.json'))
      ? 'package-root'
      : 'directory-root';

  return hashJson({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    realRoot: posixRel(realRoot),
    marker,
    platform: process.platform,
  });
}

export function buildFileSnapshotEntry({
  root,
  absPath,
  contextFingerprint,
  packageScopeOf = defaultPackageScopeOf,
}) {
  const relPath = normalizeRepoRel(root, absPath);
  const language = languageOf(absPath);
  const isTestLike = isTestLikePath(relPath);
  const packageScope = packageScopeOf(root, absPath);

  let stat = null;
  try {
    stat = statSync(absPath);
  } catch (error) {
    return {
      relPath,
      absPath,
      language,
      isTestLike,
      packageScope,
      readable: false,
      mtimeMs: null,
      size: null,
      hash: null,
      contentHash: null,
      contextFingerprint,
      readError: { kind: error?.code ?? 'stat-failed' },
    };
  }

  try {
    const bytes = readFileSync(absPath);
    const contentHash = hashBytes(bytes);
    return {
      relPath,
      absPath,
      language,
      isTestLike,
      packageScope,
      readable: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: contentHash,
      contentHash,
      contextFingerprint,
    };
  } catch (error) {
    return {
      relPath,
      absPath,
      language,
      isTestLike,
      packageScope,
      readable: false,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: null,
      contentHash: null,
      contextFingerprint,
      readError: { kind: error?.code ?? 'read-failed' },
    };
  }
}

function sortEntriesByKey(entries) {
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}

export function buildRepoSnapshot({
  root,
  includeTests = true,
  exclude = [],
  languages = JS_FAMILY_LANGS,
  contextFingerprint,
  previousSnapshot = null,
  packageScopeOf = defaultPackageScopeOf,
}) {
  const files = collectFiles(root, { includeTests, exclude, languages });
  const entries = {};

  for (const absPath of files) {
    const entry = buildFileSnapshotEntry({
      root,
      absPath,
      contextFingerprint,
      packageScopeOf,
    });
    entries[entry.relPath] = entry;
  }

  const current = new Set(Object.keys(entries));
  const previous = previousSnapshot?.files && typeof previousSnapshot.files === 'object'
    ? Object.keys(previousSnapshot.files)
    : [];
  const droppedSincePrevious = previous
    .filter((relPath) => !current.has(relPath))
    .sort()
    .map((pathName) => ({ path: pathName, reason: 'deleted' }));

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    root: path.resolve(root),
    repoFingerprint: repoFingerprintForRoot(root),
    identityMode: STRICT_IDENTITY_MODE,
    scanOptions: {
      includeTests: includeTests === true,
      exclude: [...exclude],
      languages: [...languages],
    },
    files: sortEntriesByKey(entries),
    droppedSincePrevious,
  };
}
