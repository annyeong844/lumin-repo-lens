// P6-0 measurement helpers.
//
// Pure logic for p6-measurement.json: candidate counts, adjudication
// denominator math, schema round-trip summarization, and readiness gates.

const TIER_SAFE = 'SAFE_FIX';
const TIER_REVIEW = 'REVIEW_FIX';

const VALID_VERDICTS = new Set([
  'true_dead',
  'false_positive',
  'inconclusive',
  'not_applicable',
]);

function arrLen(v) {
  return Array.isArray(v) ? v.length : 0;
}

function isPresentObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function normalizeAdjudicationEntries(input) {
  const entries = Array.isArray(input)
    ? input
    : Array.isArray(input?.entries)
      ? input.entries
      : [];
  return entries
    .filter((e) => isPresentObject(e))
    .map((e) => ({
      ...e,
      verdict: VALID_VERDICTS.has(e.verdict) ? e.verdict : 'inconclusive',
    }));
}

export function buildCandidateCounts({ fixPlan, deadClassify, canonDrift }) {
  const missingArtifacts = [];
  const fixPlanAvailable = !!fixPlan;
  if (!fixPlanAvailable) missingArtifacts.push('fix-plan.json');

  const safeFix = fixPlanAvailable ? arrLen(fixPlan.safeFixes) : null;
  const reviewFix = fixPlanAvailable ? arrLen(fixPlan.reviewFixes) : null;
  const degraded = fixPlanAvailable ? arrLen(fixPlan.degraded) : null;
  const muted = fixPlanAvailable ? arrLen(fixPlan.muted) : null;

  let rawTierC = null;
  if (deadClassify) {
    rawTierC = typeof deadClassify.summary?.category_C === 'number'
      ? deadClassify.summary.category_C
      : arrLen(deadClassify.proposal_C_remove_symbol);
  } else {
    missingArtifacts.push('dead-classify.json');
  }

  const canonDriftAvailable = !!canonDrift;
  const canonMissing = canonDriftAvailable ? [] : ['canon-drift.json'];
  let canonDriftTotal = null;
  let canonPerSource = {};
  if (canonDriftAvailable) {
    canonPerSource = {};
    for (const [source, entry] of Object.entries(canonDrift.perSource ?? {})) {
      canonPerSource[source] = {
        status: entry?.status ?? 'unknown',
        driftCount: typeof entry?.driftCount === 'number' ? entry.driftCount : 0,
      };
    }
    if (typeof canonDrift.summary?.driftCount === 'number') {
      canonDriftTotal = canonDrift.summary.driftCount;
    } else if (Array.isArray(canonDrift.drifts)) {
      canonDriftTotal = canonDrift.drifts.length;
    } else {
      canonDriftTotal = Object.values(canonPerSource)
        .reduce((acc, e) => acc + (e.driftCount ?? 0), 0);
    }
  }

  return {
    available: fixPlanAvailable,
    missingArtifacts,
    reviewVisibleCleanup: fixPlanAvailable ? safeFix + reviewFix : null,
    safeFix,
    reviewFix,
    degraded,
    muted,
    rawTierC,
    canonDrift: {
      available: canonDriftAvailable,
      missingArtifacts: canonMissing,
      total: canonDriftTotal,
      perSource: canonPerSource,
    },
  };
}

function emptyStats() {
  return {
    falsePositives: 0,
    trueDead: 0,
    inconclusive: 0,
    notApplicable: 0,
    fpRate: null,
  };
}

function finalizeStats(stats) {
  const denominator = stats.trueDead + stats.falsePositives;
  return {
    ...stats,
    fpRate: denominator > 0 ? stats.falsePositives / denominator : null,
  };
}

function summarizeEntries(entries, predicate) {
  const stats = emptyStats();
  for (const e of entries) {
    if (!predicate(e)) continue;
    if (e.verdict === 'true_dead') stats.trueDead += 1;
    else if (e.verdict === 'false_positive') stats.falsePositives += 1;
    else if (e.verdict === 'not_applicable') stats.notApplicable += 1;
    else stats.inconclusive += 1;
  }
  return finalizeStats(stats);
}

function reason(code, severity, detail) {
  return { code, severity, detail };
}

function corpusName(entry) {
  return typeof entry?.name === 'string' && entry.name.length > 0 ? entry.name : '(unnamed)';
}

function hasImmutableIdentity(entry) {
  return !!(entry?.commit || entry?.snapshotId);
}

function dirtyStateIsKnown(entry) {
  return entry?.worktreeDirty === true || entry?.worktreeDirty === false;
}

