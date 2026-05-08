import { BLOCKING_TAINTS, SOFT_TAINTS, TAINT } from './vocab.mjs';
import {
  GENERATED_ARTIFACT_MISSING_HINT,
  GENERATED_ARTIFACT_MISSING_REASON,
} from './generated-artifact-evidence.mjs';

// 4-tier finding classification.
//
// Upstream this module consumes dead-classify.json + optional
// runtime-evidence.json + staleness.json, and produces a single tier
// per finding. Consumers (rank-fixes.mjs, emit-sarif.mjs) agree on
// one predicate so CI severity matches the fix-plan ranking.
//
// Tiers:
//   SAFE_FIX    — proof-carrying cleanup under the recorded scan range:
//                 clean deadness + clean local provenance + a concrete
//                 safeAction whose selected-action blockers are empty.
//                 Runtime/staleness can strengthen the reason, but are
//                 not required. SARIF warning.
//   REVIEW_FIX  — Classifier proposes concrete action (C/A/B/specifier)
//                 but static-safe gates did not pass. Covers B-bucket
//                 predicate/design judgment and soft taint. SARIF note.
//   DEGRADED    — evidence contradicts or is globally insufficient:
//                 runtime-executed (overrides everything), resolver
//                 unresolvedRatio ≥ 15%, or an unclassified bucket.
//                 Reserved for cases where warning would mislead.
//                 SARIF note.
//   MUTED       — classifier-excluded by an FP policy (config file,
//                 framework sentinel, public API, generated).
//                 Materialized from dead-classify.excludedCandidates
//                 (v1.9.6) so users can audit what policy hid.
//                 Not emitted to SARIF.

export const TIERS = ['SAFE_FIX', 'REVIEW_FIX', 'DEGRADED', 'MUTED'];

export const TIER_TO_SARIF_LEVEL = {
  SAFE_FIX: 'warning',
  REVIEW_FIX: 'note',
  DEGRADED: 'note',
  MUTED: null, // not emitted
};

function softTaintReasonLabels(taints) {
  const labels = [];
  for (const t of taints ?? []) {
    if (t?.kind === TAINT.PARSE_ERRORS_ELSEWHERE) {
      labels.push('parse-errors-elsewhere');
    } else if (t?.kind === TAINT.UNRESOLVED_SPEC_MATCH_UNKNOWN) {
      labels.push(TAINT.UNRESOLVED_SPEC_MATCH_UNKNOWN);
    } else if (t?.kind === TAINT.RESOLVER_BLIND_ZONE_RELEVANT) {
      labels.push('resolver-blind-zone');
    } else if (t?.kind === TAINT.GENERATED_ARTIFACT_MISSING_RELEVANT) {
      labels.push(GENERATED_ARTIFACT_MISSING_HINT);
    }
  }
  return [...new Set(labels)];
}

function generatedArtifactBlockingDiagnostics(taints) {
  return (taints ?? [])
    .filter((t) => t?.kind === TAINT.GENERATED_ARTIFACT_MISSING_RELEVANT)
    .map((t) => ({
      reason: t.reason ?? GENERATED_ARTIFACT_MISSING_REASON,
      kind: t.kind,
      specifier: t.specifier,
      specifiers: t.specifiers,
      total: t.total,
      consumerFile: t.consumerFile,
      fromHint: t.fromHint,
      matchedPackage: t.matchedPackage,
      targetSubpath: t.targetSubpath,
      generatorFamily: t.generatorFamily,
      confidence: t.confidence,
      candidatePath: t.candidatePath,
      status: t.status,
      scopePackageRoot: t.scopePackageRoot,
      scanScopeReason: t.scanScopeReason,
      staleStatus: t.staleStatus,
      staleReason: t.staleReason,
      impact: t.impact,
      relevance: t.relevance,
      effect: t.effect,
    }));
}

