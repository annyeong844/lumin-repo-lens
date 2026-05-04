import {
  TOKENIZER_VERSION,
  TOKEN_POLICY_VERSION,
  tokenPolicyMetadata,
} from './pre-write-token-policy.mjs';

export const CUE_TIERS = Object.freeze({
  SAFE: 'SAFE_CUE',
  AGENT_REVIEW: 'AGENT_REVIEW_CUE',
  MUTED: 'MUTED_CUE',
});

export const UNAVAILABLE_STATUS = 'UNAVAILABLE';

const POLICY_EXCLUDED_RE = /(^|\/)(dist|build|coverage|vendor|generated|node_modules)\//;
const TIER_PRIORITY = Object.freeze({
  [CUE_TIERS.SAFE]: 0,
  [CUE_TIERS.AGENT_REVIEW]: 1,
  [CUE_TIERS.MUTED]: 2,
});

function tierRank(tier) {
  return TIER_PRIORITY[tier] ?? 99;
}

function candidateKey(candidate) {
  return candidate?.identity ?? `${candidate?.ownerFile ?? 'unknown'}::${candidate?.exportedName ?? 'unknown'}`;
}

function sortCards(cards) {
  return cards.sort((a, b) =>
    tierRank(a.renderTier) - tierRank(b.renderTier) ||
    String(a.candidate?.ownerFile ?? '').localeCompare(String(b.candidate?.ownerFile ?? '')) ||
    String(a.candidate?.exportedName ?? '').localeCompare(String(b.candidate?.exportedName ?? '')) ||
    String(a.candidate?.identity ?? '').localeCompare(String(b.candidate?.identity ?? ''))
  );
}

function sortSuppressed(cues) {
  return cues.sort((a, b) =>
    String(a.reason ?? '').localeCompare(String(b.reason ?? '')) ||
    String(a.ownerFile ?? '').localeCompare(String(b.ownerFile ?? '')) ||
    String(a.exportedName ?? a.name ?? '').localeCompare(String(b.exportedName ?? b.name ?? ''))
  );
}

function isPolicyExcludedCandidate(candidate) {
  return candidate?.policyExcluded === true ||
    POLICY_EXCLUDED_RE.test(String(candidate?.ownerFile ?? '').replace(/\\/g, '/'));
}

function policyReasonFor(candidate) {
  if (candidate?.policyReason) return candidate.policyReason;
  const file = String(candidate?.ownerFile ?? '').replace(/\\/g, '/');
  const match = file.match(POLICY_EXCLUDED_RE);
  return match ? `path:${match[2]}` : 'policy-excluded';
}

function ensureCard(map, candidate) {
  const key = candidateKey(candidate);
  if (!map.has(key)) {
    map.set(key, {
      candidate: {
        identity: candidate.identity,
        ownerFile: candidate.ownerFile,
        exportedName: candidate.exportedName,
      },
      renderTier: CUE_TIERS.SAFE,
      cues: [],
    });
  }
  return map.get(key);
}

function addCue(cardMap, suppressedCues, candidate, cue) {
  if (isPolicyExcludedCandidate(candidate)) {
    suppressedCues.push({
      ...cue,
      cueTier: CUE_TIERS.MUTED,
      originalCueTier: cue.cueTier,
      reason: 'policy-excluded',
      policyReason: policyReasonFor(candidate),
      ownerFile: candidate.ownerFile,
      exportedName: candidate.exportedName,
      identity: candidate.identity,
    });
    return;
  }
  const card = ensureCard(cardMap, candidate);
  card.cues.push(cue);
  // Any review cue makes the candidate render as a review task, while each
  // grounded cue stays preserved independently in cues[].
  if (cue.cueTier === CUE_TIERS.AGENT_REVIEW) {
    card.renderTier = CUE_TIERS.AGENT_REVIEW;
  }
}

function safeCue({ lane, claim, evidence }) {
  return {
    cueTier: CUE_TIERS.SAFE,
    safeMeaning: 'claim-only',
    notSafeFor: ['semantic-equivalence', 'auto-reuse', 'auto-fix'],
    evidenceLane: lane,
    claim,
    confidence: 'grounded',
    evidence,
  };
}

function reviewCue({ lane, claim, evidence }) {
  return {
    cueTier: CUE_TIERS.AGENT_REVIEW,
    evidenceLane: lane,
    claim,
    confidence: 'heuristic-review',
    evidence,
  };
}

function candidateFromIdentity(identity, fallback = {}) {
  const [ownerFile, exportedName] = String(identity ?? '').split('::');
  return {
    identity,
    ownerFile: fallback.ownerFile ?? ownerFile,
    exportedName: fallback.exportedName ?? exportedName,
    policyExcluded: fallback.policyExcluded,
    policyReason: fallback.policyReason,
  };
}

