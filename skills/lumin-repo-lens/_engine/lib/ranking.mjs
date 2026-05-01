import { BLOCKING_TAINTS, SOFT_TAINTS, TAINT } from './vocab.mjs';

// 4-tier finding classification.
//
// Upstream this module consumes dead-classify.json + optional
// runtime-evidence.json + staleness.json, and produces a single tier
// per finding. Consumers (rank-fixes.mjs, emit-sarif.mjs) agree on
// one predicate so CI severity matches the fix-plan ranking.
//
// Tiers:
//   SAFE_FIX    — strong evidence for mechanical removal or specifier
//                 cleanup (bucket C or specifier; A is NEVER SAFE —
//                 demote-to-internal needs human judgment on internal
//                 consumers). Candidate for automation
//                 (`apply-dead-fixes --safe-only`). SARIF warning.
//   REVIEW_FIX  — Classifier proposes concrete action (C/A/B/specifier)
//                 but SAFE evidence is incomplete. Covers: no runtime
//                 coverage, no staleness data, recent edits, A-bucket,
//                 B-bucket (predicate partner / design judgment).
//                 SARIF note.
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

/**
 * Classify a single finding given its accumulated evidence.
 *
 * @param {object} finding    {file, line, symbol, kind, bucket, action,
 *                            fileInternalUses?, predicatePartner?,
 *                            taintedBy?, supportedBy?, resolverConfidence?}
 * @param {object} evidence   {runtime?: {status, grounding, confidence,
 *                            hitsInSymbol}, staleness?: {tier,
 *                            grounding, lineLastTouchedDaysAgo}, policy?:
 *                            {excluded, reason}, resolver?: {unresolvedRatio}}
 * @returns {{tier: string, reason: string}}
 */
export function tierForFinding(finding, evidence = {}) {
  const { runtime, staleness, policy, resolver } = evidence;

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

  // ─── DEGRADED: exported declaration dependency ───────────
  // A symbol referenced from an exported TS declaration/namespace can be
  // needed for declaration emit even when no cross-file import names it
  // directly. Without checker-grade declaration validation, surfacing a
  // cleanup action here is too sharp.
  if (finding.declarationExportDependency) {
    const count = finding.declarationExportRefs?.count ?? 0;
    return {
      tier: 'DEGRADED',
      reason: `exported-declaration-dependency (${count} ref${count === 1 ? '' : 's'})`,
    };
  }

  // ─── SAFE_FIX: multi-source convergence ───────────────────
  // All three conditions must hold:
  //   1. Classifier proposes direct action (C = remove, or aliased
  //      specifier = specifier removal only — both mechanical)
  //   2. Runtime confirms dead (not just "file uncovered")
  //   3. Staleness shows fossil or stale (recent edits signal
  //      active development; give humans first look)
  //   4. No soft taint — parse errors elsewhere could hide a consumer
  //      of this symbol (demote to REVIEW for human-confirm).
  const strongRuntime = runtime?.status === 'dead-confirmed' &&
                        runtime?.grounding === 'grounded';
  const cold = staleness?.tier === 'fossil' || staleness?.tier === 'stale';
  const mechanicalBucket = finding.bucket === 'C' || finding.bucket === 'specifier';

  if (strongRuntime && cold && mechanicalBucket && !hasSoftTaint) {
    const bits = ['AST-dead', 'runtime-dead-confirmed', `staleness-${staleness.tier}`, `bucket-${finding.bucket}`];
    return { tier: 'SAFE_FIX', reason: bits.join(' + ') };
  }

  // ─── REVIEW_FIX: clear action, weaker supporting evidence ─
  // Classifier still produced a concrete proposal but we don't have
  // all three supporting signals, OR soft taint is present. A human
  // can still decide quickly.
  if (['C', 'A', 'specifier'].includes(finding.bucket)) {
    const missing = [];
    if (!strongRuntime) missing.push(runtime?.status ? `runtime=${runtime.status}` : 'no-runtime');
    if (!cold) missing.push(staleness?.tier ? `staleness=${staleness.tier}` : 'no-staleness');
    if (hasSoftTaint) missing.push('parse-errors-elsewhere');
    return { tier: 'REVIEW_FIX', reason: `bucket-${finding.bucket}; missing: ${missing.join(', ') || 'none'}` };
  }

  // ─── REVIEW_FIX: B bucket (predicate partner / design judgment) ──
  if (finding.bucket === 'B') {
    return { tier: 'REVIEW_FIX', reason: 'bucket-B (design review required)' };
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
