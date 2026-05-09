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

  function write() {
    if (!output) return;
    const artifactPath = producerPhaseTimingPath(output, producer);
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, JSON.stringify({
      schemaVersion: PRODUCER_PHASE_TIMING_SCHEMA_VERSION,
      producer,
      phases,
    }, null, 2));
  }

  return {
    phases,
    recordPhase,
    runPhase,
    write,
  };
}

export function readProducerPhaseTiming(output, producer) {
  try {
    const parsed = JSON.parse(readFileSync(producerPhaseTimingPath(output, producer), 'utf8'));
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
    return {
      schemaVersion: parsed.schemaVersion,
      producer: parsed.producer ?? producer,
      phases,
    };
  } catch {
    return null;
  }
}
