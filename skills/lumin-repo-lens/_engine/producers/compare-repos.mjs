#!/usr/bin/env node
// Artifact-level repo comparison. Does NOT walk source trees — reads
// whatever audit artifacts exist in `--left` and `--right` output
// directories and diffs them.
//
//   node compare-repos.mjs \
//     --left  /tmp/audit-a \
//     --right /tmp/audit-b \
//     --output /tmp/compare
//
// Design note (v1.9.8): this is deliberately a thin merge-and-delta
// script, not a re-analysis. The audit pipelines for both repos must
// already have been run — compare-repos consumes their outputs. This
// keeps the tool's philosophy intact: evidence comes from the
// pipeline, this just shows what changed. A heavier implementation
// that ran the pipeline internally would hide the scan-range /
// confidence metadata that matters for claim-scoping.
//
// Output shape:
//   {
//     left:  { label, artifactsFound: [...], summaries: {...} },
//     right: { label, artifactsFound: [...], summaries: {...} },
//     deltas: { files, loc, runtimeSccs, safeFixes, reviewFixes,
//               degraded, muted, unresolvedInternalRatio, ... },
//     missingArtifacts: { left: [...], right: [...] }
//   }

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadIfExists as loadArtifact } from '../lib/artifacts.mjs';

const { values } = parseArgs({
  options: {
    left:    { type: 'string' },
    right:   { type: 'string' },
    output:  { type: 'string', short: 'o' },
    'left-label':  { type: 'string' },
    'right-label': { type: 'string' },
  },
  strict: false,
});

if (!values.left || !values.right) {
  console.error('usage: compare-repos.mjs --left <dir> --right <dir> [--output <dir>] [--left-label NAME] [--right-label NAME]');
  process.exit(1);
}

const LEFT = path.resolve(values.left);
const RIGHT = path.resolve(values.right);
const OUT = path.resolve(values.output ?? path.join(process.cwd(), 'compare-output'));
const leftLabel = values['left-label'] ?? path.basename(LEFT);
const rightLabel = values['right-label'] ?? path.basename(RIGHT);

mkdirSync(OUT, { recursive: true });

const loadIfExists = (dir, name) => loadArtifact(dir, name, { tag: 'compare' });

// The artifacts we know how to summarize. Anything not in this list
// won't contribute to the summary (but its presence/absence is still
// tracked).
const KNOWN_ARTIFACTS = [
  'triage.json',
  'topology.json',
  'discipline.json',
  'symbols.json',
  'dead-classify.json',
  'runtime-evidence.json',
  'staleness.json',
  'fix-plan.json',
  'call-graph.json',
  'barrels.json',
];

function summarizeSide(dir, label) {
  const summaries = {};
  const artifactsFound = [];

  const triage = loadIfExists(dir, 'triage.json');
  if (triage) {
    artifactsFound.push('triage.json');
    summaries.triage = {
      files: triage.summary?.files ?? triage.files ?? null,
      loc: triage.summary?.loc ?? triage.loc ?? null,
      buildSystem: triage.buildSystem ?? triage.summary?.buildSystem ?? null,
    };
  }

  const topology = loadIfExists(dir, 'topology.json');
  if (topology) {
    artifactsFound.push('topology.json');
    const s = topology.summary ?? topology;
    summaries.topology = {
      files: s.files ?? null,
      edges: s.edges ?? null,
      sccCount: s.sccCount ?? null,
      typeOnlyEdges: s.typeOnlyEdges ?? null,
    };
  }

  const symbols = loadIfExists(dir, 'symbols.json');
  if (symbols) {
    artifactsFound.push('symbols.json');
    summaries.symbols = {
      files: symbols.files ?? null,
      totalDefs: symbols.totalDefs ?? null,
      deadInProd: symbols.deadInProd ?? null,
      // v1.9.7 FP-36 counters — only present on post-1.9.7 artifacts
      resolvedInternal: symbols.uses?.resolvedInternal ?? null,
      external: symbols.uses?.external ?? null,
      unresolvedInternal: symbols.uses?.unresolvedInternal ?? null,
      unresolvedInternalRatio: symbols.uses?.unresolvedInternalRatio ?? null,
    };
  }

  const deadClassify = loadIfExists(dir, 'dead-classify.json');
  if (deadClassify) {
    artifactsFound.push('dead-classify.json');
    summaries.deadClassify = {
      categoryC: deadClassify.summary?.category_C ?? null,
      categoryA: deadClassify.summary?.category_A ?? null,
      categoryB: deadClassify.summary?.category_B ?? null,
      excluded: deadClassify.summary?.excluded ?? null,
    };
  }

  const fixPlan = loadIfExists(dir, 'fix-plan.json');
  if (fixPlan) {
    artifactsFound.push('fix-plan.json');
    summaries.fixPlan = {
      SAFE_FIX: fixPlan.summary?.SAFE_FIX ?? null,
      REVIEW_FIX: fixPlan.summary?.REVIEW_FIX ?? null,
      DEGRADED: fixPlan.summary?.DEGRADED ?? null,
      MUTED: fixPlan.summary?.MUTED ?? null,
      total: fixPlan.summary?.total ?? null,
      resolverBlindnessGate: fixPlan.meta?.resolverBlindness?.gate ?? null,
    };
  }

  for (const name of ['runtime-evidence.json', 'staleness.json',
                      'discipline.json', 'call-graph.json', 'barrels.json']) {
    if (existsSync(path.join(dir, name))) artifactsFound.push(name);
  }

  return { label, artifactsFound, summaries };
}