function addNameLookup({ lookup, cardMap, suppressedCues }) {
  for (const identity of lookup.identities ?? []) {
    addCue(cardMap, suppressedCues, identity, safeCue({
      lane: 'exact-symbol',
      claim: 'exact exported symbol exists',
      evidence: [{
        artifact: 'symbols.json',
        matchedField: 'defIndex',
        candidateIdentity: identity.identity,
        algorithmVersion: 'exact-symbol.v1',
      }],
    }));
  }

  for (const near of lookup.nearNames ?? []) {
    const identity = `${near.ownerFile}::${near.name}`;
    addCue(cardMap, suppressedCues, candidateFromIdentity(identity, near), reviewCue({
      lane: 'near-name',
      claim: 'near exported name',
      evidence: [{
        artifact: 'symbols.json',
        matchedField: 'defIndex',
        algorithmVersion: 'near-name.v1',
        distance: near.distance,
      }],
    }));
  }

  for (const hint of lookup.semanticHints ?? []) {
    const identity = `${hint.ownerFile}::${hint.name}`;
    addCue(cardMap, suppressedCues, candidateFromIdentity(identity, hint), reviewCue({
      lane: 'intent-token',
      claim: 'supported intent-token overlap',
      evidence: [{
        artifact: 'symbols.json',
        matchedField: 'defIndex',
        algorithmVersion: TOKEN_POLICY_VERSION,
        tokens: hint.matchedTokens ?? [],
      }],
    }));
  }

  for (const hint of lookup.suppressedSemanticHints ?? []) {
    suppressedCues.push({
      cueTier: CUE_TIERS.MUTED,
      evidenceLane: 'intent-token',
      reason: hint.reason ?? 'weak-common-token-only',
      tokens: hint.matchedTokens ?? [],
      candidateCount: hint.candidateCount ?? 1,
      tokenizerVersion: TOKENIZER_VERSION,
      tokenPolicyVersion: TOKEN_POLICY_VERSION,
      ownerFile: hint.ownerFile,
      exportedName: hint.name,
      identity: `${hint.ownerFile}::${hint.name}`,
    });
  }
}

function addFileLookup({ lookup, cardMap, suppressedCues }) {
  if (lookup.result !== 'FILE_EXISTS') return;
  const candidate = {
    identity: `${lookup.intentFile}::__file__`,
    ownerFile: lookup.intentFile,
    exportedName: '__file__',
  };
  addCue(cardMap, suppressedCues, candidate, safeCue({
    lane: 'exact-file',
    claim: 'exact file exists',
    evidence: [{
      artifact: 'topology.json',
      matchedField: 'nodes',
      file: lookup.intentFile,
      algorithmVersion: 'exact-file.v1',
    }],
  }));
}

function addShapeLookup({ lookup, cardMap, suppressedCues, unavailableEvidence }) {
  if (lookup.result === 'UNAVAILABLE') {
    unavailableEvidence.push({
      evidenceLane: lookup.shapeHashSource === 'functionSignature' ? 'function-signature' : 'shape-hash',
      status: UNAVAILABLE_STATUS,
      reason: lookup.reason ?? lookup.unavailableReason ?? 'lookup-unavailable',
      artifact: lookup.artifact ?? (
        lookup.shapeHashSource === 'functionSignature' ? 'function-clones.json' : 'shape-index.json'
      ),
      citations: lookup.citations ?? [],
    });
    return;
  }
  if (lookup.result !== 'SHAPE_MATCH' && lookup.result !== 'SIGNATURE_MATCH') return;
  const lane = lookup.result === 'SIGNATURE_MATCH' ? 'function-signature' : 'shape-hash';
  const claim = lookup.result === 'SIGNATURE_MATCH'
    ? 'same normalized function signature'
    : 'same normalized type shape';
  const artifact = lookup.result === 'SIGNATURE_MATCH' ? 'function-clones.json' : 'shape-index.json';
  for (const match of lookup.matches ?? []) {
    addCue(cardMap, suppressedCues, match, safeCue({
      lane,
      claim,
      evidence: [{
        artifact,
        matchedField: lookup.result === 'SIGNATURE_MATCH' ? 'normalizedSignatureHash' : 'hash',
        algorithmVersion: lookup.result === 'SIGNATURE_MATCH'
          ? 'function-signature.normalized.v1'
          : 'shape-hash.normalized.v1',
        hash: lookup.shapeHash,
      }],
    }));
  }
}

export function classifyPreWriteCues({ lookups = [], intent = {} } = {}) {
  const cardMap = new Map();
  const suppressedCues = [];
  const unavailableEvidence = [];

  for (const lookup of lookups) {
    if (lookup.kind === 'name') addNameLookup({ lookup, cardMap, suppressedCues });
    else if (lookup.kind === 'file') addFileLookup({ lookup, cardMap, suppressedCues });
    else if (lookup.kind === 'shape') addShapeLookup({ lookup, cardMap, suppressedCues, unavailableEvidence });
  }

  return {
    cuePolicy: tokenPolicyMetadata(),
    cueCards: sortCards([...cardMap.values()]),
    suppressedCues: sortSuppressed(suppressedCues),
    unavailableEvidence: unavailableEvidence.sort((a, b) =>
      String(a.evidenceLane ?? '').localeCompare(String(b.evidenceLane ?? '')) ||
      String(a.reason ?? '').localeCompare(String(b.reason ?? ''))
    ),
    intentNameCount: Array.isArray(intent.names) ? intent.names.length : 0,
  };
}
