#!/usr/bin/env node
// Merges dead-classify.json + runtime-evidence.json + staleness.json
// + symbols.json into a single fix-plan.json, keyed by 4-tier ranking.
//
//   rank-fixes.mjs --root <repo> --output <dir>
//
// Input (required): dead-classify.json
// Input (optional): runtime-evidence.json, staleness.json, symbols.json
// Output: fix-plan.json in <output>/
//
// Consumer: emit-sarif.mjs reads fix-plan.json if present and uses its
// tier → SARIF level mapping, bypassing its own ad-hoc logic.
//
// Design note: this is purely a merge layer. No new AST parsing, no
// new scanning. If any optional input is missing, that evidence axis
// becomes "unknown" and the tier degrades accordingly — never
// promotes. This keeps rank-fixes cheap to run (pure JSON I/O) and
// lets users ship partial pipelines without false-confidence tiers.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseCliArgs } from '../lib/cli.mjs';
import { tierForFinding, summarize, TIERS } from '../lib/ranking.mjs';
import { loadIfExists as loadArtifact } from '../lib/artifacts.mjs';
import { detectRepoMode } from '../lib/repo-mode.mjs';
import { buildSubmoduleResolver } from '../lib/paths.mjs';
import {
  findNearestPackageInfo,
  hasPublicDeepImportRisk,
} from '../lib/package-exports.mjs';

const { root, output } = parseCliArgs();
const ROOT = path.resolve(root);
const OUT = path.resolve(output);

const loadIfExists = (name) => loadArtifact(OUT, name, { tag: 'rank-fixes' });

const deadClassify = loadIfExists('dead-classify.json');
if (!deadClassify) {
  console.error('[rank-fixes] dead-classify.json is required. Run classify-dead-exports.mjs first.');
  process.exit(1);
}
const runtimeEvidence = loadIfExists('runtime-evidence.json');
const staleness = loadIfExists('staleness.json');
const symbols = loadIfExists('symbols.json');
const exportActionSafety = loadIfExists('export-action-safety.json');
const entrySurface = loadIfExists('entry-surface.json');
const moduleReachability = loadIfExists('module-reachability.json');

const inputs = {
  'dead-classify.json': true,
  'runtime-evidence.json': !!runtimeEvidence,
  'staleness.json': !!staleness,
  'symbols.json': !!symbols,
  'export-action-safety.json': !!exportActionSafety,
  'entry-surface.json': !!entrySurface,
  'module-reachability.json': !!moduleReachability,
};

// ─── Build lookup maps ────────────────────────────────────
const runtimeBy = new Map();
if (runtimeEvidence?.merged) {
  for (const m of runtimeEvidence.merged) {
    runtimeBy.set(`${m.file}|${m.symbol}|${m.line}`, m);
  }
}
const stalenessBy = new Map();
if (staleness?.enriched) {
  for (const s of staleness.enriched) {
    stalenessBy.set(`${s.file}|${s.symbol}|${s.line}`, s);
  }
}

const actionById = new Map();
if (exportActionSafety?.byId) {
  for (const [id, rec] of Object.entries(exportActionSafety.byId)) {
    actionById.set(id, rec);
  }
} else if (Array.isArray(exportActionSafety?.findings)) {
  for (const rec of exportActionSafety.findings) {
    if (rec?.id) actionById.set(rec.id, rec);
  }
}

const repoMode = detectRepoMode(ROOT);
const submoduleOf = buildSubmoduleResolver(ROOT, repoMode);
const reachability = (() => {
  if (!moduleReachability || !entrySurface) return null;
  const entryFiles = new Set([
    ...(entrySurface.entryFiles ?? []),
    ...(entrySurface.publicApiFiles ?? []),
    ...(entrySurface.frameworkEntrypointFiles ?? []),
    ...(entrySurface.configEntrypointFiles ?? []),
    ...(entrySurface.scriptEntrypointFiles ?? []),
    ...(entrySurface.htmlEntrypointFiles ?? []),
  ]);
  return {
    runtimeReachable: new Set(moduleReachability.runtimeReachableFiles ?? []),
    typeReachable: new Set(moduleReachability.typeReachableFiles ?? []),
    boundedOut: new Set(moduleReachability.boundedOutFiles ?? []),
    unreachable: new Set(moduleReachability.unreachableFiles ?? []),
    entryFiles,
    completenessBySubmodule: moduleReachability.meta?.completenessBySubmodule ?? {},
  };
})();

