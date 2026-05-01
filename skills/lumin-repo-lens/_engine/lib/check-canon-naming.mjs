// _lib/check-canon-naming.mjs
//
// P5-4 — naming drift engine.
//
// Consumes:
//   - canonical/naming.md via loadNamingCanon (multi-section parser).
//   - fresh AST pass via collectNamingCohorts (P3-4 leaf collector).
//
// Produces:
//   - naming-drift records per canon-drift.md §3.1 (5 categories):
//     cohort-added / cohort-removed / cohort-convention-shifted /
//     new-outlier-introduced / outlier-resolved.
//   - per-source Markdown report.
//
// Differ algorithm (p5-4.md §4.5):
//   1. Sub-diff 1 — Cohorts: set diff on file + symbol cohort identity
//      keyspaces (PF-4 distinct identities). Both-side: dominantConvention
//      or label mismatch → cohort-convention-shifted.
//   2. Sub-diff 2 — Outliers: set diff on per-item outlier identity.
//
// Identity format (canon-drift.md §4 / p5-4.md PF-4):
//   - file cohort       → <submodule>
//   - symbol cohort     → <submodule>::<kind>   (kind ∈ type|helper|constant-export)
//   - file outlier      → <ownerFile>
//   - symbol outlier    → <ownerFile>::<exportedName>

import {
  collectNamingCohorts,
} from './canon-draft-naming.mjs';
import { loadNamingCanon } from './check-canon-artifact.mjs';
import { makeDriftRecord } from './check-canon-utils.mjs';

function classifyFreshNamingRecords(collected) {
  // Fresh collector returns `fileCohorts`, `symbolCohorts`, `perItemRows`.
  // Classifier-in-place is already applied by collectNamingCohorts itself;
  // we only need to project into lookup-by-identity Maps here.
  const fileCohortsByIdentity = new Map();
  for (const cohort of collected.fileCohorts.values()) {
    fileCohortsByIdentity.set(cohort.cohortId, {
      identity: cohort.cohortId,
      dominantConvention: cohort.classification?.dominantConvention ?? null,
      label: cohort.classification?.label ?? 'insufficient-evidence',
      members: cohort.members.length,
    });
  }
  const symbolCohortsByIdentity = new Map();
  for (const cohort of collected.symbolCohorts.values()) {
    symbolCohortsByIdentity.set(cohort.cohortId, {
      identity: cohort.cohortId,
      dominantConvention: cohort.classification?.dominantConvention ?? null,
      label: cohort.classification?.label ?? 'insufficient-evidence',
      members: cohort.members.length,
    });
  }
  // Outliers: classifier marks item rows with itemLabel === 'convention-outlier'.
  const outliersByIdentity = new Map();
  for (const row of collected.perItemRows ?? []) {
    if (row.itemLabel !== 'convention-outlier') continue;
    // perItemRow shape: { cohortId, identity OR file, name, ... }
    // identity is the file path OR ownerFile::exportedName depending on cohort.
    const id = row.identity ?? row.file ?? null;
    if (!id) continue;
    outliersByIdentity.set(id, {
      identity: id,
      cohort: row.cohortId,
      observedConvention: row.observedConvention ?? null,
      dominantConvention: row.dominantConvention ?? null,
    });
  }
  return { fileCohortsByIdentity, symbolCohortsByIdentity, outliersByIdentity };
}

