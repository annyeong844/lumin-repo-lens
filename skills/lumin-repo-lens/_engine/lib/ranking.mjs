import { BLOCKING_TAINTS, SOFT_TAINTS, TAINT } from './vocab.mjs';

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
    }
  }
  return [...new Set(labels)];
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
 *                            {publicDeepImportRisk}, policy?: {excluded,
 *                            reason}, resolver?: {unresolvedRatio}}
 * @returns {{tier: string, reason: string}}
 */
export function tierForFinding(finding, evidence = {}) {
  const { runtime, staleness, contract, policy, resolver } = evidence;

  // ─── MUTED: explicit policy exclusion ────────────────────
  // Classifier already dropped these into the `excluded.*` counters
  // (FP-22 config, FP-23 public API, FP-27 framework, FP-30 nuxt).
  // If a caller hands us a finding flagged this way, surface it as
  // MUTED rather than silently dropping — aids diagnosis.
  if (policy?.excluded) {
    return { tier: 'MUTED', reason: `policy-excluded: ${policy.reason ?? 'unknown'}` };
  }

  // ─── DEGRADED: runtime contradicts AST ────────────────────
  // If the symbol was executed at runtime but AST says dead, the
  // AST missed something (typically dynamic dispatch). Never warn.
  if (runtime?.status === 'executed') {
    return { tier: 'DEGRADED', reason: `runtime-executed (${runtime.hitsInSymbol ?? 0} hits)` };
  }

  // ─── v1.10.0 P1: finding-local taint ──────────────────────
  // Per-finding provenance from classify-dead-exports. A finding is
  // blocking-tainted when an unresolved specifier's path shape
  // suggests it could resolve to THIS symbol's file, or when the
  // defining file itself failed to parse. Only findings in the
  // affected part of the repo are demoted — unaffected findings
  // keep their tier even in repos with high global unresolved ratio.
  const perFindingTaint = Array.isArray(finding.taintedBy) ? finding.taintedBy : null;
  const hasBlockingTaint = perFindingTaint && perFindingTaint.some((t) =>
    BLOCKING_TAINTS.has(t.kind));
  const hasSoftTaint = perFindingTaint && perFindingTaint.some((t) =>
    SOFT_TAINTS.has(t.kind));

  if (hasBlockingTaint) {
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

  // ─── DEGRADED fallback: repo-global resolver blindness ────
  // Only used when per-finding taint data is absent (legacy artifacts
  // from symbols.json < v1.10.0 that don't populate `taintedBy`). With
  // provenance present, individual findings are judged on their own
  // match evidence instead of a blanket repo-wide gate.
  if (perFindingTaint === null &&
      resolver?.unresolvedRatio !== undefined &&
      resolver.unresolvedRatio >= 0.15) {
    return {
      tier: 'DEGRADED',
      reason: `resolver-blind (unresolvedRatio=${resolver.unresolvedRatio.toFixed(3)}, no per-finding taint)`,
    };
  }

  // ─── REVIEW_FIX: runtime evidence is present but non-proving ─
  // Missing runtime evidence is normal for a static cleanup tool and
  // must not by itself block SAFE_FIX. However, when runtime evidence
  // is present and explicitly says the symbol's range was uncovered or
  // erased from runtime, that artifact is telling us it cannot support
  // the cleanup. Keep those candidates visible but review-gated.
  const weakRuntimeStatus = runtime?.status === 'uncovered' ||
                            runtime?.status === 'type-only';

  if (finding.bucket === 'unprocessed') {
    return {
      tier: 'DEGRADED',
      reason: `classify-incomplete: ${finding.action ?? 'candidate was not fully classified'}`,
    };
  }

  // ─── SAFE_FIX gate: proof-carrying safe action ───────────
  // PCEF P1: deadness proof and edit-action safety are separate.
  // Bucket C/A/specifier says "no external consumer in the constructed
  // graph"; it does not prove that deleting or demoting the declaration
  // is safe. export-action-safety.mjs provides that proof.
  const actionBlockers = Array.isArray(finding.safeAction?.actionBlockers)
    ? finding.safeAction.actionBlockers
    : (Array.isArray(finding.actionBlockers) ? finding.actionBlockers : []);
  const hasSafeAction = !!finding.safeAction?.kind &&
                        finding.safeAction.proofComplete === true &&
                        actionBlockers.length === 0;
  const safeActionKind = finding.safeAction?.kind;
  const preservesDeclarationBinding =
    safeActionKind === 'demote_export_declaration' ||
    safeActionKind === 'remove_export_specifier';
  const declarationDependencyBindingPreserved =
    finding.declarationExportDependency && preservesDeclarationBinding;

  if (!hasSafeAction) {
    if (actionBlockers.length > 0) {
      return {
        tier: 'REVIEW_FIX',
        reason: `action-blockers: ${actionBlockers.join(', ')}`,
      };
    }
    return { tier: 'REVIEW_FIX', reason: 'missing-safe-action-proof' };
  }

  // ─── REVIEW_FIX: exported declaration dependency ─────────
  // Declaration dependencies block destructive edits, not weaker
  // export-edge edits. A demotion preserves the local TS binding used
  // by exported declarations while removing only the external export
  // edge. Delete-like actions still need review because declaration
  // emit/type surface could change.
  if (finding.declarationExportDependency && !preservesDeclarationBinding) {
    const count = finding.declarationExportRefs?.count ?? 0;
    return {
      tier: 'REVIEW_FIX',
      reason: `declaration-dependency-not-preserved (${count} ref${count === 1 ? '' : 's'})`,
    };
  }

  const isResolvableDeclarationDependencyBucket =
    finding.bucket === 'B' && declarationDependencyBindingPreserved;

  // ─── REVIEW_FIX: B bucket (predicate partner / design judgment) ──
  // Most B-bucket findings are design-review evidence. The narrow
  // exception is a local type declaration dependency with a
  // binding-preserving safeAction produced by export-action-safety.
  if (finding.bucket === 'B' && !isResolvableDeclarationDependencyBucket) {
    return { tier: 'REVIEW_FIX', reason: 'bucket-B (design review required)' };
  }

  const strongRuntime = runtime?.status === 'dead-confirmed' &&
                        runtime?.grounding === 'grounded';
  const supportedBy = Array.isArray(finding.supportedBy) ? finding.supportedBy : [];
  const hasEntryReachSupport = supportedBy.some((s) => s?.kind === 'entry-unreachable');
  const hasIndependentSupport = supportedBy.some((s) => s?.kind === 'call-graph-no-observed-callers');

  // ─── REVIEW_FIX: externally observable deep-import contract ─
  // PCEF contract proof: in publishable packages without an exports
  // map that closes internals, external consumers can deep-import a
  // file even when the constructed repo graph has no local consumer.
  // Demotion preserves local runtime behavior but still removes that
  // export contract, so keep the action review-visible.
  if (contract?.publicDeepImportRisk) {
    return { tier: 'REVIEW_FIX', reason: 'public-deep-import-risk' };
  }

  if (!hasSoftTaint && !weakRuntimeStatus) {
    const bits = ['safe-action', 'static-graph-clean', `bucket-${finding.bucket}`];
    const hasSingleLensEvidence = hasEntryReachSupport || hasIndependentSupport;
    if (hasEntryReachSupport) bits.push('entry-unreachable');
    if (hasIndependentSupport) bits.push('no-observed-callers');
    if (strongRuntime) bits.push('runtime-dead-confirmed');
    else if (runtime?.status) bits.push(`runtime-${runtime.status}`);
    else bits.push('no-runtime');
    if (staleness?.tier) bits.push(`staleness-${staleness.tier}`);
    else bits.push('no-staleness');
    return {
      tier: 'SAFE_FIX',
      reason: bits.join(' + '),
      confidence: 'medium',
      ...(hasSingleLensEvidence ? { confidenceDetail: 'medium_with_evidence' } : {}),
    };
  }

  // ─── REVIEW_FIX: clear action, weaker supporting evidence ─
  // Classifier still produced a safe action, but soft taint or
  // design judgment prevents static-safe ranking.
  if (['C', 'A', 'specifier'].includes(finding.bucket) ||
      isResolvableDeclarationDependencyBucket) {
    const missing = [];
    if (hasSoftTaint) missing.push(...softTaintReasonLabels(perFindingTaint));
    if (weakRuntimeStatus) missing.push(`runtime=${runtime.status}`);
    return { tier: 'REVIEW_FIX', reason: `safe-action; missing: ${missing.join(', ') || 'none'}` };
  }

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
  for (const s of scored) {
    summary[s.tier]++;
    byTier[s.tier].push(s);
  }
  return { summary, byTier };
}
