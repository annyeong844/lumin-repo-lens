import { isGeneratedArtifactMissingRecord } from './generated-artifact-evidence.mjs';
import { TAINT } from './vocab.mjs';

export const RESOLVER_BLIND_ZONE_RELEVANCE_POLICY_VERSION = 'resolver-blind-zone-relevance.v1';

const EXT_RE = /\.(d\.[cm]?ts|tsx?|jsx?|mjs|cjs|mts|cts)$/;

function slash(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function stripExt(value) {
  return slash(value).replace(EXT_RE, '');
}

function pathInsideDir(file, dir) {
  const f = slash(file);
  const d = slash(dir).replace(/\/+$/, '');
  return !!d && (f === d || f.startsWith(`${d}/`));
}

function sameSubmodule(submoduleOf, a, b) {
  if (typeof submoduleOf !== 'function' || !a || !b) return false;
  return submoduleOf(a) === submoduleOf(b);
}

function packageRootFromPath(file) {
  const parts = slash(file).split('/');
  if ((parts[0] === 'apps' || parts[0] === 'packages') && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return null;
}

function targetCandidates(record) {
  return Array.isArray(record?.targetCandidates)
    ? record.targetCandidates.filter((value) => typeof value === 'string' && value.length > 0)
    : [];
}

function affectedPackageScope(record) {
  if (typeof record?.affectedPackageScope === 'string') return slash(record.affectedPackageScope);
  if (typeof record?.packageRoot === 'string') return slash(record.packageRoot);
  for (const candidate of targetCandidates(record)) {
    const root = packageRootFromPath(candidate);
    if (root) return root;
  }
  return null;
}

function fileStemMatchesCandidate(file, candidate) {
  const fileStem = stripExt(file);
  const candidateStem = stripExt(candidate);
  return fileStem === candidateStem ||
    fileStem === `${candidateStem}/index` ||
    candidateStem === `${fileStem}/index`;
}

function familyForRecord(record) {
  if (record?.family) return record.family;
  if (record?.resolverStage === 'import-meta-glob' || record?.unsupportedFamily === 'dynamic-modules') {
    return 'dynamic-modules';
  }
  if (record?.unsupportedFamily === 'output-to-source-mapping' ||
      record?.reason === 'output-source-layout-unsupported') {
    return 'output-to-source-mapping';
  }
  if (record?.resolverStage === 'hash-imports' || String(record?.specifier ?? '').startsWith('#')) {
    return 'node-imports';
  }
  if (record?.resolverStage === 'tsconfig-paths' ||
      record?.reason === 'tsconfig-path-target-missing' ||
      record?.reason === 'exact-alias-target-missing' ||
      record?.reason === 'wildcard-alias-target-missing') {
    return 'tsconfig-paths';
  }
  if (record?.reason === 'workspace-package-subpath-target-missing') {
    return 'workspace-packages';
  }
  if (record?.reason === 'condition-profile-ambiguous') {
    return 'conditional-exports';
  }
  return 'unknown';
}

function isResolverBlindZoneRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (isGeneratedArtifactMissingRecord(record)) return false;
  if (record.family === 'generated-artifacts') return false;
  if (record.outputLevel === 'resolved') return false;
  return !!(record.reason || record.family || record.resolverStage || targetCandidates(record).length);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

export function resolverBlindZoneBlockingPolicy(record) {
  if (!isResolverBlindZoneRecord(record)) return null;

  const candidates = targetCandidates(record);
  const hasExplicitScope =
    typeof record?.affectedPackageScope === 'string' ||
    typeof record?.packageRoot === 'string';
  const candidateRelevantWhen = [];
  if (candidates.length > 0) {
    candidateRelevantWhen.push(
      'target-candidate-file',
      'target-candidate-package-scope',
      'target-candidate-submodule',
    );
  }
  if (hasExplicitScope) candidateRelevantWhen.push('affected-package-scope');

  if (candidateRelevantWhen.length > 0) {
    return {
      policyVersion: RESOLVER_BLIND_ZONE_RELEVANCE_POLICY_VERSION,
      blockingScope: 'candidate-relevant',
      candidateRelevantWhen: unique(candidateRelevantWhen),
      mustNotBlockUnrelatedCandidates: true,
    };
  }

  return {
    policyVersion: RESOLVER_BLIND_ZONE_RELEVANCE_POLICY_VERSION,
    blockingScope: 'repo-confidence-limited',
    candidateRelevantWhen: ['owner-unknown-internal'],
    mustNotBlockUnrelatedCandidates: false,
  };
}

export function resolverBlindZoneRelevance(finding, record, { submoduleOf } = {}) {
  if (!isResolverBlindZoneRecord(record)) return null;

  const findingFile = slash(finding?.file);
  if (!findingFile) return null;

  for (const candidate of targetCandidates(record)) {
    if (fileStemMatchesCandidate(findingFile, candidate)) {
      return {
        impact: 'resolver-surface-unresolved',
        relevance: 'target-candidate-file',
        severity: 'blocking',
      };
    }
  }

  const scope = affectedPackageScope(record);
  if (scope && pathInsideDir(findingFile, scope)) {
    return {
      impact: 'resolver-surface-unresolved',
      relevance: record?.affectedPackageScope ? 'affected-package-scope' : 'target-candidate-package-scope',
      severity: 'soft',
    };
  }

  for (const candidate of targetCandidates(record)) {
    if (sameSubmodule(submoduleOf, findingFile, candidate)) {
      return {
        impact: 'resolver-surface-unresolved',
        relevance: 'target-candidate-submodule',
        severity: 'soft',
      };
    }
  }

  return null;
}

export function resolverBlindZoneRelevantTaint(finding, records, { submoduleOf } = {}) {
  const relevant = [];
  for (const record of records ?? []) {
    const relevance = resolverBlindZoneRelevance(finding, record, { submoduleOf });
    if (relevance) relevant.push({ record, relevance });
  }
  if (relevant.length === 0) return null;

  const first = relevant[0];
  const record = first.record;
  return {
    kind: first.relevance.severity === 'blocking'
      ? TAINT.UNRESOLVED_SPEC_MATCH
      : TAINT.RESOLVER_BLIND_ZONE_RELEVANT,
    reason: record.reason ?? 'unknown-internal-resolution',
    family: familyForRecord(record),
    specifier: record.specifier,
    specifiers: relevant.slice(0, 5).map((item) => item.record.specifier).filter(Boolean),
    total: relevant.length,
    consumerFile: record.consumerFile ?? undefined,
    fromHint: record.fromHint ?? record.consumerFile ?? undefined,
    targetCandidates: targetCandidates(record).length ? targetCandidates(record).slice(0, 5).sort() : undefined,
    affectedPackageScope: affectedPackageScope(record) ?? undefined,
    resolverStage: record.resolverStage ?? undefined,
    outputLevel: record.outputLevel ?? 'unresolved_with_reason',
    impact: first.relevance.impact,
    relevance: first.relevance.relevance,
    effect: first.relevance.severity === 'blocking'
      ? 'an unresolved resolver blind zone has a concrete target candidate matching this file; resolving it could surface a consumer'
      : 'an unresolved resolver blind zone overlaps this candidate package or target surface; unresolved imports could hide consumers of this export',
  };
}
