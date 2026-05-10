import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PRODUCER_PHASE_TIMING_SCHEMA_VERSION = 'producer-phase-timing.v1';
const PRODUCER_PHASE_DIR = '.producer-phases';

function safeProducerFileName(producer) {
  return path.basename(String(producer ?? 'unknown')).replace(/[^A-Za-z0-9._-]/g, '_');
}

export function producerPhaseTimingPath(output, producer) {
  return path.join(output, PRODUCER_PHASE_DIR, `${safeProducerFileName(producer)}.json`);
}

export function clearProducerPhaseTiming(output, producer) {
  try {
    rmSync(producerPhaseTimingPath(output, producer), { force: true });
  } catch {
    // Stale phase sidecars are diagnostic-only; failure to remove one should
    // never block the producer itself.
  }
}

export function createProducerPhaseTimer({ producer, output }) {
  const phases = [];
  const counters = {};

  function recordPhase(name, wallMs) {
    const numericWallMs = Number.isFinite(wallMs) ? Math.max(0, wallMs) : 0;
    phases.push({
      name: String(name),
      wallMs: Math.round(numericWallMs),
    });
  }

  function runPhase(name, fn) {
    const started = Date.now();
    try {
      return fn();
    } finally {
      recordPhase(name, Date.now() - started);
    }
  }

  function setCounter(name, value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return;
    counters[String(name)] = Math.max(0, Math.round(numericValue));
  }

  function incrementCounter(name, by = 1) {
    const numericBy = Number(by);
    if (!Number.isFinite(numericBy)) return;
    const key = String(name);
    counters[key] = Math.max(0, Math.round((counters[key] ?? 0) + numericBy));
  }

  function write() {
    if (!output) return;
    const artifactPath = producerPhaseTimingPath(output, producer);
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, JSON.stringify({
      schemaVersion: PRODUCER_PHASE_TIMING_SCHEMA_VERSION,
      producer,
      phases,
      ...(Object.keys(counters).length > 0 ? { counters } : {}),
    }, null, 2));
  }

  return {
    counters,
    phases,
    incrementCounter,
    recordPhase,
    runPhase,
    setCounter,
    write,
  };
}

export function readProducerPhaseTiming(output, producer, { onRead } = {}) {
  const artifactPath = producerPhaseTimingPath(output, producer);
  let raw = '';
  let readMs = 0;
  try {
    const readStarted = Date.now();
    raw = readFileSync(artifactPath, 'utf8');
    readMs = Date.now() - readStarted;
    const parseStarted = Date.now();
    const parsed = JSON.parse(raw);
    const jsonParseMs = Date.now() - parseStarted;
    onRead?.({
      filePath: artifactPath,
      bytes: Buffer.byteLength(raw, 'utf8'),
      readMs,
      jsonParseMs,
      ok: true,
    });
    if (parsed?.schemaVersion !== PRODUCER_PHASE_TIMING_SCHEMA_VERSION) return null;
    const phases = Array.isArray(parsed.phases)
      ? parsed.phases
          .filter((phase) =>
            typeof phase?.name === 'string' &&
            typeof phase?.wallMs === 'number' &&
            Number.isFinite(phase.wallMs))
          .map((phase) => ({
            name: phase.name,
            wallMs: Math.max(0, Math.round(phase.wallMs)),
          }))
      : [];
    const counters = parsed.counters && typeof parsed.counters === 'object'
      ? Object.fromEntries(Object.entries(parsed.counters)
          .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
          .map(([name, value]) => [name, Math.max(0, Math.round(value))]))
      : {};
    return {
      schemaVersion: parsed.schemaVersion,
      producer: parsed.producer ?? producer,
      phases,
      ...(Object.keys(counters).length > 0 ? { counters } : {}),
    };
  } catch {
    if (raw) {
      onRead?.({
        filePath: artifactPath,
        bytes: Buffer.byteLength(raw, 'utf8'),
        readMs,
        jsonParseMs: 0,
        ok: false,
      });
    }
    return null;
  }
}
