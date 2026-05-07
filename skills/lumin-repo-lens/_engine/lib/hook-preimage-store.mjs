import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import { atomicWrite } from './atomic-write.mjs';
import { extractTypeEscapes } from './extract-ts-escapes.mjs';
import { isSafeId } from './hook-id-safety.mjs';
import {
  safeRepoPathSyntactic,
  safeRepoRelForRead,
} from './hook-path-safety.mjs';

const SCHEMA_VERSION = 'hook-preimage.v1';
const HASH_RE = /^sha256:[a-f0-9]{64}$/;

function requireSafeId(kind, value) {
  if (isSafeId(value)) return value;
  throw new Error(`unsafe ${kind} id`);
}

function preimageDir(auditRoot, sid) {
  return path.join(auditRoot, 'sessions', sid, 'preimages');
}

function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function readFileFingerprint(absolute, repoRel) {
  const bytes = readFileSync(absolute);
  const stat = statSync(absolute);
  const escapeFacts = extractTypeEscapes(bytes.toString('utf8'), repoRel);
  return {
    sha256: sha256Bytes(bytes),
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    typeEscapes: escapeFacts.typeEscapes ?? [],
    parseError: escapeFacts.parseError ?? null,
  };
}

function validRecord(record, sid, tid) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (record.schemaVersion !== SCHEMA_VERSION) return false;
  if (record.toolUseId !== tid) return false;
  if (typeof record.capturedAt !== 'string' || Number.isNaN(Date.parse(record.capturedAt))) {
    return false;
  }
  const repoRel = safeRepoPathSyntactic(record.repoRel);
  if (!repoRel.ok) return false;
  if (record.absent === true) return record.fingerprint === null;
  if (record.absent !== false) return false;
  const fp = record.fingerprint;
  if (!fp || typeof fp !== 'object' || Array.isArray(fp)) return false;
  return (
    typeof fp.sha256 === 'string' &&
    HASH_RE.test(fp.sha256) &&
    typeof fp.sizeBytes === 'number' &&
    Number.isFinite(fp.sizeBytes) &&
    fp.sizeBytes >= 0 &&
    typeof fp.mtimeMs === 'number' &&
    Number.isFinite(fp.mtimeMs) &&
    isSafeId(sid)
  );
}

export function preimagePath(auditRoot, sid, tid) {
  if (typeof auditRoot !== 'string' || auditRoot.length === 0) {
    throw new Error('auditRoot is required');
  }
  const safeSid = requireSafeId('session', sid);
  const safeTid = requireSafeId('tool use', tid);
  return path.join(auditRoot, 'sessions', safeSid, 'preimages', `${safeTid}.json`);
}

export function capturePreimage({ auditRoot, sid, tid, safe, now = new Date() }) {
  if (!safe?.ok) throw new Error('safe path is required');
  const repoRel = safeRepoPathSyntactic(safe.repoRel);
  if (!repoRel.ok) throw new Error(`unsafe repo-relative path: ${repoRel.reason}`);
  const readTarget = safeRepoRelForRead(safe.repoRoot, repoRel.repoRel);
  if (!readTarget.ok) throw new Error(`unsafe repo-relative path: ${readTarget.reason}`);

  const file = preimagePath(auditRoot, sid, tid);
  mkdirSync(path.dirname(file), { recursive: true });

  const hasFile = readTarget.exists === true && readTarget.kind === 'file';
  const record = {
    schemaVersion: SCHEMA_VERSION,
    capturedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    repoRel: repoRel.repoRel,
    toolUseId: tid,
    absent: !hasFile,
    fingerprint: hasFile ? readFileFingerprint(readTarget.absolute, repoRel.repoRel) : null,
  };

  atomicWrite(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function readPreimage(auditRoot, sid, tid) {
  let file;
  try {
    file = preimagePath(auditRoot, sid, tid);
  } catch {
    return null;
  }
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return validRecord(record, sid, tid) ? record : null;
  } catch {
    return null;
  }
}

export function cleanupPreimage(auditRoot, sid, tid) {
  let file;
  try {
    file = preimagePath(auditRoot, sid, tid);
  } catch {
    return false;
  }
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

export function cleanupOldPreimages(auditRoot, sid, { now = new Date(), maxAgeMs = 60 * 60 * 1000 } = {}) {
  let dir;
  try {
    dir = preimageDir(auditRoot, requireSafeId('session', sid));
  } catch {
    return 0;
  }
  if (!existsSync(dir)) return 0;

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (nowMs - stat.mtimeMs <= maxAgeMs) continue;
    rmSync(file, { force: true });
    removed++;
  }
  return removed;
}
