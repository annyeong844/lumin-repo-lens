// Artifact I/O helpers. Audit scripts chain their outputs through JSON
// files in a shared --output directory (symbols.json → dead-classify.json →
// fix-plan.json → lumin-repo-lens.sarif). Each script previously rolled its
// own "read this if it's there" helper with slightly different signatures
// and error-handling. Consolidating here keeps the contract uniform.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Load a JSON artifact by name from `dir`. Returns `null` when the file
// doesn't exist OR when parsing fails. Pass `{ tag: '<script>' }` to have
// parse failures logged to stderr as `[<script>] failed to parse <path>:
// <message>`; omit `tag` to keep parse failures silent (matches the
// pre-consolidation behavior of audit-repo / emit-sarif).
export function loadIfExists(dir, name, { tag } = {}) {
  const filePath = path.isAbsolute(name) ? name : path.join(dir, name);
  return readJsonFile(filePath, { tag });
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
export function readJsonFile(filePath, { tag, bomStrip = true, strict = false } = {}) {
  if (!existsSync(filePath)) return null;
  try {
    let raw = readFileSync(filePath, 'utf8');
    if (bomStrip) raw = raw.replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (e) {
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
