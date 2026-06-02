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

function serviceOperationCandidate(entry = {}) {
  const identity = entry.identity ?? `${entry.ownerFile ?? 'unknown'}::${entry.name ?? 'unknown'}`;
  return candidateFromIdentity(identity, {
    ownerFile: entry.ownerFile,
    exportedName: entry.name,
    policyExcluded: entry.policyExcluded,
    policyReason: entry.policyReason,
  });
}

function serviceOperationEvidence(policy = {}, entry = {}) {
  return {
    artifact: 'pre-write-advisory.json',
    matchedField: 'lookups[].serviceOperationSiblingPolicy.promoted',
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    candidateIdentity: entry.identity,
    operationFamily: entry.operationFamily,
    sharedDomainTokens: entry.sharedDomainTokens ?? [],
    locality: entry.locality,
    supportingReasons: entry.supportingReasons ?? [],
  };
}

function localOperationCandidate(entry = {}) {
  const identity = entry.identity ?? `${entry.ownerFile ?? 'unknown'}::${entry.containerName ?? 'unknown'}#${entry.name ?? 'unknown'}`;
  return candidateFromIdentity(identity, {
    ownerFile: entry.ownerFile,
    exportedName: entry.name,
    policyExcluded: entry.policyExcluded,
    policyReason: entry.policyReason,
  });
}

function localOperationEvidence(policy = {}, entry = {}) {
  return {
    artifact: 'pre-write-advisory.json',
    matchedField: 'lookups[].localOperationSiblingPolicy.promoted',
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    candidateIdentity: entry.identity,
    matchedFieldSource: entry.matchedField ?? 'preWriteLocalOperationIndex',
    surfaceKind: entry.surfaceKind ?? 'nested-local-operation',
    containerName: entry.containerName,
    containerKind: entry.containerKind,
    operationFamily: entry.operationFamily,
    sharedDomainTokens: entry.sharedDomainTokens ?? [],
    locality: entry.locality,
    supportingReasons: entry.supportingReasons ?? [],
  };
}

function addServiceOperationMutedCue(suppressedCues, policy = {}, entry = {}, reason = undefined) {
  const candidate = serviceOperationCandidate(entry);
  suppressedCues.push({
    cueTier: CUE_TIERS.MUTED,
    evidenceLane: 'service-operation-sibling',
    reason: reason ?? entry.reason ?? 'service-sibling-muted',
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    ownerFile: candidate.ownerFile,
    exportedName: candidate.exportedName,
    identity: candidate.identity,
    matchedField: entry.matchedField ?? 'defIndex',
    operationFamily: entry.operationFamily,
    sharedDomainTokens: entry.sharedDomainTokens ?? [],
    supportingReasons: entry.supportingReasons ?? [],
    locality: entry.locality,
  });
}

function addServiceOperationSiblingPolicy({ lookup, cardMap, suppressedCues }) {
  const policy = lookup.serviceOperationSiblingPolicy;
  if (!policy || typeof policy !== 'object') return;

  for (const entry of policy.promoted ?? []) {
    if (entry?.matchedField === 'classMethodIndex') {
      addServiceOperationMutedCue(suppressedCues, policy, entry, 'service-sibling-class-method-lane');
      continue;
    }
    addCue(cardMap, suppressedCues, serviceOperationCandidate(entry), reviewCue({
      lane: 'service-operation-sibling',
      claim: 'related service operation sibling',
      evidence: [serviceOperationEvidence(policy, entry)],
    }));
  }

  for (const entry of policy.muted ?? []) {
    addServiceOperationMutedCue(suppressedCues, policy, entry);
  }
}

function addLocalOperationMutedCue(suppressedCues, policy = {}, entry = {}, reason = undefined) {
  const candidate = localOperationCandidate(entry);
  suppressedCues.push({
    cueTier: CUE_TIERS.MUTED,
    evidenceLane: 'local-operation-sibling',
    reason: reason ?? entry.reason ?? 'local-operation-muted',
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    ownerFile: candidate.ownerFile,
    exportedName: candidate.exportedName,
    identity: candidate.identity,
    matchedField: entry.matchedField ?? 'preWriteLocalOperationIndex',
    surfaceKind: entry.surfaceKind ?? 'nested-local-operation',
    containerName: entry.containerName,
    containerKind: entry.containerKind,
    operationFamily: entry.operationFamily,
    sharedDomainTokens: entry.sharedDomainTokens ?? [],
    supportingReasons: entry.supportingReasons ?? [],
    locality: entry.locality,
  });
}

