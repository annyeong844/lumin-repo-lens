// _lib/check-canon-helpers.mjs
//
// P5-2 — helper-registry drift engine.
//
// Consumes:
//   - canonical/helper-registry.md via loadHelperRegistryCanon.
//   - fresh AST pass via collectHelperIdentities (P3-2's leaf collector).
//
// Produces:
//   - helper-drift records per canon-drift.md §3.1 (5 categories).
//   - per-source Markdown report with §4.1 shape (p5-2.md).
//
// Differ algorithm (p5-2.md §4.5 first-match-wins + evidence-gated):
//   1. identity-based set diff → helper-added / helper-removed.
//   2. same-identity different label → dispatch:
//        (a) contamination label involved AND helperContamination === 'available'
//              → contamination-changed (content-shifted)
//        (b) both labels are fan-in tier labels → fan-in-tier-changed
//        (c) else → label-changed
//   3. NO 1:1 owner-change upgrade (canon-drift §3.1 has no helper-owner-changed).
//
// Collector diagnostic promotion (p5-2.md §4.6):
//   - `kind: 'parse-error'` → status=parse-error, drifts=[], reportMarkdown=null.
//   - `kind: 'helper-contamination-enrichment-unavailable'` synthetic advisory
//     when meta.helperContamination !== 'available'. Does NOT promote status.
//   - Other kinds (call-graph-cross-check, etc.) → advisory passthrough.

import {
  collectHelperIdentities,
  classifyHelperIdentity,
  classifyHelperGroup,
} from './canon-draft-helpers.mjs';
import { loadHelperRegistryCanon } from './check-canon-artifact.mjs';
import { makeDriftRecord } from './check-canon-utils.mjs';

const CONTAMINATION_HELPER_LABELS = new Set([
  'severely-any-contaminated-helper',
  'ANY_COLLISION_HELPER',
]);
const FAN_IN_TIER_HELPER_LABELS = new Set([
  'zero-internal-fan-in-helper',
  'shared-helper',
  'central-helper',
]);

function classifyFreshHelperRecords({ helperDefsByIdentity, helpersByName }) {
  const freshByIdentity = new Map();
  for (const [name, identities] of helpersByName) {
    if (identities.length >= 2) {
      const fanInByIdentity = {};
      const contaminationByIdentity = {};
      for (const id of identities) {
        const def = helperDefsByIdentity.get(id);
        fanInByIdentity[id] = def.fanIn ?? 0;
        if (def.anyContamination) contaminationByIdentity[id] = def.anyContamination;
      }
      const group = classifyHelperGroup({ name, identities, fanInByIdentity, contaminationByIdentity });
      for (const id of identities) {
        const def = helperDefsByIdentity.get(id);
        freshByIdentity.set(id, {
          identity: id,
          exportedName: name,
          ownerFile: def.ownerFile,
          owner: `${def.ownerFile}:${def.line}`,
          fanIn: def.fanIn ?? 0,
          label: group.label,
        });
      }
    } else {
      const id = identities[0];
      const def = helperDefsByIdentity.get(id);
      const single = classifyHelperIdentity({
        identity: id,
        fanIn: def.fanIn ?? 0,
        contamination: def.anyContamination,
        exportedName: name,
      });
      freshByIdentity.set(id, {
        identity: id,
        exportedName: name,
        ownerFile: def.ownerFile,
        owner: `${def.ownerFile}:${def.line}`,
        fanIn: def.fanIn ?? 0,
        label: single.label,
      });
    }
  }
  return freshByIdentity;
}

function dispatchLabelChangeCategory(canonLabel, freshLabel, perIdentityEvidence) {
  const contaminationInvolved =
    CONTAMINATION_HELPER_LABELS.has(canonLabel) ||
    CONTAMINATION_HELPER_LABELS.has(freshLabel);
  // Evidence gate is PER-IDENTITY: contamination-changed fires only when
  // this specific identity has a helperOwnersByIdentity entry. A repo-wide
  // `meta.helperContamination === 'available'` flag is insufficient — it
  // can be true while unrelated helpers carry evidence and the drift
  // identity does not. Reviewer Finding #1 (2026-04-22).
  if (contaminationInvolved && perIdentityEvidence) {
    return 'contamination-changed';
  }
  if (!contaminationInvolved &&
      FAN_IN_TIER_HELPER_LABELS.has(canonLabel) &&
      FAN_IN_TIER_HELPER_LABELS.has(freshLabel)) {
    return 'fan-in-tier-changed';
  }
  return 'label-changed';
}

