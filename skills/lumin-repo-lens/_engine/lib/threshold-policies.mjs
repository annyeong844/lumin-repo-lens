// Versioned threshold policy metadata.
//
// Numeric thresholds are allowed, but they should not be invisible magic
// numbers. This module centralizes the first policy slice for user-visible
// review, confidence, and pruning thresholds.

import { createHash } from 'node:crypto';

import { calibrationCorpusSummary } from './calibration-corpora.mjs';

export const THRESHOLD_POLICY_SCHEMA_VERSION = 'threshold-policy.v1';

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'policyHash')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stableObject(child)]));
  }
  return value;
}

function policyHash(policy) {
  const canonical = JSON.stringify(stableObject(policy));
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

function thresholdHash(thresholds) {
  const canonical = JSON.stringify(stableObject(thresholds));
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

function withHash(policy) {
  const policyWithThresholdHash = {
    ...policy,
    thresholdHash: thresholdHash(policy.thresholds),
  };
  return Object.freeze({
    ...policyWithThresholdHash,
    policyHash: policyHash(policyWithThresholdHash),
  });
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export const THRESHOLD_POLICIES = Object.freeze({
  'function-clone-near-policy': withHash({
    schemaVersion: THRESHOLD_POLICY_SCHEMA_VERSION,
    policyId: 'function-clone-near-policy',
    policyVersion: 'function-clone-near-policy-v1',
    policyClass: 'review',
    thresholds: {
      minBodyLocForGrouping: 3,
      minStatementsForGrouping: 2,
      minGroupSize: 2,
      maxParamCountDelta: 1,
      minBodyLocSimilarity: 0.34,
      minStatementCountSimilarity: 0.34,
      minCallTokenJaccard: 0.5,
      minNameTokenJaccardFallback: 0.34,
      minNearScore: 0.62,
      maxNearCandidates: 50,
      weights: {
        callTokenJaccard: 0.45,
        nameTokenJaccard: 0.25,
        bodyLocSimilarity: 0.15,
        statementCountSimilarity: 0.15,
      },
    },
    calibration: {
      corpus: 'calibration-2026-05-prewrite-v1',
      note: 'agent-entry resolver calibration threshold contract',
    },
    notes: [
      'Near-function candidates are review-only cues.',
      'Scores do not prove semantic equivalence or automatic merge safety.',
    ],
  }),

  'inline-pattern-policy': withHash({
    schemaVersion: THRESHOLD_POLICY_SCHEMA_VERSION,
    policyId: 'inline-pattern-policy',
    policyVersion: 'inline-pattern-policy-v1',
    policyClass: 'review',
    thresholds: {
      minOccurrences: 3,
      maxCatchStatements: 2,
    },
    calibration: {
      corpus: 'calibration-2026-05-prewrite-v1',
      note: 'pre-write inline extraction cues spec',
    },
    notes: [
      'Inline pattern groups are extraction review cues.',
      'Repeated syntax does not prove semantic equivalence.',
    ],
  }),

  'resolver-blind-zone-policy': withHash({
    schemaVersion: THRESHOLD_POLICY_SCHEMA_VERSION,
    policyId: 'resolver-blind-zone-policy',
    policyVersion: 'resolver-blind-zone-policy-v1',
    policyClass: 'confidence',
    thresholds: {
      unresolvedRatio: 0.15,
      absoluteUnresolvedCount: 1000,
      prefixConcentrationMinUnresolved: 100,
      prefixConcentrationMinCount: 100,
      prefixConcentrationShare: 0.8,
      shapeUnknownFileShare: 0.1,
    },
    calibration: {
      corpus: 'calibration-2026-05-resolver-v1',
      note: 'agent-entry resolver completeness contract',
    },
    notes: [
      'Resolver confidence gaps limit absence claims.',
      'The policy should not become a repo-global blocker when relevance can be scoped.',
    ],
  }),
});

export function getThresholdPolicy(policyId) {
  const policy = THRESHOLD_POLICIES[policyId];
  if (!policy) {
    throw new Error(`Unknown threshold policy: ${policyId}`);
  }
  return clone(policy);
}

export function thresholdPolicySummary(policyIds) {
  return [...policyIds].map((policyId) => {
    const policy = getThresholdPolicy(policyId);
    const calibrationCorpus = policy.calibration?.corpus
      ? calibrationCorpusSummary([policy.calibration.corpus])[0]
      : undefined;
    return {
      schemaVersion: policy.schemaVersion,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      policyClass: policy.policyClass,
      policyHash: policy.policyHash,
      thresholdHash: policy.thresholdHash,
      thresholds: policy.thresholds,
      calibration: policy.calibration,
      ...(calibrationCorpus ? { calibrationCorpus } : {}),
    };
  });
}

export function thresholdPolicyDriftSnapshot(policyIds) {
  return [...policyIds].map((policyId) => {
    const policy = getThresholdPolicy(policyId);
    return {
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      policyClass: policy.policyClass,
      thresholdHash: policy.thresholdHash,
      calibrationCorpus: policy.calibration?.corpus ?? null,
      calibrationNote: policy.calibration?.note ?? null,
    };
  });
}
