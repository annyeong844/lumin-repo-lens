import {
  GENERATED_ARTIFACT_MISSING_REASON,
  isGeneratedArtifactMissingRecord,
} from './generated-artifact-evidence.mjs';

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

export function generatedArtifactRelevance(finding, record, { submoduleOf } = {}) {
  if (record?.reason !== GENERATED_ARTIFACT_MISSING_REASON) return null;
  if (!isGeneratedArtifactMissingRecord(record)) return null;

  const candidateFile = slash(finding?.file);
  const consumerFile = slash(record.consumerFile ?? record.fromHint ?? '');
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

  if (sameSubmodule(submoduleOf, candidateFile, consumerFile)) {
    return {
      impact: 'provider-surface-unresolved',
      relevance: 'same-consumer-submodule',
    };
  }

  return null;
}

export function generatedArtifactRelevantTaint(finding, records, { submoduleOf } = {}) {
  const relevant = [];
  for (const record of records ?? []) {
    const relevance = generatedArtifactRelevance(finding, record, { submoduleOf });
    if (relevance) relevant.push({ record, relevance });
  }
  if (relevant.length === 0) return null;

  const first = relevant[0];
  const record = first.record;
  const artifact = record.generatedArtifact ?? {};
  return {
    kind: 'generated-artifact-missing-relevant',
    specifier: record.specifier,
    specifiers: relevant.slice(0, 5).map((item) => item.record.specifier),
    total: relevant.length,
    consumerFile: record.consumerFile ?? undefined,
    fromHint: record.fromHint ?? record.consumerFile ?? undefined,
    matchedPackage: artifact.matchedPackage ?? undefined,
    targetSubpath: artifact.targetSubpath ?? undefined,
    generatorFamily: artifact.generatorFamily ?? undefined,
    confidence: artifact.confidence ?? undefined,
    impact: first.relevance.impact,
    relevance: first.relevance.relevance,
    effect: 'a missing generated artifact is in the candidate-relevant package or import surface; generated files could affect this cleanup claim',
  };
}
