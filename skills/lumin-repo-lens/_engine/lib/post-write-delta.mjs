// Core delta engine for post-write (P2-1).
//
// Pure function computeDelta({...}) → DeltaResult.
//
// Contract:
//   - No clock, randomness, or filesystem side effects inside this module.
//     deltaInvocationId is caller-injected so the function stays deterministic
//     (maintainer history notes v3 §4.1). Tests source-grep this file to enforce the rule.
//   - Capability source is the inventory itself (meta.supports.typeEscapes +
//     escapeKinds), NOT preWriteAdvisory.capabilities (§4.4).
//   - Ambiguous-planned-match remainders route through baseline comparison;
//     they are NEVER hard-labeled silent-new (§4.2).
//   - Scan-range mismatch preserves planned matching; baseline-derived labels
//     degrade to observed-unbaselined; removed is not computed (§4.4).
//   - requiredAcknowledgements(delta) returns EXACTLY silent-new entries.
//   - normalizeCodeShape is re-imported from extract-ts-escapes.mjs to keep
//     planned-codeShape matching byte-equal with occurrence emission (§3.3).

import { normalizeCodeShape } from './extract-ts-escapes.mjs';
import { DELTA_LABELS } from './vocab.mjs';

// ── Canonical enumeration ──────────────────────────────────

export const CANONICAL_ESCAPE_KINDS = Object.freeze([
  'explicit-any', 'as-any', 'angle-any', 'as-unknown-as-T',
  'rest-any-args', 'index-sig-any', 'generic-default-any',
  'ts-ignore', 'ts-expect-error', 'no-explicit-any-disable',
  'jsdoc-any',
]);

// ── Capability helper ──────────────────────────────────────

export function inventoryUsable(inv) {
  if (!inv) return false;
  if (inv.meta?.supports?.typeEscapes !== true) return false;
  const kinds = inv.meta?.supports?.escapeKinds ?? [];
  if (kinds.length !== CANONICAL_ESCAPE_KINDS.length) return false;
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] !== CANONICAL_ESCAPE_KINDS[i]) return false;
  }
  return true;
}

// ── Location match predicate ───────────────────────────────
//
// Per §4.2: planned.locationHint matches observed when one of the four
// conditions holds. The endsWith('/') prefix check is path-boundary safe
// — "src/foo" does NOT match "src/foobar.ts".

function locationMatches(observed, hint) {
  if (hint === 'unknown') return true;
  if (observed.insideExportedIdentity === hint) return true;
  if (observed.file === hint) return true;
  if (typeof hint === 'string' && hint.endsWith('/') &&
      typeof observed.file === 'string' && observed.file.startsWith(hint)) {
    return true;
  }
  return false;
}

// ── Deterministic candidate sort ────────────────────────────
//
// Stable order for one-to-one picking: (file, line, occurrenceKey).