const leftSide = summarizeSide(LEFT, leftLabel);
const rightSide = summarizeSide(RIGHT, rightLabel);

// ─── Build deltas ─────────────────────────────────────────
function num(v) { return typeof v === 'number' ? v : null; }
function delta(l, r) {
  if (num(l) === null || num(r) === null) return null;
  return r - l;
}

const deltas = {
  files: delta(leftSide.summaries.triage?.files, rightSide.summaries.triage?.files),
  loc: delta(leftSide.summaries.triage?.loc, rightSide.summaries.triage?.loc),
  totalDefs: delta(leftSide.summaries.symbols?.totalDefs, rightSide.summaries.symbols?.totalDefs),
  deadInProd: delta(leftSide.summaries.symbols?.deadInProd, rightSide.summaries.symbols?.deadInProd),
  runtimeSccs: delta(leftSide.summaries.topology?.sccCount, rightSide.summaries.topology?.sccCount),
  typeOnlyEdges: delta(leftSide.summaries.topology?.typeOnlyEdges, rightSide.summaries.topology?.typeOnlyEdges),
  safeFixes: delta(leftSide.summaries.fixPlan?.SAFE_FIX, rightSide.summaries.fixPlan?.SAFE_FIX),
  reviewFixes: delta(leftSide.summaries.fixPlan?.REVIEW_FIX, rightSide.summaries.fixPlan?.REVIEW_FIX),
  degraded: delta(leftSide.summaries.fixPlan?.DEGRADED, rightSide.summaries.fixPlan?.DEGRADED),
  muted: delta(leftSide.summaries.fixPlan?.MUTED, rightSide.summaries.fixPlan?.MUTED),
  unresolvedInternalRatio: delta(
    leftSide.summaries.symbols?.unresolvedInternalRatio,
    rightSide.summaries.symbols?.unresolvedInternalRatio,
  ),
};

const missingFromLeft = KNOWN_ARTIFACTS.filter((a) => !leftSide.artifactsFound.includes(a));
const missingFromRight = KNOWN_ARTIFACTS.filter((a) => !rightSide.artifactsFound.includes(a));

const result = {
  meta: {
    generated: new Date().toISOString(),
    tool: 'compare-repos.mjs',
    left: LEFT, right: RIGHT,
  },
  left: leftSide,
  right: rightSide,
  deltas,
  missingArtifacts: {
    left: missingFromLeft,
    right: missingFromRight,
    note: 'Deltas involving an artifact missing from either side will be null. Run the full pipeline on both sides for complete comparison.',
  },
};

const outPath = path.join(OUT, 'compare.json');
writeFileSync(outPath, JSON.stringify(result, null, 2));

// ─── Console report ──────────────────────────────────────
console.log('\n══════ audit-artifact compare ══════');
console.log(`  left:  ${leftLabel}  (${leftSide.artifactsFound.length} artifacts)`);
console.log(`  right: ${rightLabel}  (${rightSide.artifactsFound.length} artifacts)`);
console.log('');
const rows = [
  ['files', deltas.files],
  ['loc', deltas.loc],
  ['totalDefs', deltas.totalDefs],
  ['deadInProd', deltas.deadInProd],
  ['runtime SCCs', deltas.runtimeSccs],
  ['SAFE_FIX', deltas.safeFixes],
  ['REVIEW_FIX', deltas.reviewFixes],
  ['DEGRADED', deltas.degraded],
  ['MUTED', deltas.muted],
];
for (const [label, v] of rows) {
  if (v === null) console.log(`  ${label.padEnd(14)} : (missing on one side)`);
  else console.log(`  ${label.padEnd(14)} : ${v >= 0 ? '+' : ''}${v}`);
}
if (missingFromLeft.length || missingFromRight.length) {
  console.log('');
  if (missingFromLeft.length)
    console.log(`  missing on left (${leftLabel}):  ${missingFromLeft.join(', ')}`);
  if (missingFromRight.length)
    console.log(`  missing on right (${rightLabel}): ${missingFromRight.join(', ')}`);
}
console.log(`\n[compare] saved → ${outPath}`);
