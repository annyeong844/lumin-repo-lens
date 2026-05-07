import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import { atomicWrite } from './atomic-write.mjs';
import { isSafeId } from './hook-id-safety.mjs';
import { safeRepoPathSyntactic } from './hook-path-safety.mjs';

const SCHEMA_VERSION = 'hook-event-store.v1';
const DEFAULT_REDELIVER_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 1000;
const DEFAULT_LOCK_STALE_MS = 30000;
const ALLOWED_ACK_SOURCES = new Set(['intentional', 'fixed', 'noted']);

function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
}

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nowMs(value = new Date()) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    entries: [],
    cursor: { lastClaimedAt: null },
  };
}

function requireSafeSessionId(sid) {
  if (isSafeId(sid)) return sid;
  throw new Error('unsafe session id');
}

function eventStorePath(auditRoot, sid) {
  return path.join(eventStoreDir(auditRoot, sid), 'ledger.json');
}

function eventId(seed) {
  return `evt_${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function oneLine(value, limit) {
  return stripAnsi(String(value ?? ''))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/`/g, '')
    .trim()
    .slice(0, limit);
}

function sanitizeSymbol(value) {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9_.]+/g, '')
    .slice(0, 64);
  return cleaned || 'unknown';
}

function sanitizeData(data = {}) {
  const file = safeRepoPathSyntactic(data.file).ok ? data.file : 'unknown';
  const line = typeof data.line === 'number' && Number.isFinite(data.line) ? data.line : null;
  return {
    file,
    line,
    escape_kind: oneLine(data.escape_kind, 64),
    snippet: oneLine(data.snippet, 160),
    enclosing_symbol: sanitizeSymbol(data.enclosing_symbol),
    matched_line_text: oneLine(data.matched_line_text, 160),
  };
}

function validState(state) {
  return (
    state &&
    typeof state === 'object' &&
    !Array.isArray(state) &&
    state.schemaVersion === SCHEMA_VERSION &&
    Array.isArray(state.entries) &&
    state.cursor &&
    typeof state.cursor === 'object' &&
    !Array.isArray(state.cursor)
  );
}

function writeState(auditRoot, sid, state) {
  const dir = eventStoreDir(auditRoot, sid);
  mkdirSync(dir, { recursive: true });
  atomicWrite(eventStorePath(auditRoot, sid), `${JSON.stringify(state, null, 2)}\n`);
}

function lockPath(auditRoot, sid) {
  return path.join(eventStoreDir(auditRoot, sid), '.event-store.lock');
}

function acquireLock(
  auditRoot,
  sid,
  { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, lockStaleMs = DEFAULT_LOCK_STALE_MS } = {}
) {
  const dir = eventStoreDir(auditRoot, sid);
  mkdirSync(dir, { recursive: true });
  const lock = lockPath(auditRoot, sid);
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      return { ok: true, lock };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = statSync(lock);
        if (Date.now() - stat.mtimeMs > lockStaleMs) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started >= lockTimeoutMs) {
        return { ok: false, reason: 'lock-timeout' };
      }
      sleepSync(10);
    }
  }
}

function withWriteLock(auditRoot, sid, opts, fn) {
  const acquired = acquireLock(auditRoot, sid, opts);
  if (!acquired.ok) return { ok: false, reason: acquired.reason };
  try {
    return { ok: true, value: fn() };
  } finally {
    rmSync(acquired.lock, { recursive: true, force: true });
  }
}

function findByDedupe(state, dedupeKey) {
  return state.entries.find((entry) => entry.dedupe_key === dedupeKey) ?? null;
}

