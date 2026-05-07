// Single source of truth for cross-script vocabulary and the
// provenance-field forwarder used by `classify-dead-exports`.
//
// Why this module exists
// ──────────────────────
// Multiple scripts encode a shared contract — evidence labels on
// findings, taint kinds in `taintedBy`, tier strings in `fix-plan.json`.
// Before v1.10.1 these were scattered string literals across
// `classify-facts.mjs`, `classify-dead-exports.mjs`, `ranking.mjs`, and
// callers downstream. The failure mode that forced this refactor:
// during v1.10.0 P1, `classify-dead-exports.mjs`'s proposal-bucket
// mappers silently dropped the per-finding provenance fields for
// Class C and specifier buckets (the bug was caught only because the
// corpus test failed). Centralizing the forwarder here means the field
// list is added to ONCE — every bucket mapper picks it up automatically.
//
// What goes here
// ──────────────
//   - Constants: EVIDENCE labels, TAINT kinds (grouped by severity).
//   - `provenanceFields(finding)` — copies the known provenance keys
//     from a classified candidate into the emitted proposal entry.
//     Omits keys whose value is `undefined` so downstream consumers
//     can still use `has('foo')` / optional-chain checks.
//
// What does NOT go here
// ─────────────────────
//   - TIER constants (SAFE_FIX / REVIEW_FIX / DEGRADED / MUTED): live
//     in `_lib/ranking.mjs::TIERS` because they are the PUBLIC output
//     of ranking.mjs and several downstream consumers already read
//     them from there.
//   - JSON artifact schemas: out of scope for this vocabulary-only
//     module; a full `finding-schema.mjs` with assertShape helpers is
//     a separate follow-up.

// Evidence labels surfaced on each dead-candidate in
// `fileInternalUsesEvidence`. Readers gate behavior on the label
// (e.g., "this count came from a regex fallback, soften
// confidence"), so renaming one without updating consumers produces
// silent miscategorization. Keeping the mapping here makes drift
// detectable — a rename fails the vocab assertion test.
export const EVIDENCE = Object.freeze({
  // Primary path: the AST walker counted identifier references,
  // skipping property keys, import/export specifier slots, declaration
  // bindings, and common lexical shadowing cases. This is still not a
  // TypeScript checker-grade symbol binding guarantee.
  AST_REF_COUNT: 'ast-ident-ref-count',
  // Fast path: before parsing, source text was scanned for candidate
  // names. A candidate only uses this label when its identifier appears
  // exactly once, on its declaration line, and the file has no escaped
  // identifier syntax that could hide a reference from text matching.
  TEXT_ZERO_REF_COUNT: 'text-zero-ident-ref-count',
  // Fallback path: the file's source didn't parse, so the counter
  // dropped to word-boundary regex counting. The label surfaces
  // the loss of precision so rank-fixes / SARIF / Claude can
  // downgrade confidence.
  REGEX_FALLBACK: 'regex-text-fallback-parse-error',
  // Carried on the countFileReferencesAst return when parse fails,
  // before the caller chooses how to degrade.
  PARSE_ERROR: 'parse-error',
});

export const EVIDENCE_VALUES = Object.freeze(new Set(Object.values(EVIDENCE)));

// Taint kinds emitted by `computeFindingProvenance` and consumed
// by `ranking.mjs::tierForFinding`. Grouped by how the ranker reacts:
//
//   BLOCKING — finding is DEGRADED regardless of other evidence.
//              A single tsconfig-paths addition or a parse fix could
//              collapse the finding, so a warning-level SARIF level
//              would mislead.
//   SOFT     — SAFE_FIX demoted to REVIEW_FIX. Finding still
//              actionable for a human, but the automation tier is
//              withdrawn until the soft signal clears.
export const TAINT = Object.freeze({
  UNRESOLVED_SPEC_MATCH: 'unresolved-specifier-could-match',
  UNRESOLVED_SPEC_MATCH_UNKNOWN: 'unresolved-specifier-could-match-unknown',
  GENERATED_ARTIFACT_MISSING_RELEVANT: 'generated-artifact-missing-relevant',
  DEFINING_FILE_PARSE_ERROR: 'defining-file-parse-error',
  PARSE_ERRORS_ELSEWHERE: 'parse-errors-present',
});

export const BLOCKING_TAINTS = Object.freeze(new Set([
  TAINT.UNRESOLVED_SPEC_MATCH,
  TAINT.DEFINING_FILE_PARSE_ERROR,
]));

export const SOFT_TAINTS = Object.freeze(new Set([
  TAINT.UNRESOLVED_SPEC_MATCH_UNKNOWN,
  TAINT.GENERATED_ARTIFACT_MISSING_RELEVANT,
  TAINT.PARSE_ERRORS_ELSEWHERE,
]));

// Delta-entry labels emitted by `_lib/post-write-delta.mjs::computeDelta`.
// Consumed by the renderer + `requiredAcknowledgements(delta)` + `summarize`.
// Centralized here (not inside post-write-delta.mjs) so a new label added by
// the delta engine without a matching summary counter / render section fails
// the vocab-drift assertion test. The earlier bug class (v1.10.0 P1 silent
// provenance drop) is the same shape — every stringly-typed enumeration
// crossing multiple modules needs a single source.
export const DELTA_LABELS = Object.freeze({
  PLANNED:              'planned',
  PLANNED_NOT_OBSERVED: 'planned-not-observed',
  SILENT_NEW:           'silent-new',
  PRE_EXISTING:         'pre-existing',
  REMOVED:              'removed',
  OBSERVED_UNBASELINED: 'observed-unbaselined',
});

export const DELTA_LABEL_VALUES = Object.freeze(new Set(Object.values(DELTA_LABELS)));

// The provenance fields that MUST flow through every proposal bucket
// in `dead-classify.json`. Adding a new provenance field anywhere in
// the classifier is a two-line change: append here, emit it in
// `computeFindingProvenance`. Every bucket mapper picks it up via
// `...provenanceFields(c)` — that's the pattern that closed the
// silent-drop regression class in v1.10.0 P1.
const PROVENANCE_FIELD_NAMES = Object.freeze([
  'fileInternalUsesEvidence',
  'fileInternalRefs',
  'parseError',
  'supportedBy',
  'taintedBy',
  'resolverConfidence',
  'parseStatus',
  'declarationExportDependency',
  'declarationExportRefs',
]);

export function provenanceFields(c) {
  const out = {};
  for (const k of PROVENANCE_FIELD_NAMES) {
    if (c[k] !== undefined) out[k] = c[k];
  }
  return out;
}

// Exposed for tests that want to assert "the forwarder knows about
// exactly these keys" without exporting the mutable names array.
export function getProvenanceFieldNames() {
  return [...PROVENANCE_FIELD_NAMES];
}
