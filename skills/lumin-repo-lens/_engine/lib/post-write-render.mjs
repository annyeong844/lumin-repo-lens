// Post-write delta renderer (P2-1 step 2).
//
// Pure functions: renderMarkdown(delta) → string; renderJson(delta) → delta as-is.
// Format per canonical/any-contamination.md §6 Stage 2 and maintainer history notes v3 §4.5.
//
// Summary-line rules (§4.5):
//   Clean           — "No silent new any in the scan range."
//                     (silentNew=0, parities ok, baseline available, both completenesses true)
//   Caveated        — "No silent-new acknowledgements required; delta confidence is limited by <reason-list>."
//                     (silentNew=0 but any clean-condition fails)
//   Acknowledgment  — "silent-new — REQUIRE acknowledgment: N entries listed above."
//                     (silentNew > 0)

import { CANONICAL_ESCAPE_KINDS } from './post-write-delta.mjs';

// Human-readable labels for the "Any delta" block. Column-aligned for
// easy visual scanning. Order matches CANONICAL_ESCAPE_KINDS.
const KIND_LABELS = {
  'explicit-any':            'explicit any',
  'as-any':                  'as any',
  'angle-any':               'angle-any',
  'as-unknown-as-T':         'as unknown as T',
  'rest-any-args':           'rest-any-args',
  'index-sig-any':           'index-sig-any',
  'generic-default-any':     'generic-default-any',
  'ts-ignore':               'ts-ignore',
  'ts-expect-error':         'ts-expect-error',
  'no-explicit-any-disable': 'no-explicit-any-disable',
  'jsdoc-any':               'JSDoc any',
};

const ANY_DELTA_COL_WIDTH = 28;  // enough for the longest label + some space

// ── renderJson ──────────────────────────────────────────────

export function renderJson(delta) {
  return delta;
}

// ── renderMarkdown ──────────────────────────────────────────

export function renderMarkdown(delta) {
  const lines = [];
  lines.push('## post-write delta (canonical/any-contamination §6 Stage 2)');
  lines.push('');

  const capStatus = delta.capabilityParity?.status ?? 'unchecked';

  // Under capability failure, suppress per-occurrence sections entirely.
  // Status lines and summary still render (truth-telling).
  const suppressOccurrences = capStatus === 'mismatch' || capStatus === 'missing';

  if (!suppressOccurrences) {
    renderAnyDeltaBlock(lines, delta);
    renderPlannedSection(lines, delta);
    renderSilentNewSection(lines, delta);
    renderObservedUnbaselinedSection(lines, delta);
    renderPlannedNotObservedSection(lines, delta);
    renderRemovedSection(lines, delta);
  }

  renderFileDelta(lines, delta);
  renderInventoryCompleteness(lines, delta);
  renderStatusLines(lines, delta);
  renderSummary(lines, delta);

  return lines.join('\n') + '\n';
}

// ── "Any delta" block (silent-new counts per kind) ────────────

function renderAnyDeltaBlock(lines, delta) {
  const counts = new Map();
  for (const kind of CANONICAL_ESCAPE_KINDS) counts.set(kind, 0);
  for (const e of delta.entries ?? []) {
    if (e.label === 'silent-new') {
      counts.set(e.escapeKind, (counts.get(e.escapeKind) ?? 0) + 1);
    }
  }
  lines.push('Any delta (silent-new counts):');
  for (const kind of CANONICAL_ESCAPE_KINDS) {
    const label = KIND_LABELS[kind] ?? kind;
    const pad = ' '.repeat(Math.max(1, ANY_DELTA_COL_WIDTH - label.length));
    lines.push(`- ${label}:${pad}+${counts.get(kind) ?? 0}`);
  }
  lines.push('');
}

// ── Section renderers ───────────────────────────────────────

function formatDiagnosticSuffix(entry) {
  if (!entry.diagnostics || entry.diagnostics.length === 0) return '';
  const labels = entry.diagnostics.map((d) => d === 'ambiguous-planned-match' ? 'ambiguous planned-match' : d);
  return ` (${labels.join(', ')})`;
}

