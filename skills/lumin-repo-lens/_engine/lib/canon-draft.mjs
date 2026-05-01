// _lib/canon-draft.mjs — DRIFT-TEST-ONLY facade.
//
// This file used to be a 2064-LOC god module combining 4 P3 sub-phases.
// Post-P3 cleanup (2026-04-21) decomposed it into 5 focused leaf modules:
//
//   - canon-draft-utils.mjs     — shared constants, predicates, helpers.
//   - canon-draft-types.mjs     — P3-1 type-ownership.
//   - canon-draft-helpers.mjs   — P3-2 helper-registry.
//   - canon-draft-topology.mjs  — P3-3 topology.
//   - canon-draft-naming.mjs    — P3-4 naming.
//
// After Phase 2 consumer migration, this facade has exactly ONE legitimate
// consumer: `tests/test-classification-gates.mjs`. That test wants a
// single namespace handle to every canon-draft export for drift-test
// purposes (checks every mirror + enum + classifier exists + byte-equal
// to canonical). Splitting that test into 5 per-module imports would
// lose the "everything in one place" drift-test intent.
//
// **Production code MUST NOT import from this facade.** Import directly
// from the specific leaf module for clarity + lazy-load characteristics.
// Source-grep pin in `test-classification-gates.mjs` (FACADE-PIN-1) blocks
// regressions where new production code starts re-adopting the facade.

// ── Shared primitives (canon-draft-utils.mjs) ────────────────
export {
  LOW_INFO_NAMES,
  LOW_INFO_HELPER_NAMES,
  HELPER_OWNER_KINDS,
  UNCERTAIN_REASONS,
  TOPOLOGY_LABELS,
  TOPOLOGY_UNCERTAIN_REASONS,
  NAMING_LABELS,
  NAMING_CONVENTIONS,
  NAMING_UNCERTAIN_REASONS,
  CANON_DRAFT_SOURCES,
  isContaminated,
  isSeverelyContaminated,
  escapeMdCell,
  codeCell,
} from './canon-draft-utils.mjs';

// ── P3-1 type-ownership (canon-draft-types.mjs) ──────────────
export {
  classifyTypeNameGroup,
  classifySingleIdentity,
  collectTypeIdentities,
  renderTypeOwnership,
} from './canon-draft-types.mjs';

// ── P3-2 helper-registry (canon-draft-helpers.mjs) ───────────
export {
  classifyHelperGroup,
  classifyHelperIdentity,
  collectHelperIdentities,
  renderHelperRegistry,
} from './canon-draft-helpers.mjs';

// ── P3-3 topology (canon-draft-topology.mjs) ─────────────────
export {
  classifyTopologySubmodule,
  classifyTopologyScc,
  classifyTopologyFile,
  collectTopologyStructure,
  renderTopology,
} from './canon-draft-topology.mjs';

// ── P3-4 naming (canon-draft-naming.mjs) ─────────────────────
export {
  detectConvention,
  normalizeFileBasename,
  classifyNamingCohort,
  classifyNamingItem,
  collectNamingCohorts,
  renderNaming,
} from './canon-draft-naming.mjs';