function resolverBlindZoneBlockingDiagnostics(taints) {
  return (taints ?? [])
    .filter((t) => t?.kind === TAINT.RESOLVER_BLIND_ZONE_RELEVANT)
    .map((t) => ({
      reason: t.reason,
      kind: t.kind,
      family: t.family,
      specifier: t.specifier,
      specifiers: t.specifiers,
      total: t.total,
      consumerFile: t.consumerFile,
      fromHint: t.fromHint,
      targetCandidates: t.targetCandidates,
      affectedPackageScope: t.affectedPackageScope,
      resolverStage: t.resolverStage,
      outputLevel: t.outputLevel,
      impact: t.impact,
      relevance: t.relevance,
      effect: t.effect,
    }));
}

function policyExclusionResult(policy) {
  if (!policy?.excluded) return null;
  return { tier: 'MUTED', reason: `policy-excluded: ${policy.reason ?? 'unknown'}` };
}

function runtimeContradictionResult(runtime) {
  if (runtime?.status !== 'executed') return null;
  return { tier: 'DEGRADED', reason: `runtime-executed (${runtime.hitsInSymbol ?? 0} hits)` };
}

function taintState(finding) {
  const perFindingTaint = Array.isArray(finding.taintedBy) ? finding.taintedBy : null;
  return {
    perFindingTaint,
    hasBlockingTaint: perFindingTaint?.some((t) => BLOCKING_TAINTS.has(t.kind)) ?? false,
    hasSoftTaint: perFindingTaint?.some((t) => SOFT_TAINTS.has(t.kind)) ?? false,
  };
}

function blockingTaintResult({ perFindingTaint, hasBlockingTaint }) {
  if (!hasBlockingTaint) return null;
  const blocker = perFindingTaint.find((t) => BLOCKING_TAINTS.has(t.kind));
  if (blocker.kind === TAINT.UNRESOLVED_SPEC_MATCH) {
    const spec = (blocker.specifiers?.[0]) ?? '<specifier>';
    return {
      tier: 'DEGRADED',
      reason: `unresolved-spec-could-match: ${spec} (${blocker.total} match${blocker.total === 1 ? '' : 'es'})`,
    };
  }
  return {
    tier: 'DEGRADED',
    reason: `defining-file-parse-error: ${blocker.file}`,
  };
}

function legacyResolverBlindnessResult({ perFindingTaint }, resolver) {
  if (perFindingTaint !== null ||
      resolver?.unresolvedRatio === undefined ||
      resolver.unresolvedRatio < 0.15) {
    return null;
  }
  return {
    tier: 'DEGRADED',
    reason: `resolver-blind (unresolvedRatio=${resolver.unresolvedRatio.toFixed(3)}, no per-finding taint)`,
  };
}

function weakRuntimeStatus(runtime) {
  return runtime?.status === 'uncovered' ||
         runtime?.status === 'type-only';
}

function incompleteBucketResult(finding) {
  if (finding.bucket !== 'unprocessed') return null;
  return {
    tier: 'DEGRADED',
    reason: `classify-incomplete: ${finding.action ?? 'candidate was not fully classified'}`,
  };
}

function safeActionState(finding) {
  const actionBlockers = Array.isArray(finding.safeAction?.actionBlockers)
    ? finding.safeAction.actionBlockers
    : (Array.isArray(finding.actionBlockers) ? finding.actionBlockers : []);
  const safeActionKind = finding.safeAction?.kind;
  const preservesDeclarationBinding =
    safeActionKind === 'demote_export_declaration' ||
    safeActionKind === 'remove_export_specifier';
  const declarationDependencyBindingPreserved =
    finding.declarationExportDependency && preservesDeclarationBinding;
  return {
    actionBlockers,
    hasSafeAction: !!finding.safeAction?.kind &&
                   finding.safeAction.proofComplete === true &&
                   actionBlockers.length === 0,
    safeActionKind,
    preservesDeclarationBinding,
    declarationDependencyBindingPreserved,
    isResolvableDeclarationDependencyBucket:
      finding.bucket === 'B' && declarationDependencyBindingPreserved,
  };
}

