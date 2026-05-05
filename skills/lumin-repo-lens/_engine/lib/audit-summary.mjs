// Audit artifact brief renderer.
//
// This file intentionally avoids ranking or curating the final chat answer.
// The engine is good at producing facts; the model/user should decide which
// facts matter for the current question after reading the raw artifacts.

import { formatAnyContaminationCue } from './any-contamination-summary.mjs';
import { formatUnresolvedReasonCounts } from './blind-zones.mjs';

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

function measuredCueLines({ manifest, checklistFacts, fixPlan, topology, discipline, callGraph, functionClones, symbols }) {
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
  }

  return lines.length > 0
    ? lines
    : ['- No measured cue lines were available from the provided artifacts. Read `manifest.json` and rerun the relevant profile before making structural claims.'];
}

function artifactMapLines({ manifest, checklistFacts, fixPlan, topology, discipline, callGraph, functionClones, symbols }) {
  const produced = Array.isArray(manifest?.artifactsProduced) ? new Set(manifest.artifactsProduced) : new Set();
  const lines = [];

  lines.push('- `manifest.json`: scan range, confidence, blind zones, and command status.');
  if (symbols || produced.has('symbols.json')) {
    lines.push('- `symbols.json`: export identities, total/type/value fan-in, dependency import consumers, public owner facts, unresolved internal reason summaries, and identity-level anyContamination owner maps.');
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
    lines.push('- `function-clones.json`: exported top-level function-body clone cues; candidates require source review before merge advice.');
  }
  if (produced.has('barrels.json')) {
    lines.push('- `barrels.json`: barrel discipline evidence for full-profile C7 review.');
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
  lines.push(...measuredCueLines({ manifest, checklistFacts, fixPlan, topology, discipline, callGraph, functionClones, symbols }));
  lines.push('');

  lines.push('## Artifact Map', '');
  lines.push(...artifactMapLines({ manifest, checklistFacts, fixPlan, topology, discipline, callGraph, functionClones, symbols }));
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
