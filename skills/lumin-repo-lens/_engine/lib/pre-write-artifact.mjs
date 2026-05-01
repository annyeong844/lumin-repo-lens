// Advisory artifact helpers for the pre-write gate (P1-1).
//
// Produces and writes `pre-write-advisory.latest.json` +
// `pre-write-advisory.<invocationId>.json` per maintainer history notes §4.5 + §5.4.
// The invocation-specific file is the P2 "before snapshot" anchor; the
// latest file is a convenience pointer for callers that don't track IDs.
//
// Atomicity: every write goes to a `.tmp.<random>` sibling first and is
// renamed into place. A crash mid-write leaves no partial file at the
// target path.

import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { atomicWrite } from './atomic-write.mjs';

// ── generateInvocationId ─────────────────────────────────────
//
// Shape: `YYYY-MM-DDTHH-mm-ssZ-<6-char-random>`.
// ISO timestamp with colons replaced by dashes so the string is a valid
// filename on every filesystem (Windows rejects `:` in filenames).

export function generateInvocationId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}Z`;
  const suffix = randomBytes(3).toString('hex');  // 6 hex chars
  return `${ts}-${suffix}`;
}

// ── hashIntent ───────────────────────────────────────────────
//
// Deterministic sha256 of the normalized intent JSON. Normalization
// walks the object recursively and sorts keys so `{a, b}` and `{b, a}`
// produce identical output. Arrays keep their order (array element
// order is semantically meaningful — `names: ['a', 'b']` differs from
// `names: ['b', 'a']`).

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortKeysDeep(value[k]);
    }
    return out;
  }
  return value;
}

export function hashIntent(intent) {
  const normalized = JSON.stringify(sortKeysDeep(intent ?? {}));
  return createHash('sha256').update(normalized).digest('hex');
}

// ── writeAdvisory ────────────────────────────────────────────
//
// Writes the advisory object to:
//   <outputDir>/pre-write-advisory.latest.json
//   <outputDir>/pre-write-advisory.<invocationId>.json
// Both files contain identical JSON. Serialization is pretty-printed
// (2-space indent) for human readability.

export function writeAdvisory(outputDir, advisory) {
  if (!advisory || typeof advisory.invocationId !== 'string') {
    throw new Error('writeAdvisory: advisory.invocationId is required');
  }
  const content = JSON.stringify(advisory, null, 2) + '\n';
  const latestPath = path.join(outputDir, 'pre-write-advisory.latest.json');
  const specificPath = path.join(outputDir, `pre-write-advisory.${advisory.invocationId}.json`);
  atomicWrite(specificPath, content);
  atomicWrite(latestPath, content);
  return { latestPath, specificPath };
}
