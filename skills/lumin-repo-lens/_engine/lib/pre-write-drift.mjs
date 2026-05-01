// Canonical drift derivation for the pre-write gate (P1-3).
//
// Pure read-only projection over `lookups` results from P1-1's
// `lookupName`. No filesystem reads, no canonical re-parsing, no
// name-lookup re-runs. The P1-1 `canonicalAstStatus` field already
// classifies every name → {aligned, ast-absent, owner-disagrees,
// not-consulted}; this module projects the two drifting states into
// structured drift entries.
//
// Canonical anchors:
//   - canonical/pre-write-gate.md §5 — output format (`CANONICAL DRIFT:`)
//   - canonical/pre-write-gate.md §8 — pre-write ↔ canonical interaction
//   - canonical/identity-and-alias.md §2 — identity rule
//   - maintainer history notes §4.1 — return shape
//   - maintainer history notes §5.1 — test case enumeration
//
// This module MUST NOT import `parseCanonicalFile` (that's a P1-0
// concern) or `lookupName` (P1-1). Pinning test asserts both absences
// by grepping the source.

/**
 * Project name-lookup results into canonical-drift entries.
 *
 * @param {{
 *   canonicalClaims: Array<{ name, ownerFile, line, file, section }>,
 *   lookups: Array<object>,
 * }} input
 * @returns {Array<{
 *   intentName: string,
 *   canonicalOwner: string,
 *   canonicalFile: string,
 *   canonicalLine: number,
 *   astOwners: string[],
 *   kind: 'owner-disagrees' | 'ast-absent',
 * }>}
 */
export function computeDrift({ canonicalClaims, lookups }) {
  const drift = [];
  if (!Array.isArray(lookups)) return drift;

  for (const lookup of lookups) {
    // Only name lookups are candidates for canonical drift. File / dep /
    // shape lookups have no canonical equivalent in P1-3 (`check-canon.mjs`
    // is P5 and handles those separately).
    if (lookup?.kind !== 'name') continue;

    const claim = lookup.canonicalClaim;
    if (!claim) continue;

    // Aligned / not-consulted are healthy or irrelevant — no drift.
    if (lookup.canonicalAstStatus === 'aligned') continue;
    if (lookup.canonicalAstStatus === 'not-consulted') continue;

    if (lookup.canonicalAstStatus === 'ast-absent') {
      drift.push({
        intentName: lookup.intentName,
        canonicalOwner: claim.ownerFile,
        canonicalFile: claim.file,
        canonicalLine: claim.line,
        astOwners: [],
        kind: 'ast-absent',
      });
      continue;
    }

    if (lookup.canonicalAstStatus === 'owner-disagrees') {
      const astOwners = (lookup.identities ?? []).map((i) => i.ownerFile);
      drift.push({
        intentName: lookup.intentName,
        canonicalOwner: claim.ownerFile,
        canonicalFile: claim.file,
        canonicalLine: claim.line,
        astOwners,
        kind: 'owner-disagrees',
      });
    }

    // Any other state value is ignored — honest no-op for future
    // canonicalAstStatus additions (P1-3 read-only; extending the state
    // space is a P1-1 concern).
  }

  // The `canonicalClaims` argument is accepted for API shape parity
  // with future drift logic that may need to walk canonical independently.
  // P1-3 does not consult it — every drift signal already lives on the
  // lookups.
  void canonicalClaims;

  return drift;
}
