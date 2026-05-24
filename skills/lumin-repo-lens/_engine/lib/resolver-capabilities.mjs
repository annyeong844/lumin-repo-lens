import { generatedBlindZoneBlockingPolicy } from './generated-blind-zone-relevance.mjs';
import { resolverBlindZoneBlockingPolicy } from './resolver-blind-zone-relevance.mjs';

export const RESOLVER_CAPABILITIES_SCHEMA_VERSION = 'resolver-capabilities.v1';
export const RESOLVER_DIAGNOSTICS_SCHEMA_VERSION = 'resolver-diagnostics.v1';
export const RESOLVER_VERSION = 'resolver-2026-05-v1';

const CAPABILITY_ARTIFACT_NAME = 'resolver-capabilities.json';

function compactObject(obj) {
  return Object.fromEntries(Object.entries(obj)
    .filter(([, value]) => value !== undefined && value !== null));
}

function sortStrings(values = []) {
  return [...values].sort((a, b) => String(a).localeCompare(String(b)));
}

function sortByStableKey(values, keyFn) {
  return [...values].sort((a, b) => keyFn(a).localeCompare(keyFn(b)));
}

function countBy(values, keyFn) {
  const counts = new Map();
  for (const value of values ?? []) {
    const key = keyFn(value);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function counterObjectFromValues(values, keyFn) {
  return Object.fromEntries(countBy(values, keyFn).map(({ key, count }) => [key, count]));
}

function unresolvedSpecifierRoot(specifier) {
  if (typeof specifier !== 'string' || specifier.length === 0) return null;
  if (/^[@~#]\//.test(specifier)) return specifier.slice(0, 2);
  if (specifier.startsWith('#')) return '#';
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts[0] && parts[1]) return `${parts[0]}/${parts[1]}`;
  }
  const first = specifier.split('/')[0];
  return first || null;
}

function packageRootFromPath(candidatePath) {
  const parts = String(candidatePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').split('/');
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

function familyForRecord(record) {
  const reason = record?.reason;
  const stage = record?.resolverStage;
  const specifier = record?.specifier;

  if (
    reason === 'workspace-generated-artifact-missing' ||
    record?.hint === 'generated-artifact-missing' ||
    record?.generatedArtifact
  ) return 'generated-artifacts';

  if (stage === 'import-meta-glob' || record?.unsupportedFamily === 'dynamic-modules') {
    return 'dynamic-modules';
  }
  if (record?.unsupportedFamily === 'output-to-source-mapping' ||
      reason === 'output-source-layout-unsupported') {
    return 'output-to-source-mapping';
  }
  if (stage === 'hash-imports' || String(specifier ?? '').startsWith('#')) return 'node-imports';
  if (stage === 'relative') return 'relative-paths';
  if (stage === 'tsconfig-baseurl' || reason === 'baseurl-target-missing') return 'absolute-project-paths';
  if (reason === 'workspace-package-subpath-target-missing') return 'workspace-packages';
  if (stage === 'tsconfig-paths' || stage === 'exact-alias' || stage === 'wildcard-alias') {
    return 'tsconfig-paths';
  }
  if (reason === 'unknown-internal-resolution') return 'unknown-internal-resolution';
  return 'unknown';
}

function affectedPackageScopeForRecord(record) {
  if (typeof record?.affectedPackageScope === 'string') return record.affectedPackageScope;
  const artifact = record?.generatedArtifact ?? {};
  if (typeof artifact.packageRoot === 'string') return artifact.packageRoot;
  if (typeof artifact.packageDir === 'string') return artifact.packageDir;
  if (typeof artifact.workspaceRoot === 'string') return artifact.workspaceRoot;
  for (const candidate of targetCandidates(record)) {
    const root = packageRootFromPath(candidate);
    if (root) return root;
  }
  const importerRoot = packageRootFromPath(record?.consumerFile ?? record?.fromHint);
  return importerRoot;
}

function unresolvedImportKey(item) {
  return [
    item.importer ?? '',
    item.specifier ?? '',
    item.kind ?? '',
    item.reason ?? '',
  ].join('|');
}

function blindZoneKey(zone) {
  return [
    zone.family ?? '',
    zone.reason ?? '',
    zone.importer ?? '',
    zone.specifier ?? '',
    zone.affectedPackageScope ?? '',
    zone.candidatePath ?? '',
  ].join('|');
}

function candidateTargetKey(item) {
  return [
    item.importer ?? '',
    item.specifier ?? '',
    item.family ?? '',
    item.notResolvedBecause ?? '',
    ...(item.candidatePaths ?? []),
  ].join('|');
}

function blockedCandidateHintKey(item) {
  return [
    item.family ?? '',
    item.reason ?? '',
    item.importer ?? '',
    item.specifier ?? '',
    item.affectedPackageScope ?? '',
    item.candidatePath ?? '',
    item.relevance ?? '',
  ].join('|');
}

function topUnresolvedReasons(records) {
  return countBy(records, (record) => record.reason ?? 'unknown-internal-resolution')
    .map(({ key, count }) => ({ reason: key, count }))
    .slice(0, 20);
}

function topSpecifierRoots(records) {
  const groups = new Map();
  for (const record of records ?? []) {
    const specifierRoot = unresolvedSpecifierRoot(record.specifier);
    if (!specifierRoot) continue;
    if (!groups.has(specifierRoot)) {
      groups.set(specifierRoot, {
        specifierRoot,
        count: 0,
        reasons: new Map(),
        examples: [],
      });
    }
    const group = groups.get(specifierRoot);
    const reason = record.reason ?? 'unknown-internal-resolution';
    group.count++;
    group.reasons.set(reason, (group.reasons.get(reason) ?? 0) + 1);
    group.examples.push({
      specifier: record.specifier,
      consumerFile: record.consumerFile ?? record.fromHint ?? null,
    });
  }
  return [...groups.values()]
    .map((group) => ({
      specifierRoot: group.specifierRoot,
      count: group.count,
      reasons: Object.fromEntries([...group.reasons.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))),
      examples: sortByStableKey(group.examples, (item) =>
        `${item.consumerFile ?? ''}|${item.specifier ?? ''}`).slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count || a.specifierRoot.localeCompare(b.specifierRoot))
    .slice(0, 20);
}

export function buildResolverCapabilitiesArtifact() {
  return {
    schemaVersion: RESOLVER_CAPABILITIES_SCHEMA_VERSION,
    resolverVersion: RESOLVER_VERSION,
    conditionProfiles: [
      {
        profileId: 'node-esm-default',
        conditions: ['node', 'import', 'default'],
        configuredBy: 'default',
      },
    ],
    families: [
      {
        family: 'relative-paths',
        status: 'supported',
        supportedCases: ['extensionless JS/TS files', 'directory index files', 'runtime JS extension mapped to source TS'],
        unsupportedCases: [],
        reasonCodes: ['relative-target-missing'],
        absenceClaimPolicy: 'fail-closed-when-relevant',
        fixtureRefs: ['resolver-relative-basic'],
      },
      {
        family: 'absolute-project-paths',
        status: 'partial',
        supportedCases: ['scoped tsconfig baseUrl imports', 'root-prefix imports when root segment exists'],
        unsupportedCases: ['ambiguous project-reference redirected output'],
        reasonCodes: ['baseurl-target-missing', 'unknown-internal-resolution'],
        absenceClaimPolicy: 'fail-closed-when-relevant',
        fixtureRefs: ['resolver-baseurl-scoped'],
      },
      {
        family: 'node-packages',
        status: 'partial',
        supportedCases: ['external package sentinel', 'workspace package name detection'],
        unsupportedCases: ['package manager runtime hooks without static package metadata'],
        reasonCodes: ['unknown-internal-resolution'],
        absenceClaimPolicy: 'fail-closed-when-encountered',
        fixtureRefs: ['resolver-external-vs-internal'],
      },
      {
        family: 'tsconfig-paths',
        status: 'partial',
        supportedCases: ['extends chain discovery', 'single-star paths', 'nearest scope wins', 'baseUrl fallback'],
        unsupportedCases: ['ambiguous multi-target fallback', 'project-reference redirected output'],
        reasonCodes: ['tsconfig-path-target-missing', 'exact-alias-target-missing', 'wildcard-alias-target-missing'],
        absenceClaimPolicy: 'fail-closed-when-relevant',
        fixtureRefs: ['resolver-tsconfig-paths-basic'],
      },
      {
        family: 'workspace-packages',
        status: 'partial',
        supportedCases: ['workspace package root imports', 'source-direct main/module/types entries', 'legacy subpath source probing'],
        unsupportedCases: ['generated workspace subpaths without generated artifact support'],
        reasonCodes: ['workspace-package-subpath-target-missing'],
        absenceClaimPolicy: 'fail-closed-when-relevant',
        fixtureRefs: ['resolver-workspace-package-subpath'],
      },
      {
        family: 'package-json-exports',
        status: 'partial',
        supportedCases: ['string targets', 'subpath wildcard targets', 'source remapping for dist outputs'],
        unsupportedCases: ['ambiguous conditional maps without configured condition profile', 'array fallback ordering beyond supported source probes', 'non-standard output-to-source layouts without explicit source metadata'],
        reasonCodes: ['workspace-package-subpath-target-missing', 'condition-profile-ambiguous', 'output-source-layout-unsupported'],
        absenceClaimPolicy: 'fail-closed-when-relevant',
        fixtureRefs: ['resolver-package-json-exports'],
      },
      {
        family: 'output-to-source-mapping',
        status: 'partial',
        supportedCases: ['dist/build/out/es/esm/distribution output directories mapped to source conventions'],
        unsupportedCases: ['workspace package exports pointing at non-standard compiled output directories without an explicit source condition'],
        reasonCodes: ['output-source-layout-unsupported'],
        absenceClaimPolicy: 'fail-closed-when-relevant',
        fixtureRefs: ['resolver-output-source-layout-unsupported'],
      },
      {
        family: 'package-json-entry-fields',
        status: 'partial',
        supportedCases: ['main', 'module', 'types', 'browser as package entry candidates'],
        unsupportedCases: ['environment-specific browser/node divergence without explicit condition profile'],
        reasonCodes: ['workspace-package-subpath-target-missing'],
        absenceClaimPolicy: 'fail-closed-when-relevant',
        fixtureRefs: ['resolver-package-entry-fields'],
      },
      {
        family: 'node-imports',
        status: 'partial',
        supportedCases: ['package-local #imports wildcard maps'],
        unsupportedCases: ['ambiguous condition maps in imports', 'custom condition profiles not configured by scan'],
        reasonCodes: ['condition-profile-ambiguous', 'hash-import-target-missing', 'hash-imports-unsupported'],
        absenceClaimPolicy: 'fail-closed-when-encountered',
        fixtureRefs: ['resolver-node-imports-hash-wildcard'],
      },
      {
        family: 'json-imports',
        status: 'partial',
        supportedCases: ['file-level non-source asset reachability'],
        unsupportedCases: ['named JS export identity from JSON without an explicit transform'],
        reasonCodes: [],
        absenceClaimPolicy: 'file-reachability-only',
        fixtureRefs: ['resolver-json-file-edge'],
      },
      {
        family: 'generated-artifacts',
        status: 'partial',
        supportedCases: ['generated artifact miss taxonomy', 'generated consumer blind-zone diagnostics', 'Prisma enum virtual surface'],
        unsupportedCases: ['generator execution by default', 'runtime equivalence for virtual surfaces'],
        reasonCodes: ['workspace-generated-artifact-missing', 'generated-consumer-blind-zone'],
        absenceClaimPolicy: 'fail-closed-when-relevant',
        fixtureRefs: ['resolver-generated-artifact-missing'],
      },
      {
        family: 'dynamic-modules',
        status: 'partial',
        supportedCases: ['literal dynamic import() member precision'],
        unsupportedCases: ['import.meta.glob expansion and non-literal dynamic module discovery'],
        reasonCodes: ['import-meta-glob-unsupported'],
        absenceClaimPolicy: 'fail-closed-when-relevant',
        fixtureRefs: ['resolver-import-meta-glob-unsupported'],
      },
      {
        family: 'conditional-exports',
        status: 'partial',
        supportedCases: ['default node/import condition profile'],
        unsupportedCases: ['browser/node ambiguity', 'custom conditions without configured profile'],
        reasonCodes: ['condition-profile-ambiguous'],
        absenceClaimPolicy: 'fail-closed-when-relevant',
        fixtureRefs: ['resolver-conditional-exports-basic'],
      },
      {
        family: 're-export-aliases',
        status: 'supported',
        supportedCases: ['exported-name to local-name tracking', 'definition id preservation'],
        unsupportedCases: [],
        reasonCodes: [],
        absenceClaimPolicy: 'definition-identity-preserved',
        fixtureRefs: ['resolver-re-export-alias-identity'],
      },
    ],
  };
}

function buildUnresolvedImports(records) {
  return sortByStableKey(records.map((record) => compactObject({
    specifier: record.specifier,
    importer: record.consumerFile ?? record.fromHint,
    kind: record.kind,
    typeOnly: typeof record.typeOnly === 'boolean' ? record.typeOnly : undefined,
    family: familyForRecord(record),
    reason: record.reason ?? 'unknown-internal-resolution',
    resolverStage: record.resolverStage,
    outputLevel: record.outputLevel ?? 'unresolved_with_reason',
    unsupportedFamily: record.unsupportedFamily,
    createsGraphEdge: false,
    matchedPattern: record.matchedPattern,
    source: record.source,
    targetCandidates: targetCandidates(record).length ? sortStrings(targetCandidates(record)) : undefined,
    hint: record.hint,
    matchCount: typeof record.matchCount === 'number' ? record.matchCount : undefined,
    cap: typeof record.cap === 'number' ? record.cap : undefined,
    scanPolicy: record.scanPolicy,
    generatedArtifact: record.generatedArtifact,
  })), unresolvedImportKey);
}

function buildUnsupportedImports(records) {
  return buildUnresolvedImports(records.filter((record) => record?.outputLevel === 'unsupported'));
}

function buildCandidateTargets(records) {
  const items = [];
  for (const record of records ?? []) {
    const candidates = targetCandidates(record);
    if (candidates.length === 0) continue;
    items.push(compactObject({
      specifier: record.specifier,
      importer: record.consumerFile ?? record.fromHint,
      family: familyForRecord(record),
      outputLevel: 'candidate',
      proofUse: 'diagnostic-only',
      createsGraphEdge: false,
      candidatePaths: sortStrings(candidates),
      notResolvedBecause: record.reason ?? 'unknown-internal-resolution',
      resolverStage: record.resolverStage,
    }));
  }
  return sortByStableKey(items, candidateTargetKey);
}

function blindZoneFromRecord(record) {
  const family = familyForRecord(record);
  const reason = record.reason ?? 'unknown-internal-resolution';
  const generated = family === 'generated-artifacts';
  const relevancePolicy = generated
    ? generatedBlindZoneBlockingPolicy(record)
    : resolverBlindZoneBlockingPolicy(record);
  return compactObject({
    family,
    reason,
    importer: record.consumerFile ?? record.fromHint,
    specifier: record.specifier,
    resolverStage: record.resolverStage,
    outputLevel: record.outputLevel ?? 'unresolved_with_reason',
    unsupportedFamily: record.unsupportedFamily,
    affectedPackageScope: affectedPackageScopeForRecord(record),
    blocksAbsenceClaims: true,
    blockingScope: relevancePolicy?.blockingScope,
    relevancePolicy,
    relevance: generated ? 'generated-provider-surface' : 'unresolved-internal-surface',
    targetCandidates: targetCandidates(record).length ? sortStrings(targetCandidates(record)) : undefined,
    matchCount: typeof record.matchCount === 'number' ? record.matchCount : undefined,
    cap: typeof record.cap === 'number' ? record.cap : undefined,
    scanPolicy: record.scanPolicy,
    typeOnly: typeof record.typeOnly === 'boolean' ? record.typeOnly : undefined,
    generatedArtifact: record.generatedArtifact,
  });
}

function blindZoneFromGeneratedConsumer(zone) {
  const relevancePolicy = generatedBlindZoneBlockingPolicy(zone);
  return compactObject({
    family: 'generated-artifacts',
    reason: zone.reason,
    sourceReason: zone.sourceReason,
    importer: zone.consumerFile,
    specifier: zone.specifier,
    outputLevel: 'unresolved_with_reason',
    affectedPackageScope: zone.scopePackageRoot,
    blocksAbsenceClaims: true,
    blockingScope: relevancePolicy.blockingScope,
    relevancePolicy,
    relevance: 'generated-consumer-scope',
    candidatePath: zone.candidatePath,
    status: zone.status,
    mode: zone.mode,
    staleStatus: zone.staleStatus,
    staleReason: zone.staleReason,
    matchedPackage: zone.matchedPackage,
    targetSubpath: zone.targetSubpath,
    generatorFamily: zone.generatorFamily,
    confidence: zone.confidence,
  });
}

function buildBlindZones(records, generatedConsumerBlindZones) {
  const zones = [
    ...records.map(blindZoneFromRecord),
    ...(generatedConsumerBlindZones ?? []).map(blindZoneFromGeneratedConsumer),
  ];
  const seen = new Set();
  const deduped = [];
  for (const zone of sortByStableKey(zones, blindZoneKey)) {
    const key = blindZoneKey(zone);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(zone);
  }
  return deduped;
}

function buildBlockedCandidateHints(blindZones) {
  const hints = [];
  for (const zone of blindZones ?? []) {
    if (zone?.blocksAbsenceClaims !== true || zone.blockingScope !== 'candidate-relevant') continue;
    const base = compactObject({
      family: zone.family,
      reason: zone.reason,
      importer: zone.importer,
      specifier: zone.specifier,
      affectedPackageScope: zone.affectedPackageScope,
      blockingScope: zone.blockingScope,
      relevance: zone.relevance,
      proofUse: 'blocks-absence-claim',
      outputLevel: zone.outputLevel,
    });
    const paths = sortStrings([
      ...(typeof zone.candidatePath === 'string' ? [zone.candidatePath] : []),
      ...(Array.isArray(zone.targetCandidates) ? zone.targetCandidates : []),
    ]);
    if (paths.length === 0) {
      hints.push(base);
      continue;
    }
    for (const candidatePath of paths) {
      hints.push({ ...base, candidatePath });
    }
  }

  const seen = new Set();
  const deduped = [];
  for (const hint of sortByStableKey(hints, blockedCandidateHintKey)) {
    const key = blockedCandidateHintKey(hint);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(hint);
  }
  return deduped;
}

function topFamilies(unresolvedImports, blindZones) {
  return countBy([...unresolvedImports, ...blindZones], (item) => item.family)
    .map(({ key, count }) => ({ family: key, count }))
    .slice(0, 20);
}

function topAffectedPackageScopes(blindZones) {
  return countBy(blindZones, (zone) => zone.affectedPackageScope)
    .map(({ key, count }) => ({ affectedPackageScope: key, count }))
    .slice(0, 20);
}

export function buildResolverDiagnosticsArtifact(symbolsData, {
  capabilityArtifact = CAPABILITY_ARTIFACT_NAME,
} = {}) {
  const records = Array.isArray(symbolsData?.unresolvedInternalSpecifierRecords)
    ? symbolsData.unresolvedInternalSpecifierRecords
    : [];
  const generatedConsumerBlindZones = Array.isArray(symbolsData?.generatedConsumerBlindZones)
    ? symbolsData.generatedConsumerBlindZones
    : [];

  const unresolvedImports = buildUnresolvedImports(records);
  const unsupportedImports = buildUnsupportedImports(records);
  const candidateTargets = buildCandidateTargets(records);
  const blindZones = buildBlindZones(records, generatedConsumerBlindZones);
  const blockedCandidateHints = buildBlockedCandidateHints(blindZones);

  return {
    schemaVersion: RESOLVER_DIAGNOSTICS_SCHEMA_VERSION,
    resolverVersion: RESOLVER_VERSION,
    capabilityArtifact,
    capabilityReference: {
      artifact: capabilityArtifact,
      schemaVersion: RESOLVER_CAPABILITIES_SCHEMA_VERSION,
      resolverVersion: RESOLVER_VERSION,
    },
    summary: {
      unresolvedInternal: symbolsData?.uses?.unresolvedInternal ?? records.length,
      unresolvedInternalRatio: symbolsData?.uses?.unresolvedInternalRatio ?? null,
      externalImports: symbolsData?.uses?.external ?? null,
      blindZoneCount: blindZones.length,
      blockedCandidateHintCount: blockedCandidateHints.length,
      candidateTargetCount: candidateTargets.length,
      unresolvedImportCount: unresolvedImports.length,
      unsupportedImportCount: unsupportedImports.length,
      topFamilies: topFamilies(unresolvedImports, blindZones),
      topAffectedPackageScopes: topAffectedPackageScopes(blindZones),
      topUnresolvedReasons: topUnresolvedReasons(records),
      topSpecifierRoots: topSpecifierRoots(records),
      reasonCounts: counterObjectFromValues(records, (record) =>
        record.reason ?? 'unknown-internal-resolution'),
    },
    blindZones,
    blockedCandidateHints,
    candidateTargets,
    unsupportedImports,
    unresolvedImports,
    topUnresolvedSpecifiers: (symbolsData?.topUnresolvedSpecifiers ?? []).slice(0, 20),
  };
}
