#!/usr/bin/env node
// p6-measurement.mjs — P6-0 measurement artifact writer.

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseCliArgs } from '../lib/cli.mjs';
import { readJsonFile, loadIfExists, producerMetaBase } from '../lib/artifacts.mjs';
import {
  buildCandidateCounts,
  buildMeasurementArtifact,
  buildSchemaRoundTrip,
  computeReadiness,
  mergeMeasurementArtifacts,
  normalizeAdjudicationEntries,
} from '../lib/p6-measurement.mjs';

function coerceOptionalBool(v) {
  if (v === true || v === 'true' || v === '1' || v === 'yes') return true;
  if (v === false || v === 'false' || v === '0' || v === 'no') return false;
  return null;
}

function git(root, args) {
  const res = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0 || res.error) return null;
  return (res.stdout ?? '').trim();
}

function detectCommit(root) {
  return git(root, ['rev-parse', 'HEAD']);
}

function detectDirty(root) {
  const out = git(root, ['status', '--porcelain']);
  if (out === null) return null;
  return out.length > 0;
}

function inferPackageManager(root) {
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock'))) return 'bun';
  if (existsSync(path.join(root, 'package-lock.json'))) return 'npm';
  return null;
}

function loadAdjudication(filePath) {
  if (!filePath) return [];
  const parsed = readJsonFile(path.resolve(filePath), { tag: 'p6-measurement', strict: true });
  return normalizeAdjudicationEntries(parsed);
}

function runtimeFromManifest(manifest, wallMs) {
  const steps = Array.isArray(manifest?.commandsRun) ? manifest.commandsRun : [];
  const checkCanonChildren = manifest?.checkCanon?.childInvocations;
  return {
    wallMs,
    childProcessCount: typeof checkCanonChildren === 'number'
      ? steps.length + checkCanonChildren
      : steps.length,
    steps: steps.map((s) => ({
      step: s.step,
      status: s.status,
      ms: typeof s.ms === 'number' ? s.ms : null,
    })),
    parseCount: null,
    fileWalkMs: null,
    resolverConstructionMs: null,
    cacheHits: null,
    cacheMisses: null,
  };
}

const t0 = Date.now();

const cli = parseCliArgs({
  'corpus-name': { type: 'string' },
  repo: { type: 'string' },
  commit: { type: 'string' },
  'snapshot-id': { type: 'string' },
  'content-hash': { type: 'string' },
  'worktree-dirty': { type: 'string' },
  'loc-bucket': { type: 'string' },
  'package-manager': { type: 'string' },
  reason: { type: 'string' },
  adjudication: { type: 'string' },
  merge: { type: 'string', multiple: true, default: [] },
});

if ((cli.raw.merge ?? []).length > 0) {
  const inputs = cli.raw.merge.map((filePath) =>
    readJsonFile(path.resolve(filePath), { tag: 'p6-measurement', strict: true }));
  const merged = mergeMeasurementArtifacts(inputs);
  const readiness = computeReadiness({
    corpus: merged.corpus,
    candidateCounts: merged.candidateCounts,
    adjudicationEntries: merged.adjudicationEntries,
    schemaRoundTrip: merged.schemaRoundTrip,
  });
  const artifact = buildMeasurementArtifact({
    meta: {
      ...producerMetaBase({ tool: 'p6-measurement.mjs', root: cli.root }),
      node: process.version,
      platform: process.platform,
      output: cli.output,
      mode: 'merge',
      inputs: cli.raw.merge.map((p) => path.resolve(p)),
    },
    corpus: merged.corpus,
    candidateCounts: merged.candidateCounts,
    adjudicationEntries: merged.adjudicationEntries,
    runtime: merged.runtime,
    schemaRoundTrip: merged.schemaRoundTrip,
    readiness,
  });

  const outPath = path.join(cli.output, 'p6-measurement.json');
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  process.stdout.write(`[p6-measurement] merged ${inputs.length} artifact(s) -> ${outPath}\n`);
  process.stdout.write(`[p6-measurement] readiness=${readiness.gate}\n`);
  process.exit(0);
}

const fixPlan = loadIfExists(cli.output, 'fix-plan.json', { tag: 'p6-measurement' });
const deadClassify = loadIfExists(cli.output, 'dead-classify.json', { tag: 'p6-measurement' });
const canonDrift = loadIfExists(cli.output, 'canon-drift.json', { tag: 'p6-measurement' });
const manifest = loadIfExists(cli.output, 'manifest.json', { tag: 'p6-measurement' });

const explicitDirty = coerceOptionalBool(cli.raw['worktree-dirty']);
const commit = cli.raw.commit ?? detectCommit(cli.root);
const worktreeDirty = explicitDirty ?? detectDirty(cli.root);

const corpusEntry = {
  name: cli.raw['corpus-name'] ?? path.basename(cli.root),
  repo: cli.raw.repo ?? cli.root,
  commit: commit ?? null,
  snapshotId: cli.raw['snapshot-id'] ?? null,
  worktreeDirty,
  contentHash: cli.raw['content-hash'] ?? null,
  locBucket: cli.raw['loc-bucket'] ?? 'other',
  packageManager: cli.raw['package-manager'] ?? inferPackageManager(cli.root),
  includeTests: cli.includeTests,
  exclude: cli.exclude,
  reason: cli.raw.reason ?? '',
};

const adjudicationEntries = loadAdjudication(cli.raw.adjudication);
const candidateCounts = buildCandidateCounts({ fixPlan, deadClassify, canonDrift });
const schemaRoundTrip = buildSchemaRoundTrip({ manifest, canonDrift });
const runtime = runtimeFromManifest(manifest, Date.now() - t0);
const readiness = computeReadiness({
  corpus: [corpusEntry],
  candidateCounts,
  adjudicationEntries,
  schemaRoundTrip,
});

const artifact = buildMeasurementArtifact({
  meta: {
    ...producerMetaBase({ tool: 'p6-measurement.mjs', root: cli.root }),
    node: process.version,
    platform: process.platform,
    output: cli.output,
  },
  corpus: [corpusEntry],
  candidateCounts,
  adjudicationEntries,
  runtime,
  schemaRoundTrip,
  readiness,
});

const outPath = path.join(cli.output, 'p6-measurement.json');
writeFileSync(outPath, JSON.stringify(artifact, null, 2));

process.stdout.write(`[p6-measurement] wrote ${outPath}\n`);
process.stdout.write(`[p6-measurement] readiness=${readiness.gate}\n`);