function dueAt(entry, now) {
  if (!entry.active || entry.acknowledged) return false;
  if (!entry.next_redeliver_at) return true;
  return Date.parse(entry.next_redeliver_at) <= nowMs(now);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function eventStoreDir(auditRoot, sid) {
  if (typeof auditRoot !== 'string' || auditRoot.length === 0) {
    throw new Error('auditRoot is required');
  }
  return path.join(auditRoot, 'sessions', requireSafeSessionId(sid), 'event-store');
}

export function readEventStoreState(auditRoot, sid) {
  let file;
  try {
    file = eventStorePath(auditRoot, sid);
  } catch {
    return emptyState();
  }
  if (!existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return validState(parsed) ? parsed : emptyState();
  } catch {
    return emptyState();
  }
}

export function appendEventIfNotDeduped(auditRoot, sid, event, opts = {}) {
  const { now = new Date() } = opts;
  let safeSid;
  try {
    safeSid = requireSafeSessionId(sid);
  } catch {
    return { appended: false, eventId: null };
  }
  const locked = withWriteLock(auditRoot, safeSid, opts, () => {
    const state = readEventStoreState(auditRoot, safeSid);
    const existing = findByDedupe(state, event?.dedupe_key);
    if (existing) {
      if (existing.active && !existing.acknowledged) {
        existing.last_seen_at = iso(now);
        existing.occurrence_count += Math.max(1, event?.occurrence_delta ?? 1);
        existing.data = sanitizeData(event?.data);
        writeState(auditRoot, safeSid, state);
        return { appended: false, eventId: existing.id };
      }
      if (existing.active && existing.acknowledged) {
        return { appended: false, eventId: existing.id };
      }
      if (!existing.active && existing.delivery_policy === 'until_ack') {
        return { appended: false, eventId: existing.id };
      }
    }

    const timestamp = iso(now);
    const id = eventId(`${safeSid}\0${event?.dedupe_key ?? ''}\0${timestamp}\0${state.entries.length}`);
    const entry = {
      id,
      active: true,
      session_id: safeSid,
      kind: event?.kind ?? 'silent-new',
      severity: event?.severity ?? 'warn',
      ack_required: event?.ack_required !== false,
      delivery_policy: event?.delivery_policy ?? 'until_ack',
      diff_key: event?.diff_key ?? null,
      dedupe_key: event?.dedupe_key ?? id,
      data: sanitizeData(event?.data),
      created_at: timestamp,
      first_seen_at: timestamp,
      last_seen_at: timestamp,
      occurrence_count: Math.max(1, event?.occurrence_delta ?? 1),
      delivered_count: 0,
      delivered_at: null,
      next_redeliver_at: null,
      acknowledged: false,
      acknowledged_at: null,
      ack_source: null,
      archived_at: null,
      archive_reason: null,
    };
    state.entries.push(entry);
    writeState(auditRoot, safeSid, state);
    return { appended: true, eventId: id };
  });
  return locked.ok ? locked.value : { appended: false, eventId: null, reason: locked.reason };
}

export function claimDueDeliveriesAndAdvanceCursor(auditRoot, sid, opts = {}) {
  const { now = new Date(), limit = 5 } = opts;
  let safeSid;
  try {
    safeSid = requireSafeSessionId(sid);
  } catch {
    return { snapshots: [], ackHints: [] };
  }
  const locked = withWriteLock(auditRoot, safeSid, opts, () => {
    const state = readEventStoreState(auditRoot, safeSid);
    const snapshots = state.entries
      .filter((entry) => dueAt(entry, now))
      .slice(0, Math.max(0, limit))
      .map((entry) => cloneJson(entry));
    if (snapshots.length > 0 || existsSync(eventStorePath(auditRoot, safeSid))) {
      state.cursor.lastClaimedAt = iso(now);
      writeState(auditRoot, safeSid, state);
    }
    return { snapshots, ackHints: [] };
  });
  return locked.ok ? locked.value : { snapshots: [], ackHints: [] };
}

export function markDelivered(
  auditRoot,
  sid,
  eventId,
  opts = {}
) {
  const { now = new Date(), redeliverAfterMs = DEFAULT_REDELIVER_AFTER_MS } = opts;
  let safeSid;
  try {
    safeSid = requireSafeSessionId(sid);
  } catch {
    return false;
  }
  const locked = withWriteLock(auditRoot, safeSid, opts, () => {
    const state = readEventStoreState(auditRoot, safeSid);
    const entry = state.entries.find((candidate) => candidate.id === eventId);
    if (!entry) return false;
    entry.delivered_count += 1;
    entry.delivered_at = iso(now);
    entry.next_redeliver_at = new Date(nowMs(now) + redeliverAfterMs).toISOString();
    writeState(auditRoot, safeSid, state);
    return true;
  });
  return locked.ok ? locked.value : false;
}

export function markAcknowledged(auditRoot, sid, eventId, ackSource, opts = {}) {
  const { now = new Date() } = opts;
  let safeSid;
  try {
    safeSid = requireSafeSessionId(sid);
  } catch {
    return false;
  }
  if (!ALLOWED_ACK_SOURCES.has(ackSource)) return false;
  const locked = withWriteLock(auditRoot, safeSid, opts, () => {
    const state = readEventStoreState(auditRoot, safeSid);
    const entry = state.entries.find((candidate) => candidate.id === eventId);
    if (!entry || !entry.active) return false;
    entry.acknowledged = true;
    entry.acknowledged_at = iso(now);
    entry.ack_source = ackSource;
    writeState(auditRoot, safeSid, state);
    return true;
  });
  return locked.ok ? locked.value : false;
}

export function cleanupAckedEntries(auditRoot, sid, opts = {}) {
  const { now = new Date() } = opts;
  let safeSid;
  try {
    safeSid = requireSafeSessionId(sid);
  } catch {
    return 0;
  }
  const locked = withWriteLock(auditRoot, safeSid, opts, () => {
    const state = readEventStoreState(auditRoot, safeSid);
    let changed = 0;
    for (const entry of state.entries) {
      if (!entry.active || !entry.acknowledged) continue;
      entry.active = false;
      entry.archived_at = iso(now);
      entry.archive_reason = 'acked-cleanup';
      changed++;
    }
    if (changed > 0) writeState(auditRoot, safeSid, state);
    return changed;
  });
  return locked.ok ? locked.value : 0;
}