function diffHelperRecords(canonByIdentity, freshByIdentity, helperOwnersByIdentity) {
  const drifts = [];
  // Pass 1: identity-based. Added / removed / label-change categorization.
  for (const [id, canon] of canonByIdentity) {
    const fresh = freshByIdentity.get(id);
    if (!fresh) {
      drifts.push(makeDriftRecord({
        kind: 'helper-drift',
        category: 'helper-removed',
        identity: id,
        canon: {
          file: 'canonical/helper-registry.md',
          line: canon.line,
          label: canon.label,
          owner: canon.owner,
          fanIn: canon.fanIn,
          anyUnknownSignal: canon.anyUnknownSignal ?? '',
        },
        confidence: 'high',
      }));
      continue;
    }
    if (canon.label !== fresh.label) {
      // Per-identity evidence gate (Finding #1): only THIS identity's
      // helperOwnersByIdentity entry counts. Unrelated helpers' entries
      // must not authorize this identity's contamination-changed.
      const perIdentityEvidence = !!(helperOwnersByIdentity && helperOwnersByIdentity[id]);
      const category = dispatchLabelChangeCategory(canon.label, fresh.label, perIdentityEvidence);
      drifts.push(makeDriftRecord({
        kind: 'helper-drift',
        category,
        identity: id,
        canon: {
          file: 'canonical/helper-registry.md',
          line: canon.line,
          label: canon.label,
          owner: canon.owner,
          fanIn: canon.fanIn,
          anyUnknownSignal: canon.anyUnknownSignal ?? '',
        },
        fresh: {
          label: fresh.label,
          owner: fresh.owner,
          fanIn: fresh.fanIn,
          // Finding #2: fresh-side contamination signal. Derived from
          // helperOwnersByIdentity[id].anyContamination when the evidence
          // exists; otherwise the empty string (absence of evidence, not
          // proof of "clean").
          anyUnknownSignal: deriveFreshAnyUnknownSignal(helperOwnersByIdentity, id),
        },
        confidence: 'high',
      }));
    }
  }
  for (const [id, fresh] of freshByIdentity) {
    if (!canonByIdentity.has(id)) {
      drifts.push(makeDriftRecord({
        kind: 'helper-drift',
        category: 'helper-added',
        identity: id,
        fresh: {
          label: fresh.label,
          owner: fresh.owner,
          fanIn: fresh.fanIn,
          anyUnknownSignal: deriveFreshAnyUnknownSignal(helperOwnersByIdentity, id),
        },
        confidence: 'high',
      }));
    }
  }
  return drifts;
}

function deriveFreshAnyUnknownSignal(helperOwnersByIdentity, identity) {
  const fact = helperOwnersByIdentity && helperOwnersByIdentity[identity];
  if (!fact) return '';
  const c = fact.anyContamination;
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (typeof c === 'object' && typeof c.label === 'string') return c.label;
  return 'any-contaminated';
}