function missingSafeActionResult({ actionBlockers, hasSafeAction }) {
  if (hasSafeAction) return null;
  if (actionBlockers.length > 0) {
    return {
      tier: 'REVIEW_FIX',
      reason: `action-blockers: ${actionBlockers.join(', ')}`,
    };
  }
  return { tier: 'REVIEW_FIX', reason: 'missing-safe-action-proof' };
}

function declarationDependencyResult(finding, { preservesDeclarationBinding }) {
  if (!finding.declarationExportDependency || preservesDeclarationBinding) return null;
  const count = finding.declarationExportRefs?.count ?? 0;
  return {
    tier: 'REVIEW_FIX',
    reason: `declaration-dependency-not-preserved (${count} ref${count === 1 ? '' : 's'})`,
  };
}

function bucketBResult(finding, { isResolvableDeclarationDependencyBucket }) {
  if (finding.bucket !== 'B' || isResolvableDeclarationDependencyBucket) return null;
  return { tier: 'REVIEW_FIX', reason: 'bucket-B (design review required)' };
}

function supportState(finding, runtime) {
  const supportedBy = Array.isArray(finding.supportedBy) ? finding.supportedBy : [];
  return {
    strongRuntime: runtime?.status === 'dead-confirmed' &&
                   runtime?.grounding === 'grounded',
    hasEntryReachSupport: supportedBy.some((s) => s?.kind === 'entry-unreachable'),
    hasIndependentSupport: supportedBy.some((s) => s?.kind === 'call-graph-no-observed-callers'),
  };
}

function htmlEntrypointBlindZoneResult(entrySurface) {
  if (!entrySurface?.htmlEntrypointBlindZone) return null;
  return {
    tier: 'REVIEW_FIX',
    reason: 'html-entry-surface-blind-zone',
    blockedPromotion: true,
    blockedBy: [entrySurface.htmlEntrypointBlindZone],
  };
}

function publicDeepImportRiskResult(contract) {
  if (!contract?.publicDeepImportRisk) return null;
  const detailReason = contract.publicDeepImportRiskDetail?.reason;
  return {
    tier: 'REVIEW_FIX',
    reason: detailReason
      ? `public-deep-import-risk: ${detailReason}`
      : 'public-deep-import-risk',
  };
}

function safeFixResult(finding, { runtime, staleness }, support) {
  const bits = ['safe-action', 'static-graph-clean', `bucket-${finding.bucket}`];
  const hasSingleLensEvidence = support.hasEntryReachSupport || support.hasIndependentSupport;
  const hasTwoLensEvidence = support.hasEntryReachSupport && support.hasIndependentSupport;
  if (support.hasEntryReachSupport) bits.push('entry-unreachable');
  if (support.hasIndependentSupport) bits.push('no-observed-callers');
  if (support.strongRuntime) bits.push('runtime-dead-confirmed');
  else if (runtime?.status) bits.push(`runtime-${runtime.status}`);
  else bits.push('no-runtime');
  if (staleness?.tier) bits.push(`staleness-${staleness.tier}`);
  else bits.push('no-staleness');
  return {
    tier: 'SAFE_FIX',
    reason: bits.join(' + '),
    confidence: hasTwoLensEvidence ? 'high' : 'medium',
    ...(hasTwoLensEvidence
        ? { confidenceDetail: 'high_two_lens_evidence' }
        : hasSingleLensEvidence
          ? { confidenceDetail: 'medium_with_evidence' }
          : {}),
  };
}

