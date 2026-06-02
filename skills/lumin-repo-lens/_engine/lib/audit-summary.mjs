// Audit artifact brief renderer.
//
// This file intentionally avoids ranking or curating the final chat answer.
// The engine is good at producing facts; the model/user should decide which
// facts matter for the current question after reading the raw artifacts.

import { formatAnyContaminationCue } from './any-contamination-summary.mjs';
import { formatUnresolvedReasonCounts } from './blind-zones.mjs';
import {
  formatBlockedCandidateHintDistribution,
  formatBlockedCandidateHints,
} from './resolver-blocked-hints.mjs';

function n(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function pct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  return `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return count === 1 ? singular : pluralValue;
}

function unresolvedReasonObjectToList(reasons) {
  if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) return reasons;
  return Object.entries(reasons)
    .filter(([, count]) => typeof count === 'number')
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function formatTopUnresolvedRoots(roots, limit = 3) {
  if (!Array.isArray(roots) || roots.length === 0) return null;
  const parts = roots
    .slice(0, limit)
    .map((root) => {
      const name = root?.specifierRoot;
      const count = root?.count;
      if (!name || typeof count !== 'number') return null;
      const reasons = formatUnresolvedReasonCounts(unresolvedReasonObjectToList(root?.reasons));
      return `${name} ${count}${reasons ? ` (${reasons})` : ''}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join('; ') : null;
}

