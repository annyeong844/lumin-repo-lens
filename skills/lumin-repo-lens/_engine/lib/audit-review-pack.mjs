// Full-review pack renderer.
//
// The audit engine writes durable JSON facts. This renderer turns the full
// profile's richer artifact set into reviewer lanes. It does not replace
// raw artifacts and does not call any API by itself. In Claude Code, the
// controller model reads these lanes as artifact briefs. If it uses
// built-in reviewer subagents, it must translate lane cues into focused
// codebase-reading assignments; the subagent should inspect files directly.

import { formatAnyContaminationReviewCheck } from './any-contamination-summary.mjs';

function n(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function scanRange(manifest) {
  const sr = manifest?.scanRange ?? {};
  const langs = arr(sr.languages).length > 0 ? sr.languages.join(', ') : 'unknown';
  const tests = sr.includeTests === false ? 'production only' : 'includes tests';
  return `${sr.files ?? 'unknown'} files; ${langs}; ${tests}`;
}

function lane(title, body) {
  return [
    `## ${title}`,
    '',
    body.trim(),
    '',
  ].join('\n');
}

function renderLanePrompt({ title, mission, artifacts, checks, report }) {
  return [
    `Controller-only lane. Read this in the main context as an artifact brief; do not paste the lane wholesale into a subagent.`,
    ``,
    `Role: ${title}`,
    ``,
    `Mission: ${mission}`,
    ``,
    `Artifacts for the controller to inspect first: ${artifacts.join(', ')}`,
    ``,
    `Checks to convert into code questions:`,
    ...checks.map((check) => `- ${check}`),
    ``,
    `Report back with: ${report}`,
    ``,
    `Subagent rule: if you dispatch a reviewer subagent, give it specific files, symbols, or hypotheses from this lane and ask it to read the codebase with file:line evidence. Do not ask the subagent to trust checklist or artifact summaries.`,
    ``,
    `Rules: cite artifact fields or file:line evidence; do not turn a gate value into a verdict; mark unknowns as "not enough evidence yet"; keep recommendations to the smallest useful slice.`,
  ].join('\n');
}

function topologyLane({ topology, callGraph, barrels }) {
  const sccCount = n(topology?.summary?.sccCount, arr(topology?.sccs).length);
  const semiDead = n(callGraph?.summary?.semiDead, arr(callGraph?.semiDeadList).length);
  const barrelKeys = barrels && typeof barrels === 'object'
    ? Object.keys(barrels).slice(0, 4).join(', ')
    : 'unknown';
  return lane('Lane 1 — Topology And Flow Review', renderLanePrompt({
    title: 'Topology reviewer',
    mission: 'Find cross-file structure risks the short summary might hide: runtime cycles, one-way boundary breaks, barrel amplification, and semi-dead import clusters.',
    artifacts: ['manifest.json', 'topology.json', 'call-graph.json', 'barrels.json'],
    checks: [
      `Runtime SCC count from topology: ${sccCount}. If non-zero, inspect the largest SCC before any local cleanup.`,
      `Semi-dead import count from call graph: ${semiDead}. Screen framework/test conventions before calling an import removable.`,
      `Barrel evidence present: ${yesNo(!!barrels)} (${barrelKeys}). Treat barrel findings as review cues, not automatic refactors.`,
    ],
    report: 'Already stable boundary facts, top one or two cross-file risks, and the smallest verification command after a fix.',
  }));
}

function typeLane({ discipline, checklistFacts, shapeIndex, functionClones, symbols }) {
  const totals = discipline?.totals ?? {};
  const escapeCount =
    n(totals[':any']) +
    n(totals['as any']) +
    n(totals['as unknown as']) +
    n(totals['@ts-ignore']) +
    n(totals['@ts-expect-error']) +
    n(totals['@ts-nocheck']) +
    n(totals['jsdoc-any']);
  const exactGroups = n(checklistFacts?.B1B2_shape_drift?.exactDuplicateGroups, 0);
  const nearCandidates = n(checklistFacts?.B1B2_shape_drift?.nearShapeCandidateCount, 0);
  const shapeFacts = n(shapeIndex?.facts?.length, 0);
  const cloneExact = n(checklistFacts?.B1_duplicate_implementation?.exactBodyGroups, n(functionClones?.meta?.exactBodyGroupCount));
  const cloneStructure = n(checklistFacts?.B1_duplicate_implementation?.structureGroupCandidates, n(functionClones?.meta?.structureGroupCount));
  const cloneNear = n(checklistFacts?.B1_duplicate_implementation?.nearFunctionCandidates, n(functionClones?.meta?.nearFunctionCandidateCount));
  return lane('Lane 2 — Types, Shapes, And Contract Review', renderLanePrompt({
    title: 'Type and shape reviewer',
    mission: 'Look for type-boundary and helper-shape drift that requires semantic judgment: repeated exported shapes, same-structure and near-function clone cues, and concentrated any/ignore-style escapes.',
    artifacts: ['discipline.json', 'shape-index.json', 'function-clones.json', 'checklist-facts.json', 'symbols.json'],
    checks: [
      `Type escape total to screen: ${escapeCount}. Prioritize clusters over scattered one-offs.`,
      formatAnyContaminationReviewCheck(symbols),
      `Exact exported shape groups: ${exactGroups}; near-shape review cues: ${nearCandidates}; raw shape facts: ${shapeFacts}.`,
      `Function clone cues: exact body groups ${cloneExact}; same-structure groups ${cloneStructure}; near-function cues ${cloneNear}. Read source before calling them semantic duplicates.`,
      'For near-shape or semantic duplication, read the cited declarations before recommending a merge.',
    ],
    report: 'One type/shape theme worth smoothing, anything likely intentional, and what evidence is still missing.',
  }));
}

function deadSurfaceLane({ fixPlan, deadClassify }) {
  const summary = fixPlan?.summary ?? {};
  const safe = n(summary.SAFE_FIX);
  const review = n(summary.REVIEW_FIX);
  const degraded = n(summary.DEGRADED);
  const muted = n(summary.MUTED);
  const excluded = deadClassify?.summary?.excluded ?? {};
  const excludedText = Object.entries(excluded)
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ') || 'none recorded';
  return lane('Lane 3 — Dead Export And Public Surface Review', renderLanePrompt({
    title: 'Dead-export/public-surface reviewer',
    mission: 'Separate real cleanup from public surface, declaration/type-surface, framework, generated, config, and test-consumer false positives.',
    artifacts: ['fix-plan.json', 'dead-classify.json', 'symbols.json', 'manifest.json'],
    checks: [
      `Tier summary: SAFE_FIX ${safe}, REVIEW_FIX ${review}, DEGRADED ${degraded}, MUTED ${muted}. Do not present REVIEW_FIX as removable without screening.`,
      `Muted/excluded families observed: ${excludedText}. Translate them into plain language for the user.`,
      'For each visible cleanup candidate, check whether it is exported through package/API/declaration/test-only surfaces before recommending a change.',
    ],
    report: 'Which candidates are safe to leave alone, which need review together, and at most one action-ready cleanup slice.',
  }));
}

function failureLane({ checklistFacts, manifest }) {
  const e2 = checklistFacts?.E2_silent_catch ?? {};
  const blindZones = arr(manifest?.blindZones);
  return lane('Lane 4 — Failure Handling And Blind-Zone Review', renderLanePrompt({
    title: 'Failure-handling reviewer',
    mission: 'Check whether error-handling and measurement blind zones could make the main summary too optimistic.',
    artifacts: ['checklist-facts.json', 'manifest.json', 'discipline.json'],
    checks: [
      `Silent catch count: ${n(e2.count)}; non-empty anonymous catches: ${n(e2.nonEmptyAnonymousCount)}; unused catch params: ${n(e2.unusedParamCount)}.`,
      `Blind zones recorded in manifest: ${blindZones.length}. Treat any blind zone as a limit on absence/removal claims.`,
      'If a catch pattern is intentional, recommend documenting the intent rather than changing behavior blindly.',
    ],
    report: 'Failure-handling strengths, one watch item if present, and exact limits on what this audit could not prove.',
  }));
}

export function renderAuditReviewPack({
  manifest = null,
  checklistFacts = null,
  fixPlan = null,
  topology = null,
  discipline = null,
  callGraph = null,
  barrels = null,
  shapeIndex = null,
  functionClones = null,
  deadClassify = null,
  symbols = null,
} = {}) {
  const lines = [
    '# Audit Review Pack',
    '',
    'Use this pack for full/deep repo review. It is a main-controller artifact brief, not a replacement for raw artifacts and not a subagent prompt.',
    '',
    `Scan range: ${scanRange(manifest)}.`,
    '',
    'Controller rule: this file never calls external APIs or models. In Claude Code, the main assistant reads these lanes and decides whether the review needs built-in reviewer subagents. Use subagents for explicit full/deep/exhaustive review or when several independent code areas need a fresh pass; read locally for ordinary short chat answers.',
    '',
    'Recommended default for a full audit: read lanes 1-4 before finalizing the normal gentle summary. If using Claude Code subagents, translate each chosen lane into a codebase-reading assignment with concrete files, symbols, or hypotheses. Do not paste artifact/checklist lanes wholesale; the subagent should inspect code directly and report file:line evidence.',
    '',
    topologyLane({ topology, callGraph, barrels }),
    typeLane({ discipline, checklistFacts, shapeIndex, functionClones, symbols }),
    deadSurfaceLane({ fixPlan, deadClassify }),
    failureLane({ checklistFacts, manifest }),
    '## Merge Instructions',
    '',
    '- Combine reviewer reports into at most three user-facing next actions.',
    '- Preserve "Keep As-Is" decisions so low-ranked findings do not disappear.',
    '- If reviewer lanes disagree, say what evidence differs instead of averaging their conclusions.',
    '- Keep raw field paths in reserve unless the user asks for proof.',
    '',
  ];
  return lines.join('\n');
}