function diffCohortSet(canonMap, freshMap, cohortKind) {
  const drifts = [];
  for (const [id, canon] of canonMap) {
    const fresh = freshMap.get(id);
    if (!fresh) {
      drifts.push(makeDriftRecord({
        kind: 'naming-drift',
        category: 'cohort-removed',
        identity: id,
        canon: {
          file: 'canonical/naming.md',
          line: canon.line,
          label: canon.label,
          dominantConvention: canon.dominantConvention,
          cohortKind,
        },
        confidence: 'high',
      }));
      continue;
    }
    if (canon.dominantConvention !== fresh.dominantConvention ||
        canon.label !== fresh.label) {
      drifts.push(makeDriftRecord({
        kind: 'naming-drift',
        category: 'cohort-convention-shifted',
        identity: id,
        canon: {
          file: 'canonical/naming.md',
          line: canon.line,
          label: canon.label,
          dominantConvention: canon.dominantConvention,
          cohortKind,
        },
        fresh: {
          label: fresh.label,
          dominantConvention: fresh.dominantConvention,
        },
        confidence: 'high',
      }));
    }
  }
  for (const [id, fresh] of freshMap) {
    if (!canonMap.has(id)) {
      drifts.push(makeDriftRecord({
        kind: 'naming-drift',
        category: 'cohort-added',
        identity: id,
        fresh: {
          label: fresh.label,
          dominantConvention: fresh.dominantConvention,
          cohortKind,
        },
        confidence: 'high',
      }));
    }
  }
  return drifts;
}

function diffOutliers(canonOutliers, freshOutliers) {
  const drifts = [];
  for (const [id, canon] of canonOutliers) {
    if (!freshOutliers.has(id)) {
      drifts.push(makeDriftRecord({
        kind: 'naming-drift',
        category: 'outlier-resolved',
        identity: id,
        canon: {
          file: 'canonical/naming.md',
          line: canon.line,
          cohort: canon.cohort,
          observedConvention: canon.observedConvention,
          dominantConvention: canon.dominantConvention,
        },
        confidence: 'high',
      }));
    }
  }
  for (const [id, fresh] of freshOutliers) {
    if (!canonOutliers.has(id)) {
      drifts.push(makeDriftRecord({
        kind: 'naming-drift',
        category: 'new-outlier-introduced',
        identity: id,
        fresh: {
          cohort: fresh.cohort,
          observedConvention: fresh.observedConvention,
          dominantConvention: fresh.dominantConvention,
        },
        confidence: 'high',
      }));
    }
  }
  return drifts;
}