function weakerEvidenceReviewResult(finding, runtime, taints, safeAction, hasWeakRuntimeStatus) {
  if (!(['C', 'A', 'specifier'].includes(finding.bucket) ||
        safeAction.isResolvableDeclarationDependencyBucket)) {
    return null;
  }
  const missing = [];
  if (taints.hasSoftTaint) missing.push(...softTaintReasonLabels(taints.perFindingTaint));
  if (hasWeakRuntimeStatus) missing.push(`runtime=${runtime.status}`);
  const generatedBlocks = generatedArtifactBlockingDiagnostics(taints.perFindingTaint);
  const resolverBlocks = resolverBlindZoneBlockingDiagnostics(taints.perFindingTaint);
  const blockedBy = [...generatedBlocks, ...resolverBlocks];
  return {
    tier: 'REVIEW_FIX',
    reason: `safe-action; missing: ${missing.join(', ') || 'none'}`,
    ...(blockedBy.length > 0
      ? { blockedPromotion: true, blockedBy }
      : {}),
  };
}

/**
 * Classify a single finding given its accumulated evidence.
 *
 * @param {object} finding    {file, line, symbol, kind, bucket, action,
 *                            fileInternalUses?, predicatePartner?,
 *                            taintedBy?, supportedBy?, resolverConfidence?,
 *                            safeAction?}
 * @param {object} evidence   {runtime?: {status, grounding, confidence,
 *                            hitsInSymbol}, staleness?: {tier,
 *                            grounding, lineLastTouchedDaysAgo}, contract?:
 *                            {publicDeepImportRisk}, entrySurface?:
 *                            {htmlEntrypointBlindZone}, policy?: {excluded,
 *                            reason}, resolver?: {unresolvedRatio}}
 * @returns {{tier: string, reason: string}}
 */