function opaqueDynamicImportCouldReach(file) {
  for (const item of symbols?.dynamicImportOpacity ?? []) {
    const targetDir = item?.targetDir;
    if (targetDir && file.startsWith(targetDir)) return true;
  }
  return false;
}

function fileHasPublicDeepImportRisk(file) {
  const packageInfo = findNearestPackageInfo(ROOT, file);
  if (!packageInfo?.packageJson) return false;
  return hasPublicDeepImportRisk(packageInfo.packageJson, packageInfo.relFileFromPkgRoot);
}

function entryUnreachableSupport(finding) {
  if (!reachability) return null;
  const file = finding.file;
  const submodule = submoduleOf(file);
  if (reachability.completenessBySubmodule[submodule] !== 'high') return null;
  if (!reachability.unreachable.has(file)) return null;
  if (reachability.runtimeReachable.has(file)) return null;
  if (reachability.typeReachable.has(file)) return null;
  if (reachability.boundedOut.has(file)) return null;
  if (reachability.entryFiles.has(file)) return null;
  if (opaqueDynamicImportCouldReach(file)) return null;
  if (fileHasPublicDeepImportRisk(file)) return null;
  return {
    kind: 'entry-unreachable',
    artifact: 'module-reachability.json',
    completeness: 'high',
  };
}

function withReachabilitySupport(finding) {
  const support = entryUnreachableSupport(finding);
  if (!support) return finding;
  const existing = Array.isArray(finding.supportedBy) ? finding.supportedBy : [];
  if (existing.some((s) => s?.kind === support.kind)) return finding;
  return { ...finding, supportedBy: [...existing, support] };
}

// Resolver blindness surfaces as a global gate. v1.9.7 FP-36: prefer
// the new `uses.unresolvedInternalRatio` (internal aliases that
// failed to resolve) over the legacy `unresolvedUses / total` which
// conflated external packages (react, eslint) with genuine blind
// spots. External imports are not a dead-export blind spot — only
// internal alias failures are.
let resolver = null;
if (symbols?.uses && typeof symbols.uses.unresolvedInternalRatio === 'number') {
  resolver = {
    unresolvedRatio: symbols.uses.unresolvedInternalRatio,
    unresolvedUses: symbols.uses.unresolvedInternal,
    totalUses: symbols.uses.resolvedInternal + symbols.uses.unresolvedInternal,
    externalUses: symbols.uses.external,
    source: 'uses.unresolvedInternalRatio',
  };
} else if (symbols && typeof symbols.totalUsesResolved === 'number' &&
    typeof symbols.unresolvedUses === 'number') {
  // Legacy fallback for symbols.json produced by builds < 1.9.7.
  const total = symbols.totalUsesResolved + symbols.unresolvedUses;
  resolver = {
    unresolvedRatio: total > 0 ? symbols.unresolvedUses / total : 0,
    unresolvedUses: symbols.unresolvedUses,
    totalUses: total,
    source: 'legacy (unresolvedUses/total — may include externals)',
  };
}

// ─── Flatten proposals into a unified finding list ────────
// Each proposal bucket in dead-classify maps to a logical "bucket" tag
// that ranking.mjs consumes.
function flatten(list, bucket) {
  return (list ?? []).map((p) => {
    const id = `dead-export:${p.file}:${p.symbol}:${p.line}`;
    const actionRecord = actionById.get(id);
    return {
      id,
      file: p.file,
      line: p.line,
      symbol: p.symbol,
      kind: p.kind,
      bucket,
      action: p.action,
      localName: p.localName,
      fileInternalUses: p.fileInternalUses,
      predicatePartner: p.predicatePartner,
      ...(actionRecord && 'safeAction' in actionRecord
          ? { safeAction: actionRecord.safeAction } : {}),
      ...(actionRecord?.actionBlockers !== undefined
          ? { actionBlockers: actionRecord.actionBlockers } : {}),
      ...(actionRecord?.localUseProof !== undefined
          ? { localUseProof: actionRecord.localUseProof } : {}),
    // v1.10.0 P1: per-finding provenance flows through to ranking.mjs
    // so the finding-local taint check can run. Older dead-classify
    // artifacts omit these fields and fall back to the global resolver
    // ratio gate.
      ...(p.fileInternalUsesEvidence !== undefined
          ? { fileInternalUsesEvidence: p.fileInternalUsesEvidence } : {}),
      ...(p.fileInternalRefs !== undefined
          ? { fileInternalRefs: p.fileInternalRefs } : {}),
      ...(p.supportedBy !== undefined ? { supportedBy: p.supportedBy } : {}),
      ...(p.taintedBy !== undefined ? { taintedBy: p.taintedBy } : {}),
      ...(p.resolverConfidence !== undefined
          ? { resolverConfidence: p.resolverConfidence } : {}),
      ...(p.parseStatus !== undefined ? { parseStatus: p.parseStatus } : {}),
      ...(p.declarationExportDependency !== undefined
          ? { declarationExportDependency: p.declarationExportDependency } : {}),
      ...(p.declarationExportRefs !== undefined
          ? { declarationExportRefs: p.declarationExportRefs } : {}),
    };
  });
}