function renderDriftMarkdown({ drifts, canonPath, canonLineCount }) {
  const lines = [];
  lines.push('# Naming canon drift');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Canon file: ${canonPath}`);
  lines.push(`Canon line count: ${canonLineCount}`);
  lines.push(`Drift count: ${drifts.length}`);
  lines.push('');

  const byCat = {
    'cohort-added':               drifts.filter((d) => d.category === 'cohort-added'),
    'cohort-removed':             drifts.filter((d) => d.category === 'cohort-removed'),
    'cohort-convention-shifted':  drifts.filter((d) => d.category === 'cohort-convention-shifted'),
    'new-outlier-introduced':     drifts.filter((d) => d.category === 'new-outlier-introduced'),
    'outlier-resolved':           drifts.filter((d) => d.category === 'outlier-resolved'),
  };

  lines.push('## 1. Summary');
  lines.push('');
  lines.push('| Category | Family | Count |');
  lines.push('|----------|--------|------:|');
  lines.push(`| cohort-added                 | added           | ${byCat['cohort-added'].length} |`);
  lines.push(`| cohort-removed               | removed         | ${byCat['cohort-removed'].length} |`);
  lines.push(`| cohort-convention-shifted    | label-changed   | ${byCat['cohort-convention-shifted'].length} |`);
  lines.push(`| new-outlier-introduced       | content-shifted | ${byCat['new-outlier-introduced'].length} |`);
  lines.push(`| outlier-resolved             | content-shifted | ${byCat['outlier-resolved'].length} |`);
  lines.push('');

  let section = 2;
  if (byCat['cohort-added'].length > 0) {
    lines.push(`## ${section}. cohort-added`);
    lines.push('');
    lines.push('| Cohort identity | Fresh convention | Fresh status |');
    lines.push('|-----------------|------------------|--------------|');
    for (const d of byCat['cohort-added']) {
      lines.push(`| \`${d.identity}\` | \`${d.fresh.dominantConvention ?? '—'}\` | \`${d.fresh.label}\` |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['cohort-removed'].length > 0) {
    lines.push(`## ${section}. cohort-removed`);
    lines.push('');
    lines.push('| Cohort identity | Canon convention | Canon status | Canon line |');
    lines.push('|-----------------|------------------|--------------|-----------:|');
    for (const d of byCat['cohort-removed']) {
      lines.push(`| \`${d.identity}\` | \`${d.canon.dominantConvention ?? '—'}\` | \`${d.canon.label}\` | ${d.canon.line} |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['cohort-convention-shifted'].length > 0) {
    lines.push(`## ${section}. cohort-convention-shifted`);
    lines.push('');
    lines.push('| Cohort identity | Canon convention | Fresh convention | Canon status | Fresh status | Canon line |');
    lines.push('|-----------------|------------------|------------------|--------------|--------------|-----------:|');
    for (const d of byCat['cohort-convention-shifted']) {
      lines.push(`| \`${d.identity}\` | \`${d.canon.dominantConvention ?? '—'}\` | \`${d.fresh.dominantConvention ?? '—'}\` | \`${d.canon.label}\` | \`${d.fresh.label}\` | ${d.canon.line} |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['new-outlier-introduced'].length > 0) {
    lines.push(`## ${section}. new-outlier-introduced`);
    lines.push('');
    lines.push('| Outlier identity | Cohort | Fresh convention | Dominant |');
    lines.push('|------------------|--------|------------------|----------|');
    for (const d of byCat['new-outlier-introduced']) {
      lines.push(`| \`${d.identity}\` | \`${d.fresh.cohort ?? '—'}\` | \`${d.fresh.observedConvention ?? '—'}\` | \`${d.fresh.dominantConvention ?? '—'}\` |`);
    }
    lines.push('');
    section += 1;
  }
  if (byCat['outlier-resolved'].length > 0) {
    lines.push(`## ${section}. outlier-resolved`);
    lines.push('');
    lines.push('| Outlier identity | Cohort | Canon convention | Canon line |');
    lines.push('|------------------|--------|------------------|-----------:|');
    for (const d of byCat['outlier-resolved']) {
      lines.push(`| \`${d.identity}\` | \`${d.canon.cohort ?? '—'}\` | \`${d.canon.observedConvention ?? '—'}\` | ${d.canon.line} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function detectNamingDrift({ canonPath, scanContext, canonLabelSet, loader }) {
  const load = loader ?? loadNamingCanon;
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

  const collected = collectNamingCohorts(scanContext);
  const collectorDiagnostics = collected.diagnostics ?? [];

  // Reviewer Finding #3 (2026-04-22 post-landing): promote extractor-throw
  // diagnostics from the fresh AST pass to source-level parse-error.
  // Mirrors the helper engine's policy — partial fresh set must not flow
  // into the differ; otherwise files whose AST failed contribute zero
  // cohort members and show up as cohort-added/outlier-resolved noise.
  const fatalParseErrors = collectorDiagnostics.filter((d) => d.kind === 'parse-error');
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

  const { fileCohortsByIdentity, symbolCohortsByIdentity, outliersByIdentity } =
    classifyFreshNamingRecords(collected);

  const drifts = [
    ...diffCohortSet(canonResult.fileCohorts, fileCohortsByIdentity, 'file'),
    ...diffCohortSet(canonResult.symbolCohorts, symbolCohortsByIdentity, 'symbol'),
    ...diffOutliers(canonResult.outliers, outliersByIdentity),
  ];

  const reportMarkdown = renderDriftMarkdown({
    drifts,
    canonPath,
    canonLineCount: canonResult.lineCount ?? 0,
  });

  return {
    drifts,
    status: drifts.length > 0 ? 'drift' : 'clean',
    diagnostics: [
      ...(canonResult.diagnostics ?? []),
      ...collectorDiagnostics,
    ],
    reportMarkdown,
    canonLineCount: canonResult.lineCount ?? 0,
  };
}
