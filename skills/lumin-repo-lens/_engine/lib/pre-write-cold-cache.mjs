// Cold-cache preflight for the pre-write gate (P1-3).
//
// Artifact-by-artifact preflight — each requested artifact is checked
// independently. Only the missing ones trigger their producer. Producers
// are spawned via `execFileSync` with argv
// arrays; shell-string execution is FORBIDDEN (paths may contain spaces,
// `$`, or parentheses).
//
// Canonical anchors:
//   - canonical/pre-write-gate.md §4 — latency budget (< 5s warm, < 30s cold)
//   - canonical/mode-contract.md §6 — failure semantics
//   - maintainer history notes §4.3 — CLI cold-cache flow
//   - maintainer history notes §8 — timeout policy
//
// Module exports:
//   COLD_CACHE_TIMEOUT_MS — default 30_000, overridable via
//     PRE_WRITE_COLD_CACHE_TIMEOUT_MS env var (test-only hook).
//   runColdCachePreflight({ root, output, skillRoot, fresh, intent, includeTests, exclude }) →
//     { attempted: string[], failures: object[] }

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { functionSignatureFromTypeLiteral } from './function-signature-hash.mjs';

const DEFAULT_COLD_CACHE_TIMEOUT_MS = 30_000;

function coldCacheTimeoutMs() {
  const envVal = Number(process.env.PRE_WRITE_COLD_CACHE_TIMEOUT_MS);
  if (Number.isFinite(envVal) && envVal > 0) return envVal;
  return DEFAULT_COLD_CACHE_TIMEOUT_MS;
}

// Producer registry — artifact → {script, failKind, timeoutKind}.
//
// Ordering matters: symbols.json is the most foundational (classify +
// file lookup depend on it). Keep sequential, no parallelism, so a
// downstream producer sees upstream output.
const PRODUCERS = [
  {
    artifact: 'symbols.json',
    script: 'build-symbol-graph.mjs',
    failKind: 'cold-cache-symbols-failed',
    timeoutKind: 'cold-cache-symbols-timeout',
  },
  {
    artifact: 'topology.json',
    script: 'measure-topology.mjs',
    failKind: 'cold-cache-topology-failed',
    timeoutKind: 'cold-cache-topology-timeout',
  },
  {
    artifact: 'triage.json',
    script: 'triage-repo.mjs',
    failKind: 'cold-cache-triage-failed',
    timeoutKind: 'cold-cache-triage-timeout',
  },
];

const SHAPE_INDEX_PRODUCER = {
  artifact: 'shape-index.json',
  script: 'build-shape-index.mjs',
  failKind: 'cold-cache-shape-index-failed',
  timeoutKind: 'cold-cache-shape-index-timeout',
};

const FUNCTION_CLONES_PRODUCER = {
  artifact: 'function-clones.json',
  script: 'build-function-clone-index.mjs',
  failKind: 'cold-cache-function-clones-failed',
  timeoutKind: 'cold-cache-function-clones-timeout',
};

const PRODUCER_ORDER = [
  ...PRODUCERS,
  SHAPE_INDEX_PRODUCER,
  FUNCTION_CLONES_PRODUCER,
];

function hasEntries(value) {
  return Array.isArray(value) && value.length > 0;
}

function hasFunctionSignatureShapeIntent(intent) {
  return (intent?.shapes ?? []).some((shape) =>
    typeof shape?.typeLiteral === 'string' &&
    functionSignatureFromTypeLiteral(shape.typeLiteral).ok === true);
}

function selectProducers({ intent, includeShapeIndex }) {
  // Backward-compatible fallback for older tests/callers that have not yet
  // passed an intent. The public CLI passes intent and therefore gets the
  // narrower preflight below.
  if (!intent) {
    return includeShapeIndex
      ? [...PRODUCERS, SHAPE_INDEX_PRODUCER]
      : PRODUCERS;
  }

  const needed = new Set();

  if (hasEntries(intent.names)) {
    needed.add('symbols.json');
  }

  if (hasEntries(intent.files)) {
    // File lookup needs topology + triage for neighboring/cluster evidence
    // and symbols for parse-error honesty and file-local definition facts.
    needed.add('symbols.json');
    needed.add('topology.json');
    needed.add('triage.json');
  }

  if (hasEntries(intent.dependencies)) {
    // package.json is read directly, but symbols lets the advisory report
    // observed import consumers without running a full audit.
    needed.add('symbols.json');
  }

  if (hasEntries(intent.shapes) || includeShapeIndex) {
    needed.add('shape-index.json');
  }

  if (hasFunctionSignatureShapeIntent(intent)) {
    needed.add('function-clones.json');
  }

  return PRODUCER_ORDER.filter((producer) => needed.has(producer.artifact));
}

