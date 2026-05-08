import { existsSync } from 'node:fs';
import path from 'node:path';

import { scanScopeStatusForPath } from './collect-files.mjs';
import {
  GENERATED_ARTIFACT_MISSING_REASON,
  isGeneratedArtifactMissingRecord,
} from './generated-artifact-evidence.mjs';

export const GENERATED_CONSUMER_BLIND_ZONE_REASON = 'generated-consumer-blind-zone';
export const GENERATED_BLIND_ZONE_RELEVANCE_POLICY_VERSION = 'generated-blind-zone-relevance.v1';

function slash(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function sameSubmodule(submoduleOf, a, b) {
  if (typeof submoduleOf !== 'function' || !a || !b) return false;
  return submoduleOf(a) === submoduleOf(b);
}

function pathInsideDir(file, dir) {
  const f = slash(file);
  const d = slash(dir).replace(/\/+$/, '');
  return !!d && (f === d || f.startsWith(`${d}/`));
}

function generatedPackageRoot(record) {
  const artifact = record?.generatedArtifact ?? {};
  return artifact.packageRoot ?? artifact.packageDir ?? artifact.workspaceRoot ?? null;
}

function targetCandidates(record) {
  return Array.isArray(record?.targetCandidates)
    ? record.targetCandidates.filter((p) => typeof p === 'string' && p.length > 0)
    : [];
}

function toRepoRelative(root, candidate) {
  const resolvedRoot = path.resolve(root ?? process.cwd());
  const abs = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(resolvedRoot, candidate);
  const rel = path.relative(resolvedRoot, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return slash(rel);
}

function packageRootFromCandidate(candidatePath) {
  const parts = slash(candidatePath).split('/');
  if ((parts[0] === 'apps' || parts[0] === 'packages') && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return null;
}

function consumerZoneScopeRoot(record, candidatePath) {
  return generatedPackageRoot(record) ?? packageRootFromCandidate(candidatePath);
}

function consumerZoneKey(zone) {
  return [
    zone.specifier ?? '',
    zone.consumerFile ?? '',
    zone.candidatePath ?? '',
    zone.mode ?? '',
  ].join('|');
}

export function buildGeneratedConsumerBlindZones(symbolsOrRecords, {
  root = process.cwd(),
  includeTests = true,
  exclude = [],
  mode = 'default',
} = {}) {
  const records = Array.isArray(symbolsOrRecords)
    ? symbolsOrRecords
    : (symbolsOrRecords?.unresolvedInternalSpecifierRecords ?? []);
  const zones = [];
  const seen = new Set();

  for (const record of records) {
    if (!isGeneratedArtifactMissingRecord(record)) continue;
    const artifact = record.generatedArtifact ?? {};
    for (const candidate of targetCandidates(record)) {
      const candidatePath = toRepoRelative(root, candidate);
      if (!candidatePath) continue;
      const scopePackageRoot = consumerZoneScopeRoot(record, candidatePath);
      if (!scopePackageRoot) continue;

      const absCandidate = path.resolve(path.resolve(root), candidatePath);
      const present = existsSync(absCandidate);
      let status = 'missing';
      let scanScopeReason;
      if (present) {
        const scope = scanScopeStatusForPath(root, absCandidate, { includeTests, exclude });
        if (scope.included) continue;
        status = 'present-but-out-of-scope';
        scanScopeReason = scope.reason ?? 'excluded';
      }

      const zone = {
        reason: GENERATED_CONSUMER_BLIND_ZONE_REASON,
        sourceReason: record.reason,
        specifier: record.specifier,
        consumerFile: record.consumerFile ?? record.fromHint ?? null,
        matchedPackage: artifact.matchedPackage ?? null,
        targetSubpath: artifact.targetSubpath ?? null,
        generatorFamily: artifact.generatorFamily ?? null,
        confidence: artifact.confidence ?? null,
        candidatePath,
        status,
        scopePackageRoot,
        mode,
        ...(scanScopeReason ? { scanScopeReason } : {}),
      };
      if (mode === 'prepared') {
        zone.staleStatus = 'unknown';
        zone.staleReason = 'generator-input-hash-not-recorded';
      }
      const key = consumerZoneKey(zone);
      if (seen.has(key)) continue;
      seen.add(key);
      zones.push(zone);
    }
  }

  return zones.sort((a, b) =>
    String(a.scopePackageRoot ?? '').localeCompare(String(b.scopePackageRoot ?? '')) ||
    String(a.candidatePath ?? '').localeCompare(String(b.candidatePath ?? '')) ||
    String(a.specifier ?? '').localeCompare(String(b.specifier ?? '')) ||
    String(a.consumerFile ?? '').localeCompare(String(b.consumerFile ?? '')));
}

export function generatedArtifactRelevance(finding, record, { submoduleOf } = {}) {
  if (record?.reason !== GENERATED_ARTIFACT_MISSING_REASON) return null;
  if (!isGeneratedArtifactMissingRecord(record)) return null;

  const candidateFile = slash(finding?.file);
  const packageRoot = generatedPackageRoot(record);

  if (packageRoot && pathInsideDir(candidateFile, packageRoot)) {
    return {
      impact: 'provider-surface-unresolved',
      relevance: 'matched-package-root',
    };
  }

  for (const candidate of targetCandidates(record)) {
    if (sameSubmodule(submoduleOf, candidateFile, candidate)) {
      return {
        impact: 'provider-surface-unresolved',
        relevance: 'target-candidate-submodule',
      };
    }
  }

  return null;
}

export function generatedConsumerBlindZoneRelevance(finding, zone, { submoduleOf } = {}) {
  if (zone?.reason !== GENERATED_CONSUMER_BLIND_ZONE_REASON) return null;
  const candidateFile = slash(finding?.file);
  const scopePackageRoot = slash(zone.scopePackageRoot);
  if (scopePackageRoot && pathInsideDir(candidateFile, scopePackageRoot)) {
    return {
      impact: 'consumer-surface-unresolved',
      relevance: 'generated-consumer-scope',
    };
  }
  if (sameSubmodule(submoduleOf, candidateFile, zone.candidatePath)) {
    return {
      impact: 'consumer-surface-unresolved',
      relevance: 'generated-consumer-target-submodule',
    };
  }
  return null;
}

export function generatedBlindZoneBlockingPolicy(record) {
  const consumerZone = record?.reason === GENERATED_CONSUMER_BLIND_ZONE_REASON;
  return {
    policyVersion: GENERATED_BLIND_ZONE_RELEVANCE_POLICY_VERSION,
    blockingScope: 'candidate-relevant',
    candidateRelevantWhen: consumerZone
      ? ['generated-consumer-scope', 'generated-consumer-target-submodule']
      : ['matched-package-root', 'target-candidate-submodule'],
    mustNotBlockUnrelatedCandidates: true,
  };
}

export function generatedArtifactRelevantTaint(
  finding,
  records,
  { submoduleOf, generatedConsumerBlindZones = [] } = {},
) {
  const relevant = [];
  for (const record of records ?? []) {
    const relevance = generatedArtifactRelevance(finding, record, { submoduleOf });
    if (relevance) relevant.push({ record, relevance });
  }
  for (const zone of generatedConsumerBlindZones ?? []) {
    const relevance = generatedConsumerBlindZoneRelevance(finding, zone, { submoduleOf });
    if (relevance) relevant.push({ record: zone, relevance });
  }
  if (relevant.length === 0) return null;

  const first = relevant[0];
  const record = first.record;
  const artifact = record.generatedArtifact ?? {};
  return {
    kind: 'generated-artifact-missing-relevant',
    reason: record.reason,
    specifier: record.specifier,
    specifiers: relevant.slice(0, 5).map((item) => item.record.specifier),
    total: relevant.length,
    consumerFile: record.consumerFile ?? undefined,
    fromHint: record.fromHint ?? record.consumerFile ?? undefined,
    matchedPackage: artifact.matchedPackage ?? record.matchedPackage ?? undefined,
    targetSubpath: artifact.targetSubpath ?? record.targetSubpath ?? undefined,
    generatorFamily: artifact.generatorFamily ?? record.generatorFamily ?? undefined,
    confidence: artifact.confidence ?? record.confidence ?? undefined,
    candidatePath: record.candidatePath ?? undefined,
    status: record.status ?? undefined,
    scopePackageRoot: record.scopePackageRoot ?? undefined,
    scanScopeReason: record.scanScopeReason ?? undefined,
    staleStatus: record.staleStatus ?? undefined,
    staleReason: record.staleReason ?? undefined,
    impact: first.relevance.impact,
    relevance: first.relevance.relevance,
    effect: first.relevance.impact === 'consumer-surface-unresolved'
      ? 'a generated consumer surface is missing or outside scan scope for this candidate package; generated files could hide consumers of this export'
      : 'a missing generated artifact is in the candidate-relevant provider package or target surface; generated files could affect this cleanup claim',
  };
}
