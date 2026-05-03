// Deterministic file-path delta for post-write.
//
// This is intentionally only set arithmetic over repo-relative paths. It
// does not decide whether an unexpected file is wrong; it records whether the
// file appeared outside the pre-write intent's `files[]` declaration.

import path from 'node:path';

function normalizeRelPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
}

function normalizeRepoRelativePath(root, filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return null;
  const raw = filePath.trim();
  const rel = path.isAbsolute(raw)
    ? path.relative(path.resolve(root), raw)
    : raw;
  const normalized = normalizeRelPath(rel);
  return normalized.length > 0 ? normalized : null;
}

export function repoRelativeFileList(root, absoluteFiles) {
  const out = [];
  const seen = new Set();
  for (const file of absoluteFiles ?? []) {
    const rel = normalizeRepoRelativePath(root, file);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out.sort();
}

function normalizeList(root, values) {
  const out = [];
  const seen = new Set();
  for (const value of values ?? []) {
    const rel = normalizeRepoRelativePath(root, value);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out.sort();
}

function minus(left, rightSet) {
  return left.filter((item) => !rightSet.has(item));
}

function intersect(left, rightSet) {
  return left.filter((item) => rightSet.has(item));
}

export function computeFileDelta({ root, plannedFiles, beforeFiles, afterFiles, afterScanFailure = null }) {
  const planned = normalizeList(root, plannedFiles);

  if (afterScanFailure) {
    return {
      status: 'after-scan-failed',
      reason: afterScanFailure,
      plannedFiles: planned,
    };
  }

  if (!Array.isArray(afterFiles)) {
    return {
      status: 'after-missing',
      plannedFiles: planned,
    };
  }

  const after = normalizeList(root, afterFiles);
  if (!Array.isArray(beforeFiles)) {
    return {
      status: 'baseline-missing',
      plannedFiles: planned,
      afterCount: after.length,
      plannedObserved: intersect(planned, new Set(after)),
      plannedMissing: minus(planned, new Set(after)),
    };
  }

  const before = normalizeList(root, beforeFiles);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const plannedSet = new Set(planned);
  const newFiles = minus(after, beforeSet);
  const removed = minus(before, afterSet);
  const plannedNew = intersect(newFiles, plannedSet);
  const unexpectedNew = minus(newFiles, plannedSet);
  const plannedObserved = intersect(planned, afterSet);
  const plannedMissing = minus(planned, afterSet);

  return {
    status: 'computed',
    plannedFiles: planned,
    beforeCount: before.length,
    afterCount: after.length,
    newFiles,
    removed,
    plannedNew,
    unexpectedNew,
    plannedObserved,
    plannedMissing,
    summary: {
      newFiles: newFiles.length,
      removed: removed.length,
      plannedNew: plannedNew.length,
      unexpectedNew: unexpectedNew.length,
      plannedObserved: plannedObserved.length,
      plannedMissing: plannedMissing.length,
    },
  };
}