function addLocalOperationSiblingPolicy({ lookup, cardMap, suppressedCues }) {
  const policy = lookup.localOperationSiblingPolicy;
  if (!policy || typeof policy !== 'object') return;

  for (const entry of policy.promoted ?? []) {
    addCue(cardMap, suppressedCues, localOperationCandidate(entry), reviewCue({
      lane: 'local-operation-sibling',
      claim: 'related local service operation',
      evidence: [localOperationEvidence(policy, entry)],
    }));
  }

  for (const entry of policy.muted ?? []) {
    addLocalOperationMutedCue(suppressedCues, policy, entry);
  }
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
    const identity = near.identity ?? `${near.ownerFile}::${near.name}`;
    const isClassMethod = near.matchedField === 'classMethodIndex';
    addCue(cardMap, suppressedCues, candidateFromIdentity(identity, near), reviewCue({
      lane: isClassMethod ? 'class-method-name' : 'near-name',
      claim: isClassMethod ? 'near class method name' : 'near exported name',
      evidence: [{
        artifact: 'symbols.json',
        matchedField: near.matchedField ?? 'defIndex',
        algorithmVersion: 'near-name.v1',
        distance: near.distance,
        ...(near.identity ? { candidateIdentity: near.identity } : {}),
      }],
    }));
  }

  for (const hint of lookup.semanticHints ?? []) {
    const identity = hint.identity ?? `${hint.ownerFile}::${hint.name}`;
    const isClassMethod = hint.matchedField === 'classMethodIndex';
    addCue(cardMap, suppressedCues, candidateFromIdentity(identity, hint), reviewCue({
      lane: isClassMethod ? 'class-method-name' : 'intent-token',
      claim: isClassMethod ? 'class method intent-token overlap' : 'supported intent-token overlap',
      evidence: [{
        artifact: 'symbols.json',
        matchedField: hint.matchedField ?? 'defIndex',
        algorithmVersion: TOKEN_POLICY_VERSION,
        tokens: hint.matchedTokens ?? [],
        ...(hint.identity ? { candidateIdentity: hint.identity } : {}),
      }],
    }));
  }

  for (const near of lookup.suppressedNearNames ?? []) {
    suppressedCues.push({
      cueTier: CUE_TIERS.MUTED,
      evidenceLane: 'near-name',
      reason: near.reason ?? 'near-name-suppressed',
      tokens: near.matchedTokens ?? [],
      distance: near.distance,
      lengthDelta: near.lengthDelta,
      locality: near.locality,
      candidateCount: near.candidateCount ?? 1,
      tokenizerVersion: TOKENIZER_VERSION,
      tokenPolicyVersion: TOKEN_POLICY_VERSION,
      ownerFile: near.ownerFile,
      exportedName: near.name,
      identity: near.identity ?? `${near.ownerFile}::${near.name}`,
      matchedField: near.matchedField ?? 'defIndex',
    });
  }

  for (const hint of lookup.suppressedSemanticHints ?? []) {
    suppressedCues.push({
      cueTier: CUE_TIERS.MUTED,
      evidenceLane: 'intent-token',
      reason: hint.reason ?? 'domain-token-overlap',
      tokens: hint.matchedTokens ?? [],
      score: hint.score,
      locality: hint.locality,
      candidateCount: hint.candidateCount ?? 1,
      tokenizerVersion: TOKENIZER_VERSION,
      tokenPolicyVersion: TOKEN_POLICY_VERSION,
      ownerFile: hint.ownerFile,
      exportedName: hint.name,
      identity: hint.identity ?? `${hint.ownerFile}::${hint.name}`,
      matchedField: hint.matchedField ?? 'defIndex',
    });
  }

  addServiceOperationSiblingPolicy({ lookup, cardMap, suppressedCues });
  addLocalOperationSiblingPolicy({ lookup, cardMap, suppressedCues });
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
    const evidence = [{
        artifact,
        matchedField: lookup.result === 'SIGNATURE_MATCH' ? 'normalizedSignatureHash' : 'hash',
        algorithmVersion: lookup.result === 'SIGNATURE_MATCH'
          ? 'function-signature.normalized.v1'
          : 'shape-hash.normalized.v1',
        hash: lookup.shapeHash,
        ...(lookup.result === 'SIGNATURE_MATCH' && match.visibility
          ? { visibility: match.visibility }
          : {}),
        ...(lookup.result === 'SIGNATURE_MATCH' && match.localName
          ? { localName: match.localName }
          : {}),
      }];
    if (lookup.result === 'SIGNATURE_MATCH' && match.visibility && match.visibility !== 'exported') {
      addCue(cardMap, suppressedCues, match, reviewCue({
        lane,
        claim,
        evidence,
      }));
      continue;
    }
    addCue(cardMap, suppressedCues, match, safeCue({
      lane,
      claim,
      evidence,
    }));
  }
}

function addInlinePatternLookup({ lookup, cardMap, suppressedCues, unavailableEvidence }) {
  if (lookup.result === 'UNAVAILABLE') {
    unavailableEvidence.push({
      evidenceLane: 'inline-extraction',
      status: UNAVAILABLE_STATUS,
      reason: lookup.reason ?? 'lookup-unavailable',
      artifact: lookup.artifact ?? 'inline-patterns.json',
      citations: lookup.citations ?? [],
    });
    return;
  }
  if (lookup.result !== 'INLINE_PATTERN_MATCH') return;

  for (const group of lookup.groups ?? []) {
    const ownerFile = group.ownerFiles?.[0] ?? group.occurrences?.[0]?.file ?? 'unknown';
    const candidate = {
      identity: `inline-pattern:${group.patternHash}`,
      ownerFile,
      exportedName: group.kind ?? 'inline-pattern',
      policyExcluded: group.policyExcluded,
      policyReason: group.policyReason,
    };
    addCue(cardMap, suppressedCues, candidate, reviewCue({
      lane: 'inline-extraction',
      claim: 'repeated inline statement pattern',
      evidence: [{
        artifact: 'inline-patterns.json',
        matchedField: 'groups[].patternHash',
        algorithmVersion: group.normalizerVersion ?? 'inline-statement-normalizer-v1',
        patternHash: group.patternHash,
        occurrenceCount: group.size ?? group.occurrences?.length ?? 0,
        ownerFiles: group.ownerFiles ?? [],
        reviewReason: group.reviewReason,
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
    else if (lookup.kind === 'inline-pattern') addInlinePatternLookup({ lookup, cardMap, suppressedCues, unavailableEvidence });
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
