// Shared shape-index artifact contract.
//
// Producer and consumers use this module so `shape-index.json` does not grow
// multiple subtly different schema interpretations.

export const SHAPE_INDEX_SCHEMA_VERSION = 'shape-index.v1';
export const SHAPE_HASH_RE = /^sha256:[a-f0-9]{64}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortedStrings(values) {
  return [...values].sort();
}

function sameStringArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function factIdentities(fact) {
  const ids = Array.isArray(fact.identities) && fact.identities.length > 0
    ? fact.identities
    : [fact.identity];
  return ids.filter((id) => typeof id === 'string' && id.length > 0);
}

function isValidGeneratedFileEvidence(value) {
  return (
    isPlainObject(value) &&
    value.kind === 'generated-file' &&
    (value.source === 'path' || value.source === 'header') &&
    typeof value.evidence === 'string' &&
    value.evidence.length > 0
  );
}

export function parseShapeIndexArtifact(index) {
  if (
    !isPlainObject(index) ||
    index.schemaVersion !== SHAPE_INDEX_SCHEMA_VERSION ||
    !Array.isArray(index.facts) ||
    !isPlainObject(index.groupsByHash)
  ) {
    return {
      ok: false,
      reason: 'malformed-shape-index',
      detail: 'expected schemaVersion shape-index.v1 with facts[] and groupsByHash object',
    };
  }

  const factsByIdentity = new Map();
  const factsByHash = new Map();
  const expectedGroups = new Map();

  for (const fact of index.facts) {
    if (!isPlainObject(fact)) {
      return { ok: false, reason: 'malformed-shape-fact', detail: 'fact is not an object' };
    }
    if (typeof fact.identity !== 'string' || fact.identity.length === 0) {
      return { ok: false, reason: 'malformed-shape-fact', detail: 'fact.identity must be a non-empty string' };
    }
    if (typeof fact.hash !== 'string' || !SHAPE_HASH_RE.test(fact.hash)) {
      return { ok: false, reason: 'malformed-shape-fact', detail: `invalid hash for ${fact.identity}` };
    }
    if (factsByIdentity.has(fact.identity)) {
      return { ok: false, reason: 'duplicate-shape-identity', detail: `duplicate fact identity ${fact.identity}` };
    }
    if (fact.generatedFile !== undefined && !isValidGeneratedFileEvidence(fact.generatedFile)) {
      return {
        ok: false,
        reason: 'malformed-generated-file-evidence',
        detail: `invalid generatedFile evidence for ${fact.identity}`,
      };
    }

    const identities = factIdentities(fact);
    if (!identities.includes(fact.identity)) {
      return {
        ok: false,
        reason: 'shape-fact-identity-mismatch',
        detail: `fact.identities does not include fact.identity ${fact.identity}`,
      };
    }

    factsByIdentity.set(fact.identity, fact);
    if (!factsByHash.has(fact.hash)) factsByHash.set(fact.hash, []);
    factsByHash.get(fact.hash).push(fact);
    if (!expectedGroups.has(fact.hash)) expectedGroups.set(fact.hash, new Set());
    for (const id of identities) expectedGroups.get(fact.hash).add(id);
  }

  for (const [hash, actualIds] of Object.entries(index.groupsByHash)) {
    if (!SHAPE_HASH_RE.test(hash) || !Array.isArray(actualIds)) {
      return { ok: false, reason: 'malformed-shape-index-groups', detail: `invalid groupsByHash entry ${hash}` };
    }
    if (!actualIds.every((id) => typeof id === 'string' && id.length > 0)) {
      return { ok: false, reason: 'malformed-shape-index-groups', detail: `non-string identity in group ${hash}` };
    }
  }

  const allHashes = new Set([
    ...Object.keys(index.groupsByHash),
    ...expectedGroups.keys(),
  ]);
  for (const hash of allHashes) {
    const expected = sortedStrings(expectedGroups.get(hash) ?? []);
    const actual = sortedStrings(index.groupsByHash[hash] ?? []);
    if (!sameStringArray(expected, actual)) {
      return {
        ok: false,
        reason: 'shape-index-group-mismatch',
        detail: `groupsByHash[${hash}] does not match facts[]`,
      };
    }
  }

  for (const facts of factsByHash.values()) {
    facts.sort((a, b) => a.identity.localeCompare(b.identity));
  }

  return {
    ok: true,
    complete: index.meta?.complete === true,
    factsByIdentity,
    factsByHash,
    groupsByHash: index.groupsByHash,
  };
}