function renderDriftMarkdown({ drifts, canonPath, canonLineCount }) {
  const lines = [];
  lines.push('# Helper-registry canon drift');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Canon file: ${canonPath}`);
  lines.push(`Canon line count: ${canonLineCount}`);
  lines.push(`Drift count: ${drifts.length}`);
  lines.push('');

  const byCat = {
    'helper-added':         drifts.filter((d) => d.category === 'helper-added'),
    'helper-removed':       drifts.filter((d) => d.category === 'helper-removed'),
    'label-changed':        drifts.filter((d) => d.category === 'label-changed'),
    'contamination-changed': drifts.filter((d) => d.category === 'contamination-changed'),
    'fan-in-tier-changed':  drifts.filter((d) => d.category === 'fan-in-tier-changed'),
  };

  lines.push('## 1. Summary');
  lines.push('');
  lines.push('| Category | Family | Count |');
  lines.push('|----------|--------|------:|');
  lines.push(`| helper-added           | added            | ${byCat['helper-added'].length} |`);
  lines.push(`| helper-removed         | removed          | ${byCat['helper-removed'].length} |`);
  lines.push(`| label-changed          | label-changed    | ${byCat['label-changed'].length} |`);
  lines.push(`| contamination-changed  | content-shifted  | ${byCat['contamination-changed'].length} |`);
  lines.push(`| fan-in-tier-changed    | label-changed    | ${byCat['fan-in-tier-changed'].length} |`);
  lines.push('');

  let section = 2;
  if (byCat['helper-added'].length > 0) {
    lines.push(`## ${section}. helper-added`);
    lines.push('');
    lines.push('| Identity | Fresh owner | Fresh label | Fresh fan-in | Confidence |');
    lines.push('|----------|-------------|-------------|-------------:|------------|');
    for (const d of byCat['helper-added']) {
      lines.push(`| \`${d.identity}\` | \`${d.fresh.owner}\` | \`${d.fresh.label}\` | ${d.fresh.fanIn} | ${d.confidence} |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['helper-removed'].length > 0) {
    lines.push(`## ${section}. helper-removed`);
    lines.push('');
    lines.push('| Identity | Canon owner | Canon label | Canon fan-in | Canon line | Confidence |');
    lines.push('|----------|-------------|-------------|-------------:|-----------:|------------|');
    for (const d of byCat['helper-removed']) {
      lines.push(`| \`${d.identity}\` | \`${d.canon.owner}\` | \`${d.canon.label}\` | ${d.canon.fanIn} | ${d.canon.line} | ${d.confidence} |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['label-changed'].length > 0) {
    lines.push(`## ${section}. label-changed`);
    lines.push('');
    lines.push('| Identity | Canon label | Fresh label | Canon fan-in | Fresh fan-in | Canon line |');
    lines.push('|----------|-------------|-------------|-------------:|-------------:|-----------:|');
    for (const d of byCat['label-changed']) {
      lines.push(`| \`${d.identity}\` | \`${d.canon.label}\` | \`${d.fresh.label}\` | ${d.canon.fanIn} | ${d.fresh.fanIn} | ${d.canon.line} |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['contamination-changed'].length > 0) {
    lines.push(`## ${section}. contamination-changed`);
    lines.push('');
    // Per spec p5-2.md §4.1: contamination section surfaces the "Any /
    // unknown signal" evidence on both sides, not fan-in. fan-in evidence
    // for contamination transitions is carried in the JSON record but is
    // not load-bearing for the contamination narrative.
    lines.push('| Identity | Canon label | Fresh label | Canon signal | Fresh signal | Canon line |');
    lines.push('|----------|-------------|-------------|--------------|--------------|-----------:|');
    for (const d of byCat['contamination-changed']) {
      const canonSig = (d.canon.anyUnknownSignal ?? '').trim() || '—';
      const freshSig = (d.fresh.anyUnknownSignal ?? '').trim() || '—';
      lines.push(`| \`${d.identity}\` | \`${d.canon.label}\` | \`${d.fresh.label}\` | ${canonSig} | ${freshSig} | ${d.canon.line} |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['fan-in-tier-changed'].length > 0) {
    lines.push(`## ${section}. fan-in-tier-changed`);
    lines.push('');
    lines.push('| Identity | Canon tier | Fresh tier | Canon fan-in | Fresh fan-in | Canon line |');
    lines.push('|----------|------------|------------|-------------:|-------------:|-----------:|');
    for (const d of byCat['fan-in-tier-changed']) {
      lines.push(`| \`${d.identity}\` | \`${d.canon.label}\` | \`${d.fresh.label}\` | ${d.canon.fanIn} | ${d.fresh.fanIn} | ${d.canon.line} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function detectHelperRegistryDrift({ canonPath, scanContext, canonLabelSet, loader }) {
  const load = loader ?? loadHelperRegistryCanon;
  const canonResult = load({ canonPath, canonLabelSet });
  if (canonResult.status !== 'clean') {
    return {
      drifts: [],
      status: canonResult.status,
      diagnostics: canonResult.diagnostics ?? [],
      reportMarkdown: null,
      canonLineCount: canonResult.lineCount ?? 0,
    };
  }

  const collected = collectHelperIdentities(scanContext);
  const collectorDiagnostics = collected.diagnostics ?? [];
  const fatalParseErrors = collectorDiagnostics.filter((d) => d.kind === 'parse-error');

  // §4.6: extractor-throw parse-error promotes to source-level parse-error.
  if (fatalParseErrors.length > 0) {
    return {
      drifts: [],
      status: 'parse-error',
      diagnostics: [
        ...(canonResult.diagnostics ?? []),
        ...collectorDiagnostics,
      ],
      reportMarkdown: null,
      canonLineCount: canonResult.lineCount ?? 0,
    };
  }

  const helperOwnersByIdentity = scanContext.symbols?.helperOwnersByIdentity ?? null;
  const helperContaminationRunLevel = collected.meta?.helperContamination === 'available';

  const diagnostics = [
    ...(canonResult.diagnostics ?? []),
    ...collectorDiagnostics,
  ];
  // Run-level advisory: fires when NO identity in the repo has a
  // helperOwnersByIdentity fact. Per-identity evidence gate (Finding #1)
  // handles the finer-grained case; this diagnostic remains as a hint
  // for operators that the current producer emits zero contamination
  // enrichment.
  if (!helperContaminationRunLevel) {
    diagnostics.unshift({
      kind: 'helper-contamination-enrichment-unavailable',
      reason: 'symbols.helperOwnersByIdentity absent or empty — fresh-side contamination detection disabled; contamination transitions downgrade to label-changed',
    });
  }

  const freshByIdentity = classifyFreshHelperRecords(collected);
  const drifts = diffHelperRecords(canonResult.records, freshByIdentity, helperOwnersByIdentity);

  const reportMarkdown = renderDriftMarkdown({
    drifts,
    canonPath,
    canonLineCount: canonResult.lineCount ?? 0,
  });

  return {
    drifts,
    status: drifts.length > 0 ? 'drift' : 'clean',
    diagnostics,
    reportMarkdown,
    canonLineCount: canonResult.lineCount ?? 0,
  };
}