const findings = [
  ...flatten(deadClassify.proposal_C_remove_symbol, 'C'),
  ...flatten(deadClassify.proposal_A_demote_to_internal, 'A'),
  ...flatten(deadClassify.proposal_B_review, 'B'),
  ...flatten(deadClassify.proposal_remove_export_specifier, 'specifier'),
  ...flatten(deadClassify.proposal_DEGRADED_unprocessed, 'unprocessed'),
];

// v1.9.6: excluded candidates materialize as MUTED. Without this block,
// `fix-plan.summary.MUTED` was always 0 because classify-dead-exports
// dropped these candidates before writing proposals. Now the user can
// audit what policy decided to hide.
const excludedCandidates = deadClassify.excludedCandidates ?? [];
const mutedFindings = excludedCandidates.map((e) => ({
  id: `dead-export:${e.file}:${e.symbol}:${e.line}`,
  file: e.file,
  line: e.line,
  symbol: e.symbol,
  kind: e.kind,
  bucket: 'excluded',
  action: `Policy-excluded: ${e.reason}`,
  _excludeReason: e.reason,
  ...(e.policyEvidence !== undefined ? { policyEvidence: e.policyEvidence } : {}),
}));

// ─── Score each finding ───────────────────────────────────
const scored = [];
for (const f of findings) {
  const rankedFinding = withReachabilitySupport(f);
  const key = `${f.file}|${f.symbol}|${f.line}`;
  const rt = runtimeBy.get(key);
  const st = stalenessBy.get(key);

  const evidence = {
    ...(rt ? {
      runtime: {
        status: rt.runtimeStatus,
        grounding: rt.grounding,
        confidence: rt.confidence,
        hitsInSymbol: rt.hitsInSymbol,
      },
    } : {}),
    ...(st ? {
      staleness: {
        tier: st.stalenessTier,
        grounding: st.grounding,
        lineLastTouchedDaysAgo: st.lineLastTouchedDaysAgo,
      },
    } : {}),
    ...(resolver ? { resolver } : {}),
    policy: { excluded: false },
  };

  const { tier, reason, confidence, confidenceDetail } = tierForFinding(rankedFinding, evidence);
  scored.push({
    finding: rankedFinding,
    evidence,
    tier,
    reason,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(confidenceDetail !== undefined ? { confidenceDetail } : {}),
  });
}

// v1.9.6: MUTED findings come from classifier exclusions. Pass
// policy.excluded=true so the ranking predicate routes them to MUTED
// regardless of any runtime/staleness data.
for (const f of mutedFindings) {
  const evidence = {
    policy: {
      excluded: true,
      reason: f._excludeReason,
      ...(f.policyEvidence !== undefined ? { evidence: f.policyEvidence } : {}),
    },
  };
  const { tier, reason } = tierForFinding(f, evidence);
  scored.push({ finding: f, evidence, tier, reason });
}

const { summary, byTier } = summarize(scored);

