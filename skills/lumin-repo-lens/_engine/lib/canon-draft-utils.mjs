// _lib/canon-draft-utils.mjs — shared primitives for P3 canon draft modules.
//
// Extracted from the monolithic `_lib/canon-draft.mjs` during the post-P3
// cleanup (2026-04-21). This module holds:
//   - Label mirrors (LOW_INFO_NAMES, LOW_INFO_HELPER_NAMES, TOPOLOGY_LABELS,
//     NAMING_LABELS, NAMING_CONVENTIONS)
//   - Kind / source / reason enums (HELPER_OWNER_KINDS, UNCERTAIN_REASONS,
//     TOPOLOGY_UNCERTAIN_REASONS, NAMING_UNCERTAIN_REASONS, CANON_DRAFT_SOURCES)
//   - Contamination predicates (isContaminated, isSeverelyContaminated)
//   - Identity construction helper (makeIdentity)
//   - Markdown hygiene helpers (escapeMdCell, codeCell)
//
// The four sub-phase modules (canon-draft-{types,helpers,topology,naming})
// import from here. Splitting avoids the 2064-LOC god-module flagged by the
// skill's own canonical §11.3 extreme-oversize rule.
//
// Identity discipline (canonical/fact-model.md §3.1 + maintainer history notes v2 §5.1):
//   - Identity format is ALWAYS `ownerFile::exportedName`.
//   - `exportedName` is the canonical identity field.
//   - `typeName` / `helperName` / `calleeName` are display aliases; on owner
//     facts they equal `exportedName`.

// ── LOW_INFO_NAMES mirror ─────────────────────────────────
//
// Source of truth: `canonical/classification-gates.md` §3. Mirror must be
// byte-equal (names + order). Drift caught by T1/T3/T8.

export const LOW_INFO_NAMES = Object.freeze([
  'Props', 'Options', 'Config', 'State', 'Result', 'Meta', 'Item', 'Data',
  'Context', 'Args', 'Params', 'Response', 'Request', 'Handler', 'Input', 'Output',
]);

export const LOW_INFO_NAMES_SET = new Set(LOW_INFO_NAMES);

// ── LOW_INFO_HELPER_NAMES mirror (canonical §10.4) ──────────
//
// Helper-specific low-info list. Distinct from LOW_INFO_NAMES because
// type-ish names (Props, Options, Result) and helper-ish names (get, parse,
// format) carry different semantic weight. Mirror drift-checked by H2/H7.

export const LOW_INFO_HELPER_NAMES = Object.freeze([
  'get', 'set', 'parse', 'format', 'fetch', 'load', 'save', 'build', 'make',
  'create', 'update', 'handle', 'run', 'process', 'convert',
]);

export const LOW_INFO_HELPER_NAMES_SET = new Set(LOW_INFO_HELPER_NAMES);

// ── Helper-owner kinds (maintainer history notes v2 §5.3 + HW-9) ──────────
//
// Exported top-level helper declarations. Mirrors `_lib/extract-ts.mjs`
// output kinds verbatim. Class methods NOT included (canonical §10.7).

export const HELPER_OWNER_KINDS = Object.freeze(new Set([
  'FunctionDeclaration',
  'const-var',
  'let-var',
  'var-var',
]));

// ── UNCERTAIN_REASONS enum (maintainer history notes v2 §4.1) ─────────────
//
// Helper-registry [확인 불가] reasons. Exactly four values in v1.

export const UNCERTAIN_REASONS = Object.freeze([
  'ambiguous-star-reexport',
  'resolveIdentity-depth-exceeded',
  'unresolved-specifier',
  'helper-owner-facts-unavailable',
]);

// ── TOPOLOGY_LABELS mirror (canonical §11.4 — P3-3) ─────────
//
// 8 labels: 5 submodule + 1 SCC + 2 oversize tiers. Drift-locked by TP7.

export const TOPOLOGY_LABELS = Object.freeze([
  'cyclic-submodule',
  'isolated-submodule',
  'shared-submodule',
  'leaf-submodule',
  'scoped-submodule',
  'forbidden-cycle',
  'oversize',
  'extreme-oversize',
]);