function dirtyStateCaptured(entry) {
  if (entry?.worktreeDirty !== true) return true;
  return !!(entry.snapshotId || entry.contentHash);
}

function isNonTrivialCorpus(entry) {
  return ['25k', '50k', '100k'].includes(entry?.locBucket);
}

function countAdjudicatedByCorpus(entries) {
  const counts = new Map();
  for (const e of entries) {
    const name = e.corpusName ?? '(unknown)';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function reviewVisibleDenominatorByCorpus(entries) {
  const counts = new Map();
  for (const e of entries) {
    if (e.tier !== TIER_SAFE && e.tier !== TIER_REVIEW) continue;
    if (e.verdict !== 'true_dead' && e.verdict !== 'false_positive') continue;
    const name = e.corpusName ?? '(unknown)';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function expectedReviewVisibleForCorpus({ candidateCounts, corpusName, corpusTotal }) {
  const perCorpusTotal = candidateCounts?.byCorpus?.[corpusName]?.reviewVisibleCleanup;
  if (typeof perCorpusTotal === 'number') return perCorpusTotal;
  if (corpusTotal === 1 && typeof candidateCounts?.reviewVisibleCleanup === 'number') {
    return candidateCounts.reviewVisibleCleanup;
  }
  return null;
}

function everyCorpusHasEnoughAdjudication({ corpus, entries, candidateCounts, minAdjudicatedPerCorpus }) {
  const counts = countAdjudicatedByCorpus(entries);
  const corpusTotal = corpus.length;
  return corpus.every((c) => {
    const count = counts.get(c.name) ?? 0;
    if (count >= minAdjudicatedPerCorpus) return true;
    const expectedTotal = expectedReviewVisibleForCorpus({
      candidateCounts,
      corpusName: c.name,
      corpusTotal,
    });
    return typeof expectedTotal === 'number' &&
      expectedTotal < minAdjudicatedPerCorpus &&
      count >= expectedTotal;
  });
}

function sumNullableNumbers(values) {
  if (!values.every((v) => typeof v === 'number')) return null;
  return values.reduce((acc, v) => acc + v, 0);
}

function unionStrings(lists) {
  return Array.from(new Set(lists.flatMap((v) => Array.isArray(v) ? v : []))).sort();
}

function firstCorpusName(artifact, index) {
  const entry = Array.isArray(artifact?.corpus) ? artifact.corpus[0] : null;
  return typeof entry?.name === 'string' && entry.name.length > 0
    ? entry.name
    : `corpus-${index + 1}`;
}

export function mergeMeasurementArtifacts(artifacts) {
  const inputs = Array.isArray(artifacts)
    ? artifacts.filter((a) => isPresentObject(a))
    : [];
  const corpus = inputs.flatMap((a) => Array.isArray(a.corpus) ? a.corpus : []);
  const candidateInputs = inputs.map((a) => a.candidateCounts ?? {});
  const canonInputs = candidateInputs.map((c) => c.canonDrift ?? {});

  const byCorpus = {};
  inputs.forEach((artifact, index) => {
    const name = firstCorpusName(artifact, index);
    const c = artifact.candidateCounts ?? {};
    byCorpus[name] = {
      available: c.available === true,
      reviewVisibleCleanup: typeof c.reviewVisibleCleanup === 'number' ? c.reviewVisibleCleanup : null,
      safeFix: typeof c.safeFix === 'number' ? c.safeFix : null,
      reviewFix: typeof c.reviewFix === 'number' ? c.reviewFix : null,
      degraded: typeof c.degraded === 'number' ? c.degraded : null,
      muted: typeof c.muted === 'number' ? c.muted : null,
      rawTierC: typeof c.rawTierC === 'number' ? c.rawTierC : null,
    };
  });

  const canonPerSource = {};
  inputs.forEach((artifact, index) => {
    const name = firstCorpusName(artifact, index);
    for (const [source, entry] of Object.entries(artifact.candidateCounts?.canonDrift?.perSource ?? {})) {
      canonPerSource[`${name}:${source}`] = entry;
    }
  });

  const candidateCounts = {
    available: inputs.length > 0 && candidateInputs.every((c) => c.available === true),
    missingArtifacts: unionStrings(candidateInputs.map((c) => c.missingArtifacts)),
    reviewVisibleCleanup: sumNullableNumbers(candidateInputs.map((c) => c.reviewVisibleCleanup)),
    safeFix: sumNullableNumbers(candidateInputs.map((c) => c.safeFix)),
    reviewFix: sumNullableNumbers(candidateInputs.map((c) => c.reviewFix)),
    degraded: sumNullableNumbers(candidateInputs.map((c) => c.degraded)),
    muted: sumNullableNumbers(candidateInputs.map((c) => c.muted)),
    rawTierC: sumNullableNumbers(candidateInputs.map((c) => c.rawTierC)),
    byCorpus,
    canonDrift: {
      available: inputs.length > 0 && canonInputs.every((c) => c.available === true),
      missingArtifacts: unionStrings(canonInputs.map((c) => c.missingArtifacts)),
      total: sumNullableNumbers(canonInputs.map((c) => c.total)),
      perSource: canonPerSource,
    },
  };

  const schemaSources = {};
  const knownSchemaDriftBugs = [];
  for (const [index, artifact] of inputs.entries()) {
    const name = firstCorpusName(artifact, index);
    for (const [source, entry] of Object.entries(artifact.schemaRoundTrip?.sources ?? {})) {
      schemaSources[`${name}:${source}`] = entry;
    }
    for (const bug of artifact.schemaRoundTrip?.knownSchemaDriftBugs ?? []) {
      knownSchemaDriftBugs.push({ corpusName: name, ...bug });
    }
  }

  const runtimes = inputs.map((a) => a.runtime ?? {});
  const runtime = {
    wallMs: sumNullableNumbers(runtimes.map((r) => r.wallMs)),
    childProcessCount: sumNullableNumbers(runtimes.map((r) => r.childProcessCount)),
    steps: inputs.flatMap((artifact, index) => {
      const name = firstCorpusName(artifact, index);
      return Array.isArray(artifact.runtime?.steps)
        ? artifact.runtime.steps.map((s) => ({ corpusName: name, ...s }))
        : [];
    }),
    parseCount: sumNullableNumbers(runtimes.map((r) => r.parseCount)),
    fileWalkMs: sumNullableNumbers(runtimes.map((r) => r.fileWalkMs)),
    resolverConstructionMs: sumNullableNumbers(runtimes.map((r) => r.resolverConstructionMs)),
    cacheHits: sumNullableNumbers(runtimes.map((r) => r.cacheHits)),
    cacheMisses: sumNullableNumbers(runtimes.map((r) => r.cacheMisses)),
  };

  return {
    corpus,
    candidateCounts,
    adjudicationEntries: inputs.flatMap((a) => normalizeAdjudicationEntries(a.adjudication)),
    runtime,
    schemaRoundTrip: {
      attempted: inputs.length > 0 && inputs.every((a) => a.schemaRoundTrip?.attempted === true),
      sources: schemaSources,
      knownSchemaDriftBugs,
    },
  };
}

export function buildSchemaRoundTrip({ manifest, canonDrift }) {
  const canonPerSource = canonDrift?.perSource;
  const manifestPerSource = manifest?.checkCanon?.perSource;
  const perSource = isPresentObject(canonPerSource) && Object.keys(canonPerSource).length > 0
    ? canonPerSource
    : isPresentObject(manifestPerSource)
      ? manifestPerSource
      : {};
  const sources = {};
  let attempted = false;
  const knownSchemaDriftBugs = [];
  for (const [source, entry] of Object.entries(perSource)) {
    const status = entry?.status ?? 'unknown';
    const driftCount = typeof entry?.driftCount === 'number' ? entry.driftCount : null;
    sources[source] = { status, driftCount };
    if (status === 'clean' || status === 'drift') attempted = true;
    if (status === 'parse-error' || status === 'skipped-unrecognized-schema') {
      knownSchemaDriftBugs.push({ source, status });
    }
  }
  return { attempted, sources, knownSchemaDriftBugs };
}

export function computeReadiness({
  corpus = [],
  candidateCounts,
  adjudicationEntries = [],
  schemaRoundTrip = { attempted: false, knownSchemaDriftBugs: [], sources: {} },
  unresolvedHighFindings = 0,
  minAdjudicatedPerCorpus = 50,
} = {}) {
  const entries = normalizeAdjudicationEntries(adjudicationEntries);
  const safeFix = summarizeEntries(entries, (e) => e.tier === TIER_SAFE);
  const reviewVisibleCleanup = summarizeEntries(
    entries,
    (e) => e.tier === TIER_SAFE || e.tier === TIER_REVIEW,
  );

  const reasons = [];

  if (!candidateCounts?.available) {
    reasons.push(reason('candidate-counts-unavailable', 'red', 'fix-plan.json missing or candidate counts unavailable'));
  }

  const safeNeedsAdjudication = (candidateCounts?.safeFix ?? 0) > 0 && safeFix.fpRate === null;
  const reviewNeedsAdjudication =
    (candidateCounts?.reviewVisibleCleanup ?? 0) > 0 && reviewVisibleCleanup.fpRate === null;
  const reviewDenominatorsByCorpus = reviewVisibleDenominatorByCorpus(entries);
  const corpusWithUnknownFp = corpus.some((c) => {
    const expected = expectedReviewVisibleForCorpus({
      candidateCounts,
      corpusName: c.name,
      corpusTotal: corpus.length,
    });
    return typeof expected === 'number' &&
      expected > 0 &&
      (reviewDenominatorsByCorpus.get(c.name) ?? 0) === 0;
  });
  if (entries.length === 0 || safeNeedsAdjudication || reviewNeedsAdjudication || corpusWithUnknownFp) {
    reasons.push(reason('fp-rate-unknown', 'red', 'adjudication denominator is empty or incomplete'));
  }

  if (safeFix.fpRate !== null && safeFix.fpRate >= 0.05) {
    reasons.push(reason('safe-fix-fp-threshold', 'red', `SAFE_FIX FP rate ${safeFix.fpRate}`));
  }
  if (reviewVisibleCleanup.fpRate !== null && reviewVisibleCleanup.fpRate > 0.25) {
    reasons.push(reason('review-visible-fp-threshold', 'red', `review-visible cleanup FP rate ${reviewVisibleCleanup.fpRate}`));
  }

  if (!schemaRoundTrip?.attempted) {
    reasons.push(reason('schema-roundtrip-not-attempted', 'red', 'P3/P5 schema round-trip was not attempted'));
  }
  if ((schemaRoundTrip?.knownSchemaDriftBugs ?? []).length > 0) {
    reasons.push(reason('schema-drift-known', 'red', 'known P3/P5 schema drift bug present'));
  }

  for (const c of corpus) {
    if (!hasImmutableIdentity(c)) {
      reasons.push(reason('corpus-identity-missing', 'red', `${corpusName(c)} lacks commit/snapshotId`));
    }
    if (!dirtyStateIsKnown(c)) {
      reasons.push(reason('dirty-worktree-unknown', 'red', `${corpusName(c)} dirty state unknown`));
    } else if (!dirtyStateCaptured(c)) {
      reasons.push(reason('dirty-worktree-without-snapshot', 'red', `${corpusName(c)} dirty state lacks snapshot/contentHash`));
    }
  }

  if (unresolvedHighFindings > 0) {
    reasons.push(reason('unresolved-high-finding', 'red', `${unresolvedHighFindings} unresolved HIGH finding(s)`));
  }

  const redReasons = reasons.filter((r) => r.severity === 'red');
  let gate = 'Red';
  if (redReasons.length === 0) {
    const enoughCorpus = corpus.filter(isNonTrivialCorpus).length >= 2;
    const enoughAdjudication = everyCorpusHasEnoughAdjudication({
      corpus,
      entries,
      candidateCounts,
      minAdjudicatedPerCorpus,
    });
    const hasSafeFixPopulation = (candidateCounts?.safeFix ?? 0) > 0;
    if (!hasSafeFixPopulation) {
      reasons.push(reason(
        'safe-fix-population-empty',
        'yellow',
        'SAFE_FIX population is measured zero; autonomous cleanup precision is not measured',
      ));
    }
    if (!enoughCorpus || !enoughAdjudication) {
      reasons.push(reason('benchmark-incomplete', 'yellow', 'Green corpus/adjudication thresholds not met'));
    }
    const green =
      hasSafeFixPopulation &&
      safeFix.fpRate !== null &&
      safeFix.fpRate < 0.05 &&
      reviewVisibleCleanup.fpRate !== null &&
      reviewVisibleCleanup.fpRate < 0.10 &&
      enoughCorpus &&
      enoughAdjudication;
    if (green) {
      gate = 'Green';
    } else {
      gate = 'Yellow';
    }
  }

  return {
    gate,
    reasons,
    safeFix,
    reviewVisibleCleanup,
  };
}

export function buildMeasurementArtifact({
  meta,
  corpus,
  candidateCounts,
  adjudicationEntries,
  runtime,
  schemaRoundTrip,
  readiness,
}) {
  return {
    schemaVersion: 'p6-measurement.v1',
    meta: meta ?? {},
    corpus: corpus ?? [],
    candidateCounts,
    adjudication: {
      entries: normalizeAdjudicationEntries(adjudicationEntries),
    },
    runtime: runtime ?? {},
    schemaRoundTrip,
    readiness,
  };
}