export function tierForFinding(finding, evidence = {}) {
  const { runtime, staleness, contract, entrySurface, policy, resolver } = evidence;

  // ─── MUTED: explicit policy exclusion ────────────────────
  // Classifier already dropped these into the `excluded.*` counters
  // (FP-22 config, FP-23 public API, FP-27 framework, FP-30 nuxt).
  // If a caller hands us a finding flagged this way, surface it as
  // MUTED rather than silently dropping — aids diagnosis.
  const policyResult = policyExclusionResult(policy);
  if (policyResult) return policyResult;

  // ─── DEGRADED: runtime contradicts AST ────────────────────
  // If the symbol was executed at runtime but AST says dead, the
  // AST missed something (typically dynamic dispatch). Never warn.
  const runtimeResult = runtimeContradictionResult(runtime);
  if (runtimeResult) return runtimeResult;

  // ─── v1.10.0 P1: finding-local taint ──────────────────────
  // Per-finding provenance from classify-dead-exports. A finding is
  // blocking-tainted when an unresolved specifier's path shape
  // suggests it could resolve to THIS symbol's file, or when the
  // defining file itself failed to parse. Only findings in the
  // affected part of the repo are demoted — unaffected findings
  // keep their tier even in repos with high global unresolved ratio.
  const taints = taintState(finding);
  const blockingResult = blockingTaintResult(taints);
  if (blockingResult) return blockingResult;

  // ─── DEGRADED fallback: repo-global resolver blindness ────
  // Only used when per-finding taint data is absent (legacy artifacts
  // from symbols.json < v1.10.0 that don't populate `taintedBy`). With
  // provenance present, individual findings are judged on their own
  // match evidence instead of a blanket repo-wide gate.
  const resolverBlindnessResult = legacyResolverBlindnessResult(taints, resolver);
  if (resolverBlindnessResult) return resolverBlindnessResult;

  // ─── REVIEW_FIX: runtime evidence is present but non-proving ─
  // Missing runtime evidence is normal for a static cleanup tool and
  // must not by itself block SAFE_FIX. However, when runtime evidence
  // is present and explicitly says the symbol's range was uncovered or
  // erased from runtime, that artifact is telling us it cannot support
  // the cleanup. Keep those candidates visible but review-gated.
  const hasWeakRuntimeStatus = weakRuntimeStatus(runtime);

  const incompleteResult = incompleteBucketResult(finding);
  if (incompleteResult) return incompleteResult;

  // ─── SAFE_FIX gate: proof-carrying safe action ───────────
  // PCEF P1: deadness proof and edit-action safety are separate.
  // Bucket C/A/specifier says "no external consumer in the constructed
  // graph"; it does not prove that deleting or demoting the declaration
  // is safe. export-action-safety.mjs provides that proof.
  const safeAction = safeActionState(finding);
  const missingActionResult = missingSafeActionResult(safeAction);
  if (missingActionResult) return missingActionResult;

  // ─── REVIEW_FIX: exported declaration dependency ─────────
  // Declaration dependencies block destructive edits, not weaker
  // export-edge edits. A demotion preserves the local TS binding used
  // by exported declarations while removing only the external export
  // edge. Delete-like actions still need review because declaration
  // emit/type surface could change.
  const declarationResult = declarationDependencyResult(finding, safeAction);
  if (declarationResult) return declarationResult;

  // ─── REVIEW_FIX: B bucket (predicate partner / design judgment) ──
  // Most B-bucket findings are design-review evidence. The narrow
  // exception is a local type declaration dependency with a
  // binding-preserving safeAction produced by export-action-safety.
  const bucketBReview = bucketBResult(finding, safeAction);
  if (bucketBReview) return bucketBReview;

  const support = supportState(finding, runtime);

  // ─── REVIEW_FIX: unresolved HTML entry surface ───────────
  // Absolute HTML module URLs such as `/assets/app.js` can be served from
  // arbitrary static roots (`public/`, framework output dirs, custom
  // server code). If the HTML target cannot be mapped to a concrete repo
  // file, candidates that look like that target stay review-gated instead
  // of becoming SAFE_FIX on an overconfident reachability model.
  const htmlResult = htmlEntrypointBlindZoneResult(entrySurface);
  if (htmlResult) return htmlResult;

  // ─── REVIEW_FIX: externally observable deep-import contract ─
  // PCEF contract proof: in publishable packages without an exports
  // map that closes internals, external consumers can deep-import a
  // file even when the constructed repo graph has no local consumer.
  // Demotion preserves local runtime behavior but still removes that
  // export contract, so keep the action review-visible.
  const publicContractResult = publicDeepImportRiskResult(contract);
  if (publicContractResult) return publicContractResult;

  if (!taints.hasSoftTaint && !hasWeakRuntimeStatus) {
    return safeFixResult(finding, { runtime, staleness }, support);
  }

  // ─── REVIEW_FIX: clear action, weaker supporting evidence ─
  // Classifier still produced a safe action, but soft taint or
  // design judgment prevents static-safe ranking.
  const reviewResult = weakerEvidenceReviewResult(
    finding,
    runtime,
    taints,
    safeAction,
    hasWeakRuntimeStatus,
  );
  if (reviewResult) return reviewResult;

  // ─── DEGRADED fallback ────────────────────────────────────
  return { tier: 'DEGRADED', reason: `unclassified bucket=${finding.bucket}` };
}

/**
 * Build per-tier summary + tier-keyed lists.
 * @param {Array<{finding, evidence, tier, reason}>} scored
 */
export function summarize(scored) {
  const summary = { SAFE_FIX: 0, REVIEW_FIX: 0, DEGRADED: 0, MUTED: 0, total: scored.length };
  const byTier = { SAFE_FIX: [], REVIEW_FIX: [], DEGRADED: [], MUTED: [] };
  const publicDeepImportRiskReasons = new Map();
  for (const s of scored) {
    summary[s.tier]++;
    byTier[s.tier].push(s);
    if (s.tier === 'REVIEW_FIX' && s.evidence?.contract?.publicDeepImportRisk) {
      const reason = s.evidence.contract.publicDeepImportRiskDetail?.reason ?? 'unknown';
      publicDeepImportRiskReasons.set(reason, (publicDeepImportRiskReasons.get(reason) ?? 0) + 1);
    }
  }
  if (publicDeepImportRiskReasons.size > 0) {
    summary.reviewReasons = {
      publicDeepImportRisk: Object.fromEntries(
        Array.from(publicDeepImportRiskReasons.entries())
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
  }
  return { summary, byTier };
}