// ── TOPOLOGY_UNCERTAIN_REASONS (maintainer history notes v3, reviewer P1-5) ──
//
// Separate enum from helper UNCERTAIN_REASONS to prevent enum jumble.

export const TOPOLOGY_UNCERTAIN_REASONS = Object.freeze([
  'topology-artifact-incomplete',   // meta.complete === false (parse gap)
  'topology-artifact-stale',        // meta.generated > 24h old (time-based)
  'submodule-boundary-mismatch',    // triage.boundaries workspace lacks topology match
]);

// ── NAMING_LABELS mirror (canonical §12.3 — P3-4) ───────────
//
// 10 labels: 7 cohort (§12.1) + 3 per-item (§12.2). Drift-locked by TN6.

export const NAMING_LABELS = Object.freeze([
  // §12.1 cohort (7)
  'camelCase-dominant',
  'PascalCase-dominant',
  'kebab-case-dominant',
  'snake_case-dominant',
  'UPPER_SNAKE-dominant',
  'mixed-convention',
  'insufficient-evidence',
  // §12.2 per-item (3)
  'convention-match',
  'convention-outlier',
  'low-info-excluded',
]);

// ── NAMING_CONVENTIONS mirror (canonical §12.5) ─────────────
//
// detectConvention(name) return values. Six distinct patterns.

export const NAMING_CONVENTIONS = Object.freeze([
  'camelCase',
  'PascalCase',
  'kebab-case',
  'snake_case',
  'UPPER_SNAKE',
  'mixed',
]);

// ── NAMING_UNCERTAIN_REASONS (maintainer history notes v2) ────────────────
//
// `cohort-insufficient-evidence` (NOT bare `insufficient-evidence`) so the
// reason string stays distinct from the §12.3 cohort label of the same
// semantic intent. Reasons and labels live in different namespaces.

export const NAMING_UNCERTAIN_REASONS = Object.freeze([
  'parse-error',
  'cohort-insufficient-evidence',
]);

// ── CANON_DRAFT_SOURCES (maintainer history notes v2 P1-9) ────────────────
//
// Single source-of-truth for the `--source` universe. Both
// `generate-canon-draft.mjs --source` and `audit-repo.mjs --canon-draft
// --sources` validate against this constant.

export const CANON_DRAFT_SOURCES = Object.freeze([
  'type-ownership',
  'helper-registry',
  'topology',
  'naming',
]);

// ── Contamination helpers ───────────────────────────────────
//
// Rule 0 in canonical §2 requires EVERY member carry `any-contaminated` or
// `severely-any-contaminated` — NOT `has-any` only or `unknown-surface` only.
// Rule 0 in §4 requires the single member carry `severely-any-contaminated`.

const CONTAMINATED_LABELS = new Set(['any-contaminated', 'severely-any-contaminated']);

export function isContaminated(contamination) {
  return !!contamination && CONTAMINATED_LABELS.has(contamination.label);
}

export function isSeverelyContaminated(contamination) {
  return !!contamination && contamination.label === 'severely-any-contaminated';
}

// ── Identity helper ─────────────────────────────────────────
//
// Canonical identity format `ownerFile::exportedName` per fact-model §3.1.
// Every Map/Set keying across P3 sub-phases goes through this function.

export function makeIdentity(file, exportedName) {
  return `${file}::${exportedName}`;
}

// ── Markdown hygiene helpers ────────────────────────────────

/**
 * Escape a cell value for inclusion in a Markdown table cell.
 * Handles `|` (breaks the cell), `\` (escape char), and `\n` (breaks the row).
 * Idempotent on already-safe input.
 */
export function escapeMdCell(s) {
  if (s === null || s === undefined) return '';
  const str = String(s);
  return str
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/**
 * Wrap a value in backticks for code-style rendering in Markdown cells.
 * CommonMark rule for embedded backticks: if the content already contains
 * single backticks, wrap in double backticks and pad with spaces.
 * Empty input → empty string (avoids '``' rendering).
 */
export function codeCell(s) {
  if (s === null || s === undefined) return '';
  const str = String(s);
  if (str.length === 0) return '';
  if (str.includes('`')) {
    return '`` ' + str + ' ``';
  }
  return '`' + str + '`';
}