// Spawn one producer. Returns null on success, or a failures[] entry on
// failure / timeout. Never throws — cold-cache is fail-soft by design.
function scanArgs({ includeTests, exclude }) {
  const args = [];
  if (includeTests === false) args.push('--production');
  for (const item of (exclude ?? [])) args.push('--exclude', item);
  return args;
}

function runOne({ producer, root, output, skillRoot, timeoutMs, includeTests, exclude }) {
  const scriptPath = path.join(skillRoot, producer.script);
  try {
    execFileSync(process.execPath, [
      scriptPath,
      '--root', root,
      '--output', output,
      ...scanArgs({ includeTests, exclude }),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      encoding: 'utf8',
    });
    return null;
  } catch (e) {
    // Node execFileSync surfaces timeout via `e.signal === 'SIGTERM'`
    // plus `e.code === null`, OR via `e.killed === true` with a string
    // reason. On Windows the signal is 'SIGTERM' when Node kills the
    // child after `timeout` expires.
    const isTimeout = e?.killed === true || e?.signal === 'SIGTERM' || e?.code === 'ETIMEDOUT';
    const stderr = (e?.stderr?.toString?.() ?? '').slice(0, 400);
    const stdout = (e?.stdout?.toString?.() ?? '').slice(0, 200);
    if (isTimeout) {
      return { kind: producer.timeoutKind, timeoutMs, stderr, stdout };
    }
    return {
      kind: producer.failKind,
      exitCode: e?.status ?? null,
      stderr,
      stdout,
      message: e?.message ?? String(e),
    };
  }
}

/**
 * Run cold-cache preflight.
 *
 * @param {{
 *   root: string,       // --root value passed to producers
 *   output: string,     // --output value passed to producers
 *   skillRoot: string,  // directory containing the producer scripts
 *   fresh: boolean,     // whether to actually spawn (--no-fresh-audit → false)
 *   intent?: object,     // validated pre-write intent; narrows producer set
 *   includeShapeIndex?: boolean, // backward-compatible shape-index request
 *   includeTests?: boolean, // forwarded scan scope
 *   exclude?: string[], // forwarded directory/file-path exclusions
 * }} opts
 * @returns {{ attempted: string[], failures: object[] }}
 */
export function runColdCachePreflight({
  root,
  output,
  skillRoot,
  fresh,
  intent = null,
  includeShapeIndex = false,
  includeTests = true,
  exclude = [],
}) {
  const attempted = [];
  const failures = [];
  const timeoutMs = coldCacheTimeoutMs();
  const producers = selectProducers({ intent, includeShapeIndex });

  for (const producer of producers) {
    const artifactPath = path.join(output, producer.artifact);
    if (existsSync(artifactPath)) continue;  // already present, skip

    if (!fresh) {
      failures.push({
        kind: `${producer.artifact.replace('.json', '')}-missing`,
        reason: `${producer.artifact} not found in ${output}; --no-fresh-audit set so cold-cache was skipped`,
      });
      continue;
    }

    attempted.push(producer.script);
    process.stderr.write(`[pre-write] cold-cache: running ${producer.script}\n`);
    const failure = runOne({ producer, root, output, skillRoot, timeoutMs, includeTests, exclude });
    if (failure) {
      failures.push(failure);
      process.stderr.write(`[pre-write] cold-cache: ${producer.script} → ${failure.kind}\n`);
    } else {
      process.stderr.write(`[pre-write] cold-cache: ${producer.script} ok\n`);
    }
  }

  return { attempted, failures };
}