function renderPlannedSection(lines, delta) {
  const items = (delta.entries ?? []).filter((e) => e.label === 'planned');
  if (items.length === 0) return;
  lines.push('Planned and observed:');
  items.forEach((e, i) => {
    lines.push(`${i + 1}. ${e.file}:${e.line}  \`${e.codeShape}\`${formatDiagnosticSuffix(e)}`);
    if (e.insideExportedIdentity) {
      lines.push(`   insideExportedIdentity: ${e.insideExportedIdentity}`);
    }
    const reason = e.plannedEntry?.reason ?? '';
    lines.push(`   planned? yes — ${reason}`);
  });
  lines.push('');
}

function renderSilentNewSection(lines, delta) {
  const items = (delta.entries ?? []).filter((e) => e.label === 'silent-new');
  if (items.length === 0) return;
  lines.push('New escape sites (silent-new — REQUIRE acknowledgment):');
  items.forEach((e, i) => {
    lines.push(`${i + 1}. ${e.file}:${e.line}  \`${e.codeShape}\`${formatDiagnosticSuffix(e)}`);
    if (e.insideExportedIdentity) {
      lines.push(`   insideExportedIdentity: ${e.insideExportedIdentity}`);
    }
    lines.push(`   planned? no — reason missing`);
    lines.push(`   [grounded, any-inventory.json.typeEscapes[occurrenceKey=${e.occurrenceKey}] present in after, absent in before]`);
  });
  lines.push('');
}

function renderObservedUnbaselinedSection(lines, delta) {
  const items = (delta.entries ?? []).filter((e) => e.label === 'observed-unbaselined');
  if (items.length === 0) return;
  lines.push('Observed without baseline:');
  items.forEach((e, i) => {
    lines.push(`${i + 1}. ${e.file}:${e.line}  \`${e.codeShape}\`${formatDiagnosticSuffix(e)}`);
    lines.push(`   [확인 불가, reason: before-inventory missing; cannot determine new-vs-existing]`);
  });
  lines.push('');
}

function renderPlannedNotObservedSection(lines, delta) {
  const items = (delta.entries ?? []).filter((e) => e.label === 'planned-not-observed');
  if (items.length === 0) return;
  lines.push('Planned but not observed:');
  items.forEach((e, i) => {
    const p = e.plannedEntry ?? {};
    lines.push(`${i + 1}. planned \`${p.escapeKind}\` at \`${p.locationHint}\` — not observed after write.${formatDiagnosticSuffix(e)}`);
  });
  lines.push('');
}

function renderRemovedSection(lines, delta) {
  const items = (delta.entries ?? []).filter((e) => e.label === 'removed');
  if (items.length === 0) return;
  lines.push('Removed:');
  items.forEach((e, i) => {
    lines.push(`${i + 1}. ${e.file}:${e.line}  \`${e.codeShape}\`  (present in before, absent in after)`);
  });
  lines.push('');
}

// ── File delta ──────────────────────────────────────────────

function renderFileList(lines, title, files) {
  if (!Array.isArray(files) || files.length === 0) return;
  lines.push(`${title}:`);
  files.forEach((file, i) => lines.push(`${i + 1}. ${file}`));
  lines.push('');
}

function renderFileDelta(lines, delta) {
  const fd = delta.fileDelta;
  if (!fd) return;

  lines.push('File delta:');
  if (fd.status !== 'computed') {
    const reason = fd.reason ? ` — ${fd.reason}` : '';
    lines.push(`- status: ${fd.status}${reason}`);
    if (fd.status === 'baseline-missing') {
      lines.push('- unexpected-new cannot be determined without the pre-write file inventory.');
    }
    lines.push('');
    renderFileList(lines, 'Planned but not observed', fd.plannedMissing);
    return;
  }

  const s = fd.summary ?? {};
  lines.push(`- new files: ${s.newFiles ?? 0} (planned ${s.plannedNew ?? 0}, unexpected ${s.unexpectedNew ?? 0})`);
  lines.push(`- removed files: ${s.removed ?? 0}`);
  lines.push(`- planned files observed: ${s.plannedObserved ?? 0}/${fd.plannedFiles?.length ?? 0}`);
  lines.push('');
  renderFileList(lines, 'Unexpected new files', fd.unexpectedNew);
  renderFileList(lines, 'Planned new files', fd.plannedNew);
  renderFileList(lines, 'Planned but not observed', fd.plannedMissing);
}

