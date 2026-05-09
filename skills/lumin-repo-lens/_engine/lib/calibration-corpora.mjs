// Registry for named calibration corpus anchors.
//
// Threshold policies should reference registered corpus ids, not free-form
// prose strings. This keeps numeric policy metadata tied to a reviewable
// calibration intent without building the full corpus runner in this slice.

export const CALIBRATION_CORPUS_SCHEMA_VERSION = 'calibration-corpus.v1';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function freezeCorpus(corpus) {
  return Object.freeze({
    ...corpus,
    metrics: Object.freeze([...(corpus.metrics ?? [])]),
    entries: Object.freeze([...(corpus.entries ?? [])].map((entry) => Object.freeze({ ...entry }))),
    notes: Object.freeze([...(corpus.notes ?? [])]),
  });
}

export const CALIBRATION_CORPORA = Object.freeze({
  'calibration-2026-05-prewrite-v1': freezeCorpus({
    schemaVersion: CALIBRATION_CORPUS_SCHEMA_VERSION,
    corpusId: 'calibration-2026-05-prewrite-v1',
    purpose: 'pre-write cue and threshold calibration',
    status: 'registry-anchor',
    entries: [
      {
        kind: 'fixture',
        name: 'prewrite-inline-patterns',
        revision: 'fixture:v1',
        purpose: 'inline extraction cue precision and noise checks',
      },
      {
        kind: 'fixture',
        name: 'function-clone-near-candidates',
        revision: 'fixture:v1',
        purpose: 'near-function review cue score boundaries',
      },
      {
        kind: 'external-sample',
        name: 'medium-ts-js-workspace',
        revision: 'sample-set:v1',
        purpose: 'agent-facing cue noise and runtime budget checks',
      },
    ],
    metrics: [
      'precisionProxy',
      'noiseRate',
      'runtimeMs',
      'suppressedCueRate',
    ],
    notes: [
      'Review and suppression thresholds only; does not promote SAFE_FIX.',
      'Stress runtime findings are not correctness acceptance.',
    ],
  }),

  'calibration-2026-05-resolver-v1': freezeCorpus({
    schemaVersion: CALIBRATION_CORPUS_SCHEMA_VERSION,
    corpusId: 'calibration-2026-05-resolver-v1',
    purpose: 'resolver blind-zone and completeness calibration',
    status: 'registry-anchor',
    entries: [
      {
        kind: 'fixture',
        name: 'resolver-workspace-source-direct-subpaths',
        revision: 'fixture:v1',
        purpose: 'workspace package source-direct and subpath resolution',
      },
      {
        kind: 'fixture',
        name: 'resolver-generated-artifact-misses',
        revision: 'fixture:v1',
        purpose: 'generated artifact miss taxonomy and scoped blocking',
      },
      {
        kind: 'external-sample',
        name: 'large-workspace-stress',
        revision: 'sample-set:v1',
        purpose: 'unresolved concentration and false global blocker checks',
      },
    ],
    metrics: [
      'unresolvedInternalRate',
      'blindZoneCount',
      'falseGlobalBlockerCount',
      'affectedPackageScopeCount',
      'runtimeMs',
    ],
    notes: [
      'Resolver confidence thresholds limit absence claims.',
      'Unrelated blind zones must not become repo-global blockers.',
    ],
  }),
});

export function listCalibrationCorpusIds() {
  return Object.keys(CALIBRATION_CORPORA).sort((a, b) => a.localeCompare(b));
}

export function getCalibrationCorpus(corpusId) {
  const corpus = CALIBRATION_CORPORA[corpusId];
  if (!corpus) {
    throw new Error(`Unknown calibration corpus: ${corpusId}`);
  }
  return clone(corpus);
}

export function calibrationCorpusSummary(corpusIds) {
  return [...corpusIds].map((corpusId) => {
    const corpus = getCalibrationCorpus(corpusId);
    return {
      schemaVersion: corpus.schemaVersion,
      corpusId: corpus.corpusId,
      purpose: corpus.purpose,
      status: corpus.status,
      metrics: corpus.metrics,
      entryCount: corpus.entries.length,
    };
  });
}