// ─── Emit ────────────────────────────────────────────────
// Each tier list is sorted for stable diffs: file, then line, then symbol.
function sortKey(s) {
  return `${s.finding.file}|${s.finding.line.toString().padStart(6, '0')}|${s.finding.symbol}`;
}
for (const t of TIERS) {
  byTier[t].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

function safeActionKind(score) {
  return score.finding.safeAction?.kind ?? 'unknown';
}

function buildSafeFixGroups(safeFixes) {
  const groups = new Map();
  for (const score of safeFixes) {
    const actionKind = safeActionKind(score);
    const key = `${score.finding.file}|${actionKind}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        file: score.finding.file,
        actionKind,
        count: 0,
        symbols: [],
        lines: [],
      };
      groups.set(key, group);
    }
    group.count++;
    group.symbols.push(score.finding.symbol);
    group.lines.push(score.finding.line);
  }

  return [...groups.values()].sort((a, b) =>
    b.count - a.count
    || a.file.localeCompare(b.file)
    || a.actionKind.localeCompare(b.actionKind));
}

const safeFixGroups = buildSafeFixGroups(byTier.SAFE_FIX);
summary.safeFixGroups = safeFixGroups.length;

const artifact = {
  meta: {
    generated: new Date().toISOString(),
    root: ROOT,
    tool: 'rank-fixes.mjs',
    inputs,
    resolverBlindness: resolver
      ? { ratio: +resolver.unresolvedRatio.toFixed(4),
          unresolvedUses: resolver.unresolvedUses,
          totalUses: resolver.totalUses,
          externalUses: resolver.externalUses,
          source: resolver.source,
          gate: resolver.unresolvedRatio >= 0.15 ? 'tripped' : 'ok' }
      : null,
    // v1.9.7 FP-36: when resolver blindness is tripped, surface which
    // specifier prefixes are driving it. Users can add tsconfig path
    // or alias entries targeting the top prefixes to recover finding
    // precision.
    topUnresolvedSpecifiers: symbols?.topUnresolvedSpecifiers ?? [],
  },
  summary,
  safeFixes: byTier.SAFE_FIX,
  safeFixGroups,
  reviewFixes: byTier.REVIEW_FIX,
  degraded: byTier.DEGRADED,
  muted: byTier.MUTED,
};

const outPath = path.join(OUT, 'fix-plan.json');
writeFileSync(outPath, JSON.stringify(artifact, null, 2));

// ─── Console report ──────────────────────────────────────
console.log('\n══════ fix-plan ranking ══════');
console.log(`  SAFE_FIX    : ${summary.SAFE_FIX}  (auto-fix candidates)`);
console.log(`  REVIEW_FIX  : ${summary.REVIEW_FIX}  (human review recommended)`);
console.log(`  DEGRADED    : ${summary.DEGRADED}  (evidence insufficient — not a hard warning)`);
console.log(`  MUTED       : ${summary.MUTED}  (policy-excluded — not a finding)`);
console.log(`  total       : ${summary.total}`);
// v1.10.0 P1: with per-finding taint, the global ratio is a snapshot
// — individual findings are judged locally. The gate message shifts
// from "all findings DEGRADED" to "N findings DEGRADED (per-finding)".
const degradedByUnresolvedSpec = byTier.DEGRADED.filter((s) =>
  typeof s.reason === 'string' && s.reason.startsWith('unresolved-spec-could-match')).length;
if (resolver && resolver.unresolvedRatio >= 0.15) {
  console.log(`\n  ⚠ resolver unresolvedRatio = ${(resolver.unresolvedRatio * 100).toFixed(1)}%`);
  if (degradedByUnresolvedSpec > 0) {
    console.log(`    ${degradedByUnresolvedSpec} finding(s) DEGRADED by per-finding spec match — add a tsconfig path or alias to reduce.`);
  } else {
    console.log('    No finding matched an unresolved specifier locally; global ratio is informational only.');
  }
}
if (summary.SAFE_FIX > 0) {
  console.log('\n── SAFE_FIX top entries ──');
  for (const s of byTier.SAFE_FIX.slice(0, 5)) {
    console.log(`  ${s.finding.file}:${s.finding.line}  ${s.finding.symbol}  (${s.reason})`);
  }
  if (safeFixGroups.length > 0) {
    console.log('\n── SAFE_FIX grouped patterns ──');
    for (const group of safeFixGroups.slice(0, 5)) {
      const sample = group.symbols.slice(0, 4).join(', ');
      const suffix = group.symbols.length > 4 ? ', ...' : '';
      console.log(`  ${group.count}×  ${group.actionKind}  ${group.file}  (${sample}${suffix})`);
    }
  }
}
console.log(`\n[rank-fixes] saved → ${outPath}`);