// ── Inventory completeness ─────────────────────────────────

function renderInventoryCompleteness(lines, delta) {
  const ic = delta.inventoryCompleteness ?? {};
  const afterParseCount = (ic.filesWithParseErrors ?? []).filter((e) => e.side === 'after').length;
  const beforeParseCount = (ic.filesWithParseErrors ?? []).filter((e) => e.side === 'before').length;

  lines.push('Inventory completeness:');
  lines.push(`- after-inventory complete: ${
    ic.afterComplete ? 'yes' : `no — ${afterParseCount} file(s) had parse errors`
  }`);
  if (ic.beforeComplete === null) {
    lines.push(`- before-inventory complete: n/a (baseline missing)`);
  } else {
    lines.push(`- before-inventory complete: ${
      ic.beforeComplete ? 'yes' : `no — ${beforeParseCount} file(s) had parse errors`
    }`);
  }
  const errs = ic.filesWithParseErrors ?? [];
  if (errs.length === 0) {
    lines.push(`- files with parse errors: empty`);
  } else {
    lines.push(`- files with parse errors:`);
    for (const e of errs) {
      lines.push(`  - ${e.side}:${e.file} (${e.line}) — ${e.message}`);
    }
  }
  lines.push('');
}

// ── Status lines ────────────────────────────────────────────

function renderStatusLines(lines, delta) {
  const b = delta.baseline ?? {};
  const c = delta.capabilityParity ?? {};
  const s = delta.scanRangeParity ?? {};
  lines.push(`Baseline status: ${b.status}${b.reason ? ` — ${b.reason}` : ''}`);
  lines.push(`Capability parity: ${c.status}${c.mismatchDetail ? ` — ${c.mismatchDetail}` : ''}`);
  lines.push(`Scan-range parity: ${s.status}${s.mismatchDetail ? ` — ${s.mismatchDetail}` : ''}`);
  lines.push('');
}

// ── Summary line ────────────────────────────────────────────

function renderSummary(lines, delta) {
  const silentNew = delta.summary?.silentNew ?? 0;
  if (silentNew > 0) {
    lines.push(`silent-new — REQUIRE acknowledgment: ${silentNew} entries listed above.`);
    return;
  }

  // silentNew === 0 — decide clean vs caveated.
  const reasons = [];
  const cap = delta.capabilityParity?.status;
  const sr  = delta.scanRangeParity?.status;
  const bl  = delta.baseline?.status;
  const ic  = delta.inventoryCompleteness ?? {};

  if (cap === 'missing') reasons.push('after-inventory missing');
  else if (cap === 'mismatch') reasons.push('after-inventory unusable');
  if (bl === 'missing') reasons.push('before-inventory missing');
  if (sr === 'mismatch') reasons.push(`scan-range mismatch${delta.scanRangeParity?.mismatchDetail ? ` (${delta.scanRangeParity.mismatchDetail})` : ''}`);
  if (ic.afterComplete === false) {
    const n = (ic.filesWithParseErrors ?? []).filter((e) => e.side === 'after').length;
    reasons.push(`after-inventory incomplete: ${n} file(s) with parse errors`);
  }
  if (ic.beforeComplete === false) {
    const n = (ic.filesWithParseErrors ?? []).filter((e) => e.side === 'before').length;
    reasons.push(`before-inventory incomplete: ${n} file(s) with parse errors`);
  }

  if (reasons.length === 0) {
    lines.push('No silent new any in the scan range.');
  } else {
    lines.push(`No silent-new acknowledgements required; delta confidence is limited by ${reasons.join(', ')}.`);
  }
}