function formatTopAffectedPackageScopes(scopes, limit = 3) {
  if (!Array.isArray(scopes) || scopes.length === 0) return null;
  const parts = scopes
    .slice(0, limit)
    .map((scope) => {
      const name = scope?.affectedPackageScope;
      const count = scope?.count;
      if (!name || typeof count !== 'number') return null;
      return `${name} ${count}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join('; ') : null;
}

function formatCounterObject(counter) {
  if (!counter || typeof counter !== 'object' || Array.isArray(counter)) return null;
  const parts = Object.entries(counter)
    .filter(([, count]) => typeof count === 'number')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => `${label} ${count}`);
  return parts.length ? parts.join(', ') : null;
}

function formatFrameworkResourceSurfaceCounts(summary) {
  const total = n(summary?.totalFilesWithSurfaces, 0);
  if (total <= 0) return null;
  const laneText = formatCounterObject(summary?.byLane);
  const confidenceText = formatCounterObject(summary?.byConfidence);
  const examples = Array.isArray(summary?.topExamples)
    ? summary.topExamples.slice(0, 2)
        .map((example) => {
          if (!example?.file) return null;
          const reason = Array.isArray(example.reasons) && example.reasons.length > 0
            ? ` (${example.reasons.join(', ')})`
            : '';
          return `${example.file}${reason}`;
        })
        .filter(Boolean)
        .join('; ')
    : '';
  return [
    `${total} files`,
    laneText ? `lanes ${laneText}` : null,
    confidenceText ? `confidence ${confidenceText}` : null,
    examples ? `examples: ${examples}` : null,
  ].filter(Boolean).join('; ');
}

function formatDependencyHygieneCue(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const status = typeof summary.status === 'string' ? summary.status : 'unavailable';
  if (status !== 'complete') {
    return 'Dependency hygiene: evidence incomplete; do not infer dependency declaration absence. Read `manifest.json.unusedDependencies` and `unused-deps.json`.';
  }

  const reviewUnused = n(summary.reviewUnusedCount, 0);
  const muted = n(summary.mutedCount, 0);
  const confidenceLimited = n(summary.confidenceLimitedCount, 0);
  if (reviewUnused <= 0 && confidenceLimited <= 0) return null;

  const reviewVerb = reviewUnused === 1 ? 'needs' : 'need';
  const confidenceText = confidenceLimited > 0
    ? `; ${confidenceLimited} confidence-limited ${plural(confidenceLimited, 'declaration')}`
    : '';
  return `Dependency hygiene: ${reviewUnused} review-only dependency ${plural(reviewUnused, 'declaration')} ${reviewVerb} inspection; ${muted} muted ${plural(muted, 'explanation')}${confidenceText}. Read \`manifest.json.unusedDependencies\` and \`unused-deps.json\` before changing package manifests.`;
}

function formatSfcEvidenceCue(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const byLane = summary.byLane && typeof summary.byLane === 'object'
    ? summary.byLane
    : {};
  const total = n(summary.totalEvidenceCount, 0);
  const reviewOnly = n(summary.reviewOnlyEvidenceCount, 0);
  const scriptConsumers = n(summary.scriptImportConsumerCount, n(byLane.scriptImportConsumers));
  const reachabilityOnly = n(summary.reachabilityOnlyCount, n(byLane.scriptSrcReachability));
  if (total <= 0) return null;

  const laneText = [
    scriptConsumers > 0 ? `script imports ${scriptConsumers}` : null,
    reachabilityOnly > 0 ? `script-src reachability ${reachabilityOnly}` : null,
    n(byLane.styleAssetReferences) > 0 ? `style assets ${n(byLane.styleAssetReferences)}` : null,
    n(byLane.templateComponentRefs) > 0 ? `template refs ${n(byLane.templateComponentRefs)}` : null,
    n(byLane.globalComponentRegistrations) > 0 ? `global registrations ${n(byLane.globalComponentRegistrations)}` : null,
    n(byLane.generatedComponentManifests) > 0 ? `generated manifests ${n(byLane.generatedComponentManifests)}` : null,
    n(byLane.frameworkConventionComponents) > 0 ? `framework conventions ${n(byLane.frameworkConventionComponents)}` : null,
  ].filter(Boolean).join(', ');

  return `SFC evidence: ${total} ${plural(total, 'record')} across ${laneText || 'recorded SFC lanes'}; ${reviewOnly} review-only ${plural(reviewOnly, 'record')}. Read \`manifest.json.sfcEvidence\` and SFC arrays in \`symbols.json\`; review-only SFC lanes are not fan-in or action-tier proof, and sfc-scan-gap still applies.`;
}

function formatUnreachableSccCue(moduleReachability) {
  const groups = n(moduleReachability?.summary?.unreachableStronglyConnectedComponents, 0);
  const files = n(moduleReachability?.summary?.unreachableStronglyConnectedFiles, 0);
  if (groups <= 0 || files <= 0) return null;
  return `Unreachable SCCs: ${groups} ${plural(groups, 'group')}, ${files} ${plural(files, 'file')}`;
}

function formatTopSpecifiers(specifiers, limit = 2) {
  if (!Array.isArray(specifiers) || specifiers.length === 0) return null;
  const parts = specifiers
    .slice(0, limit)
    .map((item) => {
      if (!item?.specifier || typeof item.count !== 'number') return null;
      return `${item.specifier} ${item.count}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function formatGeneratedConsumerBlindZoneScopes(groups, limit = 3) {
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const parts = groups
    .slice(0, limit)
    .map((group) => {
      const scope = group?.scopePackageRoot;
      const count = group?.count;
      if (!scope || typeof count !== 'number') return null;
      const statusText = formatCounterObject(group.statuses);
      const specifierText = formatTopSpecifiers(group.topSpecifiers);
      const detail = [statusText, specifierText].filter(Boolean).join('; ');
      return `${scope} ${count}${detail ? ` (${detail})` : ''}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join('; ') : null;
}

function artifactName(filePath) {
  if (!filePath) return null;
  return String(filePath).replace(/\\/g, '/').split('/').slice(-2).join('/');
}

function summarizeLifecycleCommand(manifest) {
  const out = [];

  const pre = manifest?.preWrite;
  if (pre?.requested) {
    if (pre.ran) {
      const specific = artifactName(pre.advisoryPath) ?? 'the invocation-specific advisory';
      const latest = artifactName(pre.latestAdvisoryPath) ?? 'pre-write-advisory.latest.json';
      out.push(`- Pre-write ran and wrote an advisory. Use \`${specific}\` for the matching post-write check; \`${latest}\` is only the latest pointer.`);
    } else {
      out.push(`- Pre-write did not run: ${pre.reason ?? 'reason unavailable'}.`);
    }
  }

  const post = manifest?.postWrite;
  if (post?.requested) {
    if (post.ran) {
      const baselineStatus = post.baselineStatus ?? 'unknown';
      const scanRangeParity = post.scanRangeParity ?? 'unknown';
      const afterComplete = post.afterComplete === true;
      const caveated =
        baselineStatus !== 'available' ||
        scanRangeParity !== 'ok' ||
        !afterComplete;
      if (caveated) {
        out.push(
          `- Post-write ran, but delta confidence is limited: baseline=${baselineStatus}, scanRange=${scanRangeParity}, afterComplete=${afterComplete}. Read \`post-write-delta.latest.json\` before closing.`
        );
      } else {
        const silentNew = n(post.silentNew, 0);
        const noun = plural(silentNew, 'new unplanned any-like escape');
        out.push(`- Post-write type-escape delta found ${silentNew} ${noun}. This is not a full behavior verdict.`);
      }
      const unexpectedNewFiles = n(post.unexpectedNewFileCount, 0);
      const plannedMissingFiles = n(post.plannedMissingFileCount, 0);
      if (unexpectedNewFiles > 0 || plannedMissingFiles > 0) {
        out.push(
          `- Post-write file delta needs review: ${unexpectedNewFiles} unexpected new ${plural(unexpectedNewFiles, 'file')}, ${plannedMissingFiles} planned missing ${plural(plannedMissingFiles, 'file')}. Read \`post-write-delta.latest.json\` before closing.`
        );
      }
    } else {
      out.push(`- Post-write did not run: ${post.reason ?? 'reason unavailable'}.`);
    }
  }

  const draft = manifest?.canonDraft;
  if (draft?.requested) {
    const draftCount = Array.isArray(draft.draftPaths) ? draft.draftPaths.length : 0;
    if (draft.ran && draftCount > 0) {
      const shown = draft.draftPaths.slice(0, 3).map(artifactName).filter(Boolean).join(', ');
      const more = draftCount > 3 ? `, plus ${draftCount - 3} more` : '';
      out.push(`- Canon draft wrote ${draftCount} proposal ${plural(draftCount, 'file')} under canonical-draft/. Review manually before promotion.${shown ? ` Drafts: ${shown}${more}.` : ''}`);
    } else if (draft.ran) {
      out.push('- Canon draft ran, but no proposal path was recorded. Check per-source status before promotion.');
    } else {
      out.push(`- Canon draft did not write proposals: ${draft.reason ?? 'all requested sources failed'}.`);
    }
  }

  const check = manifest?.checkCanon;
  if (check?.requested) {
    const summary = check.summary ?? {};
    const driftCount = n(summary.driftCount, 0);
    const checked = n(summary.sourcesChecked, 0);
    const skipped = n(summary.sourcesSkipped, 0);
    const failed = n(summary.sourcesFailed, 0);
    if (!check.ran) {
      out.push(`- Check-canon did not run: ${check.reason ?? 'reason unavailable'}.`);
    } else if (checked === 0) {
      out.push(`- Check-canon could not compare promoted canon yet: ${skipped} ${plural(skipped, 'area')} missing, ${failed} failed.`);
    } else if (driftCount > 0) {
      const driftSources = Object.values(check.driftCounts ?? {}).filter((count) => n(count, 0) > 0).length;
      out.push(`- Check-canon found ${driftCount} drift ${plural(driftCount, 'item')} across ${driftSources}/${checked} checked ${plural(checked, 'area')}.`);
    } else {
      const caveat = skipped + failed > 0
        ? ` ${skipped + failed} ${plural(skipped + failed, 'area')} could not be checked.`
        : '';
      out.push(`- Check-canon is clean across ${checked} checked ${plural(checked, 'area')}.${caveat}`.trim());
    }
  }

  return out;
}

function summarizeScanRange(manifest) {
  const sr = manifest?.scanRange ?? {};
  const langs = Array.isArray(sr.languages) && sr.languages.length > 0
    ? sr.languages.join(', ')
    : 'unknown';
  const tests = sr.includeTests === false ? 'production files only' : 'including tests';
  const files = sr.files ?? 'unknown';
  const excludes = Array.isArray(sr.excludes) && sr.excludes.length > 0
    ? `; excludes: ${sr.excludes.join(', ')}`
    : '';
  return `${files} files, ${langs}, ${tests}${excludes}`;
}

function summarizeConfidence(manifest) {
  const c = manifest?.confidence ?? {};
  const blindCount = Array.isArray(manifest?.blindZones) ? manifest.blindZones.length : 0;
  return `parse errors ${c.parseErrors ?? 'unknown'}, unresolved internal ${pct(c.unresolvedInternalRatio)}, blind zones ${blindCount}`;
}

function typeEscapeTotal(discipline) {
  const totals = discipline?.totals ?? {};
  return n(totals[':any']) +
    n(totals['as any']) +
    n(totals['as unknown as']) +
    n(totals['@ts-ignore']) +
    n(totals['@ts-expect-error']) +
    n(totals['@ts-nocheck']) +
    n(totals['jsdoc-any']);
}

function measuredCueLines({ manifest, checklistFacts, fixPlan, topology, discipline, callGraph, functionClones, symbols, moduleReachability }) {
  const lines = [];

  if (topology?.summary || checklistFacts?.A6_circular_deps) {
    const sccCount = n(topology?.summary?.sccCount, n(checklistFacts?.A6_circular_deps?.sccCount, 0));
    lines.push(`- Runtime cycles: ${sccCount}. Read \`topology.json.summary.sccCount\` and \`topology.json.sccs[]\` before deciding whether a cycle matters.`);
  }

  if (checklistFacts?.A2_function_size) {
    const a2 = checklistFacts.A2_function_size;
    const oversized = Array.isArray(a2.oversized) ? a2.oversized.length : n(a2.big, 0);
    const watch = Array.isArray(a2.watch) ? a2.watch.length : n(a2.medium, 0);
    lines.push(`- Function size: gate ${a2.gate ?? 'unknown'}, oversized ${oversized}, watch ${watch}. Read \`checklist-facts.json.A2_function_size\` and screen test/script roles before proposing a split.`);
  }

  if (checklistFacts?.E2_silent_catch) {
    const e2 = checklistFacts.E2_silent_catch;
    lines.push(`- Catch handling: empty silent ${n(e2.count)}, non-empty anonymous ${n(e2.nonEmptyAnonymousCount)}, unused params ${n(e2.unusedParamCount)}. Read \`checklist-facts.json.E2_silent_catch\` before saying this lane is clean.`);
  }

  if (discipline?.totals) {
    lines.push(`- Type-check escapes: ${typeEscapeTotal(discipline)} total any/ignore-style hits. Read \`discipline.json.totals\` and offender lists; do not rank this by count alone.`);
  }

  const anyContaminationCue = formatAnyContaminationCue(symbols);
  if (anyContaminationCue) {
    lines.push(anyContaminationCue);
  }

  if (checklistFacts?.B1B2_shape_drift) {
    const b = checklistFacts.B1B2_shape_drift;
    lines.push(`- Shape drift: exact groups ${n(b.exactDuplicateGroups)}, near-shape cues ${n(b.nearShapeCandidateCount)}. Read \`checklist-facts.json.B1B2_shape_drift\` and the declarations before merging concepts.`);
  }

  if (checklistFacts?.B1_duplicate_implementation || functionClones?.meta) {
    const b1 = checklistFacts?.B1_duplicate_implementation ?? {};
    const exact = n(b1.exactBodyGroups, n(functionClones?.meta?.exactBodyGroupCount));
    const structure = n(b1.structureGroupCandidates, n(functionClones?.meta?.structureGroupCount));
    const signature = n(b1.signatureGroupCandidates, n(functionClones?.meta?.signatureGroupCount));
    const near = n(b1.nearFunctionCandidates, n(functionClones?.meta?.nearFunctionCandidateCount));
    lines.push(`- Function clone cues: exact body groups ${exact}, same-structure groups ${structure}, same-signature groups ${signature}, near-function cues ${near}. Read \`function-clones.json\` and source file:line evidence before calling helpers duplicated.`);
  }

  if (fixPlan?.summary) {
    const s = fixPlan.summary;
    lines.push(`- Dead-export tiers: SAFE_FIX ${n(s.SAFE_FIX)}, REVIEW_FIX ${n(s.REVIEW_FIX)}, DEGRADED ${n(s.DEGRADED)}, MUTED ${n(s.MUTED)}. Read \`fix-plan.json\` plus FP context before recommending removal.`);
  }

  const unreachableSccCue = formatUnreachableSccCue(moduleReachability);
  if (unreachableSccCue) {
    lines.push(
      `- ${unreachableSccCue}. Read \`module-reachability.json.unreachableStronglyConnectedComponents[]\` before treating intra-cycle imports as liveness. This is dead-file-group review evidence, not export SAFE_FIX proof.`
    );
  }

  const generatedConsumerZoneCount = n(manifest?.generatedArtifacts?.generatedConsumerBlindZoneCount, 0);
  if (generatedConsumerZoneCount > 0) {
    const topScopes = formatGeneratedConsumerBlindZoneScopes(
      manifest?.generatedArtifacts?.topGeneratedConsumerBlindZones
    );
    lines.push(
      `- Generated consumer blind zones: ${generatedConsumerZoneCount}${topScopes ? `; top scopes: ${topScopes}` : ''}. Read \`manifest.json.generatedArtifacts.topGeneratedConsumerBlindZones\` and \`symbols.json.generatedConsumerBlindZones\` before treating generated code as absent.`
    );
  }

  const frameworkResourceSurfaces = formatFrameworkResourceSurfaceCounts(
    manifest?.frameworkResourceSurfaces
  );
  if (frameworkResourceSurfaces) {
    lines.push(
      `- Framework/resource surfaces: ${frameworkResourceSurfaces}. Read \`manifest.json.frameworkResourceSurfaces\` and \`framework-resource-surfaces.json\` before treating import absence as deadness.`
    );
  }

  const dependencyHygieneCue = formatDependencyHygieneCue(
    manifest?.unusedDependencies
  );
  if (dependencyHygieneCue) {
    lines.push(`- ${dependencyHygieneCue}`);
  }

  const sfcEvidenceCue = formatSfcEvidenceCue(manifest?.sfcEvidence);
  if (sfcEvidenceCue) {
    lines.push(`- ${sfcEvidenceCue}`);
  }

  if (callGraph?.summary) {
    const semiDead = n(callGraph.summary.semiDead, Array.isArray(callGraph.semiDeadList) ? callGraph.semiDeadList.length : 0);
    lines.push(`- Call graph: semi-dead imports ${semiDead}. Read \`call-graph.json.semiDeadList\` and framework/test conventions before cleanup.`);
  }

  const blindZones = Array.isArray(manifest?.blindZones) ? manifest.blindZones : [];
  if (blindZones.length > 0) {
    lines.push(`- Blind zones: ${blindZones.length}. Read \`manifest.json.blindZones\` before any absence or removal claim.`);
    const resolverZone = blindZones.find((z) => z?.area === 'resolver');
    const resolverReasons = formatUnresolvedReasonCounts(resolverZone?.details?.topUnresolvedReasons);
    if (resolverReasons) {
      lines.push(`- Resolver blind-zone reasons: ${resolverReasons}. Read \`symbols.json.unresolvedInternalSummaryByReason\` and \`manifest.json.blindZones[].details.topUnresolvedReasons\` before treating unresolved imports as generic noise.`);
    }
    const unresolvedRoots = formatTopUnresolvedRoots(manifest?.resolverDiagnostics?.topSpecifierRoots);
    if (unresolvedRoots) {
      lines.push(`- Top unresolved roots: ${unresolvedRoots}. Read \`manifest.json.resolverDiagnostics.topSpecifierRoots\` to see which package or alias roots concentrate resolver blind zones.`);
    }
    const affectedScopes = formatTopAffectedPackageScopes(
      manifest?.resolverDiagnostics?.topAffectedPackageScopes
    );
    if (affectedScopes) {
      lines.push(`- Resolver affected scopes: ${affectedScopes}. Read \`manifest.json.resolverDiagnostics.topAffectedPackageScopes\` before treating resolver blind zones as repo-global blockers.`);
    }
    const blockedCandidateHintCount = n(manifest?.resolverDiagnostics?.blockedCandidateHintCount, 0);
    const blockedCandidateHintSampleLimit = n(manifest?.resolverDiagnostics?.blockedCandidateHintSampleLimit, 0);
    const blockedCandidateHints = formatBlockedCandidateHints(
      manifest?.resolverDiagnostics?.blockedCandidateHints
    );
    if (blockedCandidateHintCount > 0) {
      const sampleLimit = blockedCandidateHintSampleLimit > 0
        ? `; manifest sample limit ${blockedCandidateHintSampleLimit}`
        : '';
      const blockerDistribution = formatBlockedCandidateHintDistribution(
        manifest?.resolverDiagnostics
      );
      if (blockerDistribution) {
        lines.push(
          `- Resolver blocked absence distribution: ${blockerDistribution}. Read \`manifest.json.resolverDiagnostics.blockedCandidateHintReasonCounts\` and \`manifest.json.resolverDiagnostics.blockedCandidateHintFamilyCounts\` before opening the full hint list.`
        );
      }
      lines.push(
        `- Resolver blocked absence hints: ${blockedCandidateHintCount}${sampleLimit}${blockedCandidateHints ? `; examples: ${blockedCandidateHints}` : ''}. Read \`manifest.json.resolverDiagnostics.blockedCandidateHints\` and \`resolver-diagnostics.json.blockedCandidateHints\` before treating affected exports as absent.`
      );
    }
  }

  return lines.length > 0
    ? lines
    : ['- No measured cue lines were available from the provided artifacts. Read `manifest.json` and rerun the relevant profile before making structural claims.'];
}

function artifactMapLines({ manifest, checklistFacts, fixPlan, topology, discipline, callGraph, functionClones, symbols, moduleReachability }) {
  const produced = Array.isArray(manifest?.artifactsProduced) ? new Set(manifest.artifactsProduced) : new Set();
  const lines = [];

  lines.push('- `manifest.json`: scan range, confidence, blind zones, and command status.');
  if (symbols || produced.has('symbols.json')) {
    lines.push('- `symbols.json`: export identities, total/type/value fan-in, dependency import consumers, public owner facts, unresolved internal reason summaries, generated consumer blind zones, and identity-level anyContamination owner maps.');
  }
  if (checklistFacts || produced.has('checklist-facts.json')) {
    lines.push('- `checklist-facts.json`: checklist gates and measured review cues; gates are triggers, not verdicts.');
  }
  if (fixPlan || produced.has('fix-plan.json')) {
    lines.push('- `fix-plan.json`: dead-export tiering; screen public surface and FP families before action.');
  }
  if (topology || produced.has('topology.json')) {
    lines.push('- `topology.json`: cycles, cross-submodule edges, largest files, and topology details.');
  }
  if (moduleReachability || produced.has('module-reachability.json')) {
    lines.push('- `module-reachability.json`: entry-rooted file reachability, unreachable files, and entry-unreachable SCC review cues.');
  }
  if (produced.has('topology.mermaid.md')) {
    lines.push('- `topology.mermaid.md`: capped Mermaid diagrams plus hub-file notes for topology review; visual aid only, not citation authority.');
  }
  if (discipline || produced.has('discipline.json')) {
    lines.push('- `discipline.json`: regex/AST-supported type-escape and suppression counts.');
  }
  if (callGraph || produced.has('call-graph.json')) {
    lines.push('- `call-graph.json`: call graph and semi-dead import evidence from full profile.');
  }
  if (produced.has('shape-index.json')) {
    lines.push('- `shape-index.json`: exact shape-hash facts for full-profile B1/B2 review.');
  }
  if (functionClones || produced.has('function-clones.json')) {
    lines.push('- `function-clones.json`: top-level exported and file-local function-body clone cues; candidates require source review before merge advice.');
  }
  if (produced.has('barrels.json')) {
    lines.push('- `barrels.json`: barrel discipline evidence for full-profile C7 review.');
  }
  if (manifest?.unusedDependencies || produced.has('unused-deps.json')) {
    lines.push('- `unused-deps.json`: review-only dependency declaration evidence; inspect before changing package manifests.');
  }
  if (manifest?.sfcEvidence) {
    lines.push('- `symbols.json` SFC arrays: SFC import, reachability, asset, template, registration, generated-manifest, and framework-convention evidence; review-only SFC lanes do not prove fan-in or action readiness.');
  }

  return lines;
}

function livingAuditLines(manifest) {
  const docs = Array.isArray(manifest?.livingAudit?.existingDocs)
    ? manifest.livingAudit.existingDocs
    : [];
  if (docs.length === 0) return [];
  const shown = docs.map((doc) => `\`${doc.path ?? doc}\``).join(', ');
  return [
    '## Living Audit Tracking',
    '',
    `- Existing living audit document${docs.length === 1 ? '' : 's'} found: ${shown}.`,
    '- Read and update the document before the final answer. Mark items `RESOLVED` only with comparable scan range and produced evidence; otherwise use `NOT_RECHECKED`. Do not ask a subagent to own this document.',
    '',
  ];
}

function expansionHintLines(manifest) {
  const profile = manifest?.profile;
  if (profile !== 'full' && profile !== 'ci') return [];
  return [
    '## Expansion Hint',
    '',
    'Full-profile evidence is available. If the final chat answer stays short, add one low-pressure line saying the same evidence can be expanded into a full checklist walk, formal report, or due-diligence handoff.',
    'Copyable phrases: `full checklist로 펼쳐줘`, `formal report로 써줘`, `due-diligence handoff로 정리해줘`.',
    '',
  ];
}

export function renderAuditSummary({
  manifest,
  checklistFacts = null,
  fixPlan = null,
  topology = null,
  discipline = null,
  callGraph = null,
  functionClones = null,
  symbols = null,
  moduleReachability = null,
}) {
  const commandResult = summarizeLifecycleCommand(manifest);
  const lines = [
    '# Audit Artifact Brief',
    '',
    'This file is an orientation map, not a recommendation engine. Do not paste it as the final user answer. Read the raw artifacts and write the chat summary yourself.',
    '',
    `Generated: ${manifest?.meta?.generated ?? new Date().toISOString()}`,
    `Profile: ${manifest?.profile ?? 'unknown'}`,
    `Scan range: ${summarizeScanRange(manifest)}`,
    `Confidence: ${summarizeConfidence(manifest)}`,
    '',
  ];

  if (commandResult.length > 0) {
    lines.push('## Command Result', '');
    lines.push(...commandResult);
    lines.push('');
  }

  lines.push('## Read First', '');
  lines.push('- Start with `manifest.json` for scan range, confidence, blind zones, and lifecycle command status.');
  lines.push('- Then read the raw artifact for the user question: symbols, topology, discipline, checklist, fix-plan, call-graph, barrels, shape-index, or function-clones.');
  lines.push('- Curate the final chat answer from those artifacts. Do not inherit ordering from this brief.');
  lines.push('');

  lines.push('## Measured Cues (Unranked)', '');
  lines.push(...measuredCueLines({ manifest, checklistFacts, fixPlan, topology, discipline, callGraph, functionClones, symbols, moduleReachability }));
  lines.push('');

  lines.push('## Artifact Map', '');
  lines.push(...artifactMapLines({ manifest, checklistFacts, fixPlan, topology, discipline, callGraph, functionClones, symbols, moduleReachability }));
  lines.push('');

  lines.push(...livingAuditLines(manifest));

  lines.push(...expansionHintLines(manifest));

  lines.push('## Guardrails', '');
  lines.push('- Raw artifacts are authoritative; this brief is only a map of where to look.');
  lines.push('- Gate values are triggers, not verdicts.');
  lines.push('- Counts alone do not define priority. Re-rank by the user request, repo context, file role, and evidence quality.');
  lines.push('- For vibe-coder chat, answer with what is stable, what to inspect next, what to leave alone, and how to verify.');
  lines.push('');

  return lines.join('\n');
}