function sortCandidates(xs) {
  return [...xs].sort((a, b) => {
    const fa = a.file ?? '';
    const fb = b.file ?? '';
    if (fa !== fb) return fa < fb ? -1 : 1;
    const la = a.line ?? 0;
    const lb = b.line ?? 0;
    if (la !== lb) return la - lb;
    const ka = a.occurrenceKey ?? '';
    const kb = b.occurrenceKey ?? '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// ── Parity helpers ──────────────────────────────────────────

function computeCapabilityParity(afterInventory) {
  if (!afterInventory) {
    return {
      capabilityParity: {
        status: 'missing',
        mismatchDetail: 'afterInventory absent — see capabilityFailures[]',
      },
      failure: { kind: 'after-inventory-missing', reason: 'afterInventory argument was null or undefined' },
    };
  }
  if (!inventoryUsable(afterInventory)) {
    const reasons = [];
    if (afterInventory.meta?.supports?.typeEscapes !== true) {
      reasons.push('meta.supports.typeEscapes !== true');
    }
    const kinds = afterInventory.meta?.supports?.escapeKinds ?? [];
    if (kinds.length !== CANONICAL_ESCAPE_KINDS.length ||
        kinds.some((k, i) => k !== CANONICAL_ESCAPE_KINDS[i])) {
      reasons.push('meta.supports.escapeKinds drifts from canonical §3.9');
    }
    return {
      capabilityParity: {
        status: 'mismatch',
        mismatchDetail: reasons.join('; ') || 'unusable',
      },
      failure: { kind: 'after-inventory-unusable', reason: reasons.join('; ') || 'unusable' },
    };
  }
  return { capabilityParity: { status: 'ok' }, failure: null };
}

function computeScanRangeParity(before, after) {
  if (!before) {
    return { scanRangeParity: { status: 'baseline-missing' } };
  }
  const excludeBefore = JSON.stringify([...(before.meta?.exclude ?? [])].sort());
  const excludeAfter  = JSON.stringify([...(after.meta?.exclude  ?? [])].sort());
  const details = [];
  if (before.meta?.scope !== after.meta?.scope) {
    details.push(`scope: before=${JSON.stringify(before.meta?.scope)} after=${JSON.stringify(after.meta?.scope)}`);
  }
  if (before.meta?.includeTests !== after.meta?.includeTests) {
    details.push(`includeTests: before=${before.meta?.includeTests} after=${after.meta?.includeTests}`);
  }
  if (excludeBefore !== excludeAfter) {
    details.push(`exclude: before=${excludeBefore} after=${excludeAfter}`);
  }
  if (details.length > 0) {
    return { scanRangeParity: { status: 'mismatch', mismatchDetail: details.join('; ') } };
  }
  return { scanRangeParity: { status: 'ok' } };
}

function buildInventoryCompleteness(before, after, baselineAvailable) {
  const filesWithParseErrors = [];
  if (after) {
    for (const e of (after.meta?.filesWithParseErrors ?? [])) {
      filesWithParseErrors.push({ side: 'after', file: e.file, message: e.message, line: e.line });
    }
  }
  if (baselineAvailable && before) {
    for (const e of (before.meta?.filesWithParseErrors ?? [])) {
      filesWithParseErrors.push({ side: 'before', file: e.file, message: e.message, line: e.line });
    }
  }
  return {
    afterComplete: after?.meta?.complete === true,
    beforeComplete: baselineAvailable ? (before?.meta?.complete === true) : null,
    filesWithParseErrors,
  };
}

// ── Planned-match step ──────────────────────────────────────
//
// Emits 'planned' and 'planned-not-observed' entries. Returns a Map from
// after occurrence object → carry-over diagnostics for unmarked after occurrences
// (e.g. ['ambiguous-planned-match']). Occurrences NOT in this map are
// either already-matched (label 'planned' — separate entries) or plain
// unmarked (no diagnostics yet).

function countByOccurrenceKey(occurrences) {
  const counts = new Map();
  for (const occ of occurrences ?? []) {
    const key = occ.occurrenceKey;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function buildAbsentFromBeforeSet(afterEscapes, beforeCounts) {
  const seen = new Map();
  const absent = new Set();
  for (const occ of sortCandidates(afterEscapes)) {
    const key = occ.occurrenceKey;
    const next = (seen.get(key) ?? 0) + 1;
    seen.set(key, next);
    if (next > (beforeCounts.get(key) ?? 0)) absent.add(occ);
  }
  return absent;
}

function matchPlanned({ plannedEscapes, afterEscapes, beforeCounts, absentFromBefore, baselineAvailable, scanOk }) {
  const plannedEntries = [];                  // emitted immediately
  const matchedAfter = new Set();             // after occurrence object → already labeled 'planned'
  const carryDiagnostics = new Map();         // after occurrence object → ['ambiguous-planned-match', ...]

  for (const planned of plannedEscapes) {
    // Step 1: escapeKind filter + location filter.
    let candidates = afterEscapes.filter((o) =>
      o.escapeKind === planned.escapeKind &&
      locationMatches(o, planned.locationHint) &&
      !matchedAfter.has(o));

    if (candidates.length === 0) {
      plannedEntries.push({
        label: 'planned-not-observed',
        escapeKind: planned.escapeKind,
        file: planned.locationHint === 'unknown' ? null : null,
        line: null,
        codeShape: null,
        normalizedCodeShape: null,
        insideExportedIdentity: null,
        occurrenceKey: null,
        plannedEntry: planned,
        diagnostics: [],
      });
      continue;
    }

    // Step 2: absent-from-before preference (only when trustworthy).
    if (baselineAvailable && scanOk) {
      const newOnes = candidates.filter((c) =>
        absentFromBefore.has(c) || (beforeCounts.get(c.occurrenceKey) ?? 0) === 0);
      if (newOnes.length >= 1) candidates = newOnes;
      // else: every candidate is pre-existing; honest fallthrough.
    }

    // Step 3: codeShape tiebreak.
    if (planned.codeShape && candidates.length >= 2) {
      const target = normalizeCodeShape(planned.codeShape);
      const exact = candidates.filter((c) => c.normalizedCodeShape === target);
      if (exact.length >= 1) candidates = exact;
    }

    // Step 4: deterministic sort + one-to-one pick.
    const sorted = sortCandidates(candidates);
    const choice = sorted[0];
    matchedAfter.add(choice);
    plannedEntries.push({
      label: 'planned',
      escapeKind: choice.escapeKind,
      file: choice.file,
      line: choice.line,
      codeShape: choice.codeShape,
      normalizedCodeShape: choice.normalizedCodeShape,
      insideExportedIdentity: choice.insideExportedIdentity,
      occurrenceKey: choice.occurrenceKey,
      plannedEntry: planned,
      diagnostics: [],
    });

    // Step 5: ambiguity — remainder passes through to baseline comparison,
    // carrying the diagnostic.
    if (sorted.length >= 2) {
      for (let i = 1; i < sorted.length; i++) {
        const remaining = sorted[i];
        const existing = carryDiagnostics.get(remaining) ?? [];
        if (!existing.includes('ambiguous-planned-match')) {
          existing.push('ambiguous-planned-match');
        }
        carryDiagnostics.set(remaining, existing);
      }
    }
  }

  return { plannedEntries, matchedAfter, carryDiagnostics };
}

// ── Baseline comparison ────────────────────────────────────
//
// Emits pre-existing / silent-new / observed-unbaselined / removed labels
// for all after-occurrences NOT already matched by planned. Honors scan-range
// mismatch by routing unmatched remainders through observed-unbaselined.

function classifyRemainders({
  afterEscapes, beforeInventory, baselineAvailable, scanOk,
  matchedAfter, carryDiagnostics, beforeCounts, absentFromBefore,
}) {
  const entries = [];

  // Unmatched after → either observed-unbaselined (no trust in baseline),
  // pre-existing (key in before), or silent-new (absent from before).
  const trustBaseline = baselineAvailable && scanOk;
  const afterCounts = countByOccurrenceKey(afterEscapes);

  // P0 fix (2026-04-21): when beforeInventory is incomplete (parse errors),
  // occurrences in files that before did NOT parse cannot be proven new.
  // Emitting silent-new would request a false Stage 3 acknowledgement —
  // violating the "silent-new requires baseline evidence" invariant.
  // Route those files' after-occurrences through observed-unbaselined with
  // a carry diagnostic. The downgrade is narrowly scoped: files that DID
  // parse in before still get normal silent-new / pre-existing labels.
  const beforeParseErrorFiles = new Set(
    (beforeInventory?.meta?.filesWithParseErrors ?? []).map((e) => e.file)
  );

  for (const e of afterEscapes) {
    if (matchedAfter.has(e)) continue;
    const carry = carryDiagnostics.get(e) ?? [];
    if (!trustBaseline) {
      entries.push(buildEntry('observed-unbaselined', e, carry));
      continue;
    }
    const duplicateDiagnostics =
      ((afterCounts.get(e.occurrenceKey) ?? 0) > 1 || (beforeCounts.get(e.occurrenceKey) ?? 0) > 1)
        ? ['ambiguous-duplicate-occurrence-key']
        : [];
    if ((beforeCounts.get(e.occurrenceKey) ?? 0) > 0 && !absentFromBefore.has(e)) {
      entries.push(buildEntry('pre-existing', e, carry));
    } else if (beforeParseErrorFiles.has(e.file)) {
      // Before had a parse error on this file — new-vs-existing cannot
      // be proven. Downgrade honestly; acknowledgement NOT requested.
      entries.push(buildEntry('observed-unbaselined', e, [...carry, ...duplicateDiagnostics, 'before-file-parse-error']));
    } else {
      entries.push(buildEntry('silent-new', e, [...carry, ...duplicateDiagnostics]));
    }
  }

  // Removed: before occurrences missing from after. Only when baseline
  // trustworthy — scan mismatch or missing baseline both skip this.
  if (trustBaseline && beforeInventory) {
    const seenBefore = new Map();
    for (const e of (beforeInventory.typeEscapes ?? [])) {
      const key = e.occurrenceKey;
      const next = (seenBefore.get(key) ?? 0) + 1;
      seenBefore.set(key, next);
      if (next > (afterCounts.get(key) ?? 0)) {
        entries.push(buildEntry('removed', e, []));
      }
    }
  }

  return entries;
}

function buildEntry(label, occ, diagnostics) {
  return {
    label,
    escapeKind: occ.escapeKind,
    file: occ.file,
    line: occ.line,
    codeShape: occ.codeShape,
    normalizedCodeShape: occ.normalizedCodeShape,
    insideExportedIdentity: occ.insideExportedIdentity,
    occurrenceKey: occ.occurrenceKey,
    plannedEntry: null,
    diagnostics: [...diagnostics],
  };
}

// ── Summary counter ────────────────────────────────────────

// Label → summary-key table. Indirection via DELTA_LABELS so a label
// rename in vocab.mjs surfaces here as a map key resolving to undefined,
// which the drift-test in test-vocab.mjs catches structurally.
const LABEL_TO_SUMMARY_KEY = Object.freeze({
  [DELTA_LABELS.PLANNED]:              'planned',
  [DELTA_LABELS.PLANNED_NOT_OBSERVED]: 'plannedNotObserved',
  [DELTA_LABELS.SILENT_NEW]:           'silentNew',
  [DELTA_LABELS.PRE_EXISTING]:         'preExisting',
  [DELTA_LABELS.REMOVED]:              'removed',
  [DELTA_LABELS.OBSERVED_UNBASELINED]: 'observedUnbaselined',
});

function summarize(entries) {
  const s = {
    planned: 0, plannedNotObserved: 0, silentNew: 0,
    preExisting: 0, removed: 0, observedUnbaselined: 0,
  };
  for (const e of entries) {
    const k = LABEL_TO_SUMMARY_KEY[e.label];
    if (k) s[k]++;
  }
  return s;
}

// ── Main entry point ──────────────────────────────────────

/**
 * Pure function: same inputs → byte-identical DeltaResult.
 *
 * @param {{
 *   preWriteAdvisory: object,
 *   beforeInventory: object | null,
 *   afterInventory: object | null,
 *   deltaInvocationId: string,     // CALLER-INJECTED; DO NOT generate inside.
 * }} inputs
 * @returns {object} DeltaResult
 */
export function computeDelta({ preWriteAdvisory, beforeInventory, afterInventory, deltaInvocationId }) {
  const preWriteInvocationId = preWriteAdvisory?.invocationId ?? '';
  const intentHash = preWriteAdvisory?.intentHash ?? '';
  const anyInventoryPath = preWriteAdvisory?.preWrite?.anyInventoryPath ?? null;

  // ── Capability parity ──
  // capabilityFailures is scoped to capability-gate failures only. Other
  // degradation signals (scan-range mismatch, baseline missing, incomplete
  // inventory) are carried by their respective .status fields + the
  // summary-line renderer — no duplicate emission here. Renamed from
  // `failures` 2026-04-21 after a reviewer sweep flagged the old name as
  // misleading (it only ever contained capability entries).
  const capCheck = computeCapabilityParity(afterInventory);
  const capabilityFailures = [];
  if (capCheck.failure) capabilityFailures.push(capCheck.failure);

  // Capability mismatch/missing → short-circuit with empty entries.
  if (capCheck.capabilityParity.status !== 'ok') {
    return {
      preWriteInvocationId,
      deltaInvocationId,
      intentHash,
      baseline: {
        status: 'missing',
        source: anyInventoryPath,
        reason: 'capability gate failed — see capabilityParity',
      },
      capabilityParity: capCheck.capabilityParity,
      scanRangeParity: { status: 'baseline-missing' },
      inventoryCompleteness: buildInventoryCompleteness(beforeInventory, afterInventory, false),
      entries: [],
      summary: summarize([]),
      capabilityFailures,
    };
  }

  // ── Baseline availability ──
  // Usable afterInventory is guaranteed at this point.
  let baseline;
  let usableBefore = null;
  if (beforeInventory && inventoryUsable(beforeInventory)) {
    usableBefore = beforeInventory;
    baseline = {
      status: 'available',
      source: anyInventoryPath,
    };
  } else if (beforeInventory) {
    baseline = {
      status: 'missing',
      source: anyInventoryPath,
      reason: 'beforeInventory present but unusable (meta.supports.typeEscapes !== true or escapeKinds drift)',
    };
  } else {
    baseline = {
      status: 'missing',
      source: anyInventoryPath,
      reason: anyInventoryPath
        ? `before-inventory not loaded from ${anyInventoryPath}`
        : 'advisory has no preWrite.anyInventoryPath',
    };
  }
  const baselineAvailable = baseline.status === 'available';

  // ── Scan-range parity ──
  const srCheck = baselineAvailable
    ? computeScanRangeParity(usableBefore, afterInventory)
    : { scanRangeParity: { status: 'baseline-missing' } };
  const scanOk = srCheck.scanRangeParity.status === 'ok';

  // ── Inventory completeness ──
  const inventoryCompleteness = buildInventoryCompleteness(usableBefore, afterInventory, baselineAvailable);

  // ── Classification ──
  const beforeEscapes = usableBefore?.typeEscapes ?? [];
  const afterEscapes = afterInventory.typeEscapes ?? [];
  const beforeCounts = countByOccurrenceKey(beforeEscapes);
  const absentFromBefore = buildAbsentFromBeforeSet(afterEscapes, beforeCounts);

  const planned = matchPlanned({
    plannedEscapes: preWriteAdvisory?.intent?.plannedTypeEscapes ?? [],
    afterEscapes,
    beforeCounts,
    absentFromBefore,
    baselineAvailable,
    scanOk,
  });

  const remainderEntries = classifyRemainders({
    afterEscapes,
    beforeInventory: usableBefore,
    baselineAvailable,
    scanOk,
    matchedAfter: planned.matchedAfter,
    carryDiagnostics: planned.carryDiagnostics,
    beforeCounts,
    absentFromBefore,
  });

  const entries = [...planned.plannedEntries, ...remainderEntries];

  return {
    preWriteInvocationId,
    deltaInvocationId,
    intentHash,
    baseline,
    capabilityParity: capCheck.capabilityParity,
    scanRangeParity: srCheck.scanRangeParity,
    inventoryCompleteness,
    entries,
    summary: summarize(entries),
    capabilityFailures,
  };
}

// ── requiredAcknowledgements ─────────────────────────────────
//
// Stage 3 contract: caller must acknowledge every entry this returns.
// Return value is EXACTLY silent-new entries, regardless of diagnostics
// carried (ambiguous-planned-match does NOT exempt).

export function requiredAcknowledgements(delta) {
  const entries = delta?.entries ?? [];
  return entries.filter((e) => e.label === DELTA_LABELS.SILENT_NEW);
}
