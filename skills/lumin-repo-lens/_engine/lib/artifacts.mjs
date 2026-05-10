// Artifact I/O helpers. Audit scripts chain their outputs through JSON
// files in a shared --output directory (symbols.json → dead-classify.json →
// fix-plan.json → lumin-repo-lens.sarif). Each script previously rolled its
// own "read this if it's there" helper with slightly different signatures
// and error-handling. Consolidating here keeps the contract uniform.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const ARTIFACT_READ_METRICS_SCHEMA_VERSION = 'artifact-read-metrics.v1';

function toMetricName(rootDir, filePath) {
  if (!rootDir) return path.basename(filePath);
  const rel = path.relative(path.resolve(rootDir), path.resolve(filePath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return path.basename(filePath);
  return rel.split(path.sep).join('/');
}

export function createArtifactReadMetrics({ rootDir, largestLimit = 10 } = {}) {
  const byName = new Map();
  let totalReadCount = 0;
  let totalReadBytes = 0;
  let totalReadMs = 0;
  let totalJsonParseMs = 0;
  let parseFailureCount = 0;

  function observeRead(record) {
    const bytes = Math.max(0, Math.round(Number(record?.bytes) || 0));
    const readMs = Math.max(0, Math.round(Number(record?.readMs) || 0));
    const jsonParseMs = Math.max(0, Math.round(Number(record?.jsonParseMs) || 0));
    const name = toMetricName(rootDir, record?.filePath ?? 'unknown');
    if (!byName.has(name)) {
      byName.set(name, {
        readCount: 0,
        totalBytes: 0,
        totalReadMs: 0,
        totalJsonParseMs: 0,
        parseFailureCount: 0,
      });
    }
    const entry = byName.get(name);
    entry.readCount++;
    entry.totalBytes += bytes;
    entry.totalReadMs += readMs;
    entry.totalJsonParseMs += jsonParseMs;
    if (record?.ok === false) entry.parseFailureCount++;

    totalReadCount++;
    totalReadBytes += bytes;
    totalReadMs += readMs;
    totalJsonParseMs += jsonParseMs;
    if (record?.ok === false) parseFailureCount++;
  }

  function sortedEntries() {
    return [...byName.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  function summary() {
    const largestReads = sortedEntries()
      .map(([name, entry]) => ({ name, bytes: entry.totalBytes, readCount: entry.readCount }))
      .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
      .slice(0, largestLimit);
    const slowestJsonParses = sortedEntries()
      .map(([name, entry]) => ({
        name,
        jsonParseMs: entry.totalJsonParseMs,
        readCount: entry.readCount,
      }))
      .filter((entry) => entry.jsonParseMs > 0)
      .sort((a, b) => b.jsonParseMs - a.jsonParseMs || a.name.localeCompare(b.name))
      .slice(0, largestLimit);

    return {
      schemaVersion: ARTIFACT_READ_METRICS_SCHEMA_VERSION,
      measurement: 'audit-repo-orchestrator-json-reads',
      totalReadCount,
      totalReadBytes,
      totalReadMs,
      totalJsonParseMs,
      parseFailureCount,
      largestReads,
      slowestJsonParses,
      byName: Object.fromEntries(sortedEntries()),
    };
  }

  return {
    observeRead,
    summary,
  };
}

// Load a JSON artifact by name from `dir`. Returns `null` when the file
// doesn't exist OR when parsing fails. Pass `{ tag: '<script>' }` to have
// parse failures logged to stderr as `[<script>] failed to parse <path>:
// <message>`; omit `tag` to keep parse failures silent (matches the
// pre-consolidation behavior of audit-repo / emit-sarif).
export function loadIfExists(dir, name, options = {}) {
  const filePath = path.isAbsolute(name) ? name : path.join(dir, name);
  return readJsonFile(filePath, options);
}

// Read and parse a JSON file at `filePath`.
//
// Returns `null` when the file doesn't exist. Handles UTF-8 BOM (Windows-
// authored package.json / tsconfig.json frequently carry the invisible
// ZWNBSP that `JSON.parse` rejects).
//
// **Parse-failure semantics (E-2, 2026-04-21 cleanup):**
// - `strict: true` — parse failure THROWS. Use when corruption should be a
//   hard-fail for the caller (e.g., a producer artifact that downstream
//   logic cannot safely degrade on). Rationale: silently returning null on
//   parse failure masks "file exists but corrupt" as "file missing", which
//   downstream handles as "degraded advisory" instead of "investigate now".
// - `strict: false` (default) — returns null on parse failure to preserve
//   backward compatibility with existing callers. ALWAYS logs to stderr
//   when the parse fails (previously only logged when `tag` was supplied);
//   "silent null on corruption" is the anti-pattern this file's consolidation
//   was fixing, so the log is unconditional now. `tag` still controls the
//   log prefix.
//
// Shared by `loadIfExists` (artifact reads) and package.json readers.
export function readJsonFile(filePath, options = {}) {
  const { tag, bomStrip = true, strict = false, onRead } = options;
  if (!existsSync(filePath)) return null;
  let raw = '';
  let readMs = 0;
  try {
    const readStarted = Date.now();
    raw = readFileSync(filePath, 'utf8');
    readMs = Date.now() - readStarted;
    if (bomStrip) raw = raw.replace(/^\uFEFF/, '');
    const parseStarted = Date.now();
    const parsed = JSON.parse(raw);
    const jsonParseMs = Date.now() - parseStarted;
    onRead?.({
      filePath,
      bytes: Buffer.byteLength(raw, 'utf8'),
      readMs,
      jsonParseMs,
      ok: true,
    });
    return parsed;
  } catch (e) {
    onRead?.({
      filePath,
      bytes: Buffer.byteLength(raw, 'utf8'),
      readMs,
      jsonParseMs: 0,
      ok: false,
    });
    const prefix = tag ? `[${tag}] ` : '[readJsonFile] ';
    console.error(`${prefix}failed to parse ${filePath}: ${e.message}`);
    if (strict) {
      throw new Error(`readJsonFile: parse failure at ${filePath}`, { cause: e });
    }
    return null;
  }
}

// Shared `meta:` base for producers that emit JSON artifacts. Currently
// standardizes three cross-producer fields — `tool`, `generated`, `root` —
// so a naming drift (e.g., `generatedAt` vs `generated`, v1.10.x review
// finding "AP-SharedShape") fails at test time, not at downstream-consumer
// time. Per-producer-specific fields (`supports`, `complete`, `scope`,
// `schemaVersion`, `filesWithParseErrors`, ...) are spread on top by each
// producer — intentional, since each artifact carries different contracts.
//
// Usage:
//   meta: {
//     ...producerMetaBase({ tool: 'any-inventory.mjs', root: ROOT }),
//     complete: filesWithParseErrors.length === 0,
//     supports: { typeEscapes: true, escapeKinds: [...] },
//     ...
//   }
//
// Note on SARIF: `emit-sarif.mjs` emits `generatedAt` per SARIF spec, not
// `generated`. It is NOT a producer in this family and intentionally does
// NOT use producerMetaBase.
export function producerMetaBase({ tool, root }) {
  if (typeof tool !== 'string' || tool.length === 0) {
    throw new Error('producerMetaBase: tool is required (non-empty string)');
  }
  return {
    tool,
    generated: new Date().toISOString(),
    root: root ?? null,
  };
}
