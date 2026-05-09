// _lib/audit-manifest.mjs
//
// Helpers for audit-repo.mjs manifest evidence and artifact enumeration.
// NO orchestration. NO child process execution.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { detectBlindZones } from './blind-zones.mjs';
import { loadIfExists as loadArtifact } from './artifacts.mjs';
import { scanScopeStatusForPath } from './collect-files.mjs';
import { normalizeGeneratedArtifactsMode } from './generated-artifact-mode.mjs';
import {
  GENERATED_ARTIFACT_MISSING_REASON,
  GENERATED_ARTIFACT_POLICY_VERSION,
} from './generated-artifact-evidence.mjs';
import {
  buildBlockedCandidateHintFamilyCounts,
  buildBlockedCandidateHintReasonCounts,
  sortCounterObject,
} from './resolver-blocked-hints.mjs';

const LIVING_AUDIT_DOC_CANDIDATES = [
  'docs/current/audit/lumin-structural-audit.md',
  'LUMIN_REPO_LENS.md',
  'LUMIN_AUDIT.md',
  'TECH_DEBT_AUDIT.md',
];

const ARTIFACT_CANDIDATES = [
  'triage.json', 'topology.json', 'discipline.json',
  'call-graph.json', 'barrels.json', 'shape-index.json',
  'function-clones.json',
  'framework-resource-surfaces.json',
  'resolver-capabilities.json', 'resolver-diagnostics.json',
  'symbols.json', 'entry-surface.json', 'module-reachability.json',
  'dead-classify.json', 'runtime-evidence.json',
  'staleness.json', 'fix-plan.json', 'checklist-facts.json',
  'producer-performance.json',
  'canon-drift.json', 'topology.mermaid.md', 'audit-summary.latest.md',
  'audit-review-pack.latest.md', 'lumin-repo-lens.sarif',
];

const DYNAMIC_ARTIFACT_PATTERNS = [
  /^canon-drift\..+\.md$/,
  /^pre-write-advisory(?:\..+)?\.json$/,
  /^post-write-delta(?:\..+)?\.json$/,
  /^any-inventory\.pre\..+\.json$/,
  /^any-inventory\.post\..+\.json$/,
];

const RESOLVER_BLOCKED_CANDIDATE_HINT_SAMPLE_LIMIT = 10;

function languagesFromTriage(triage) {
  const byLanguage = triage?.byLanguage ?? triage?.languages ?? triage?.summary?.byLanguage;
  if (byLanguage && typeof byLanguage === 'object') return Object.keys(byLanguage);

  const shape = triage?.shape ?? {};
  const languages = [];
  if ((shape.tsFiles ?? 0) > 0) languages.push('ts');
  if ((shape.jsFiles ?? 0) > 0) languages.push('js');
  if ((shape.pyFiles ?? 0) > 0) languages.push('py');
  if ((shape.goFiles ?? 0) > 0) languages.push('go');
  return languages.length > 0 ? languages : null;
}

function detectLivingAuditDocs(root) {
  const docs = [];
  for (const rel of LIVING_AUDIT_DOC_CANDIDATES) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;
    docs.push({
      path: rel,
      absolutePath: abs,
    });
  }
  return {
    preferredPath: LIVING_AUDIT_DOC_CANDIDATES[0],
    existingDocs: docs,
    action: docs.length > 0
      ? 'read-and-update-before-final-answer'
      : 'create-only-on-explicit-tracking-request',
  };
}

function countObjectFromSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const out = [];
  for (const [reason, value] of Object.entries(summary)) {
    const count = typeof value?.count === 'number'
      ? value.count
      : typeof value === 'number'
        ? value
        : null;
    if (count === null) continue;
    out.push({ reason, count });
  }
  return out.length ? out : null;
}

function unresolvedSpecifierRoot(specifier) {
  if (typeof specifier !== 'string' || specifier.length === 0) return null;
  if (/^[@~#]\//.test(specifier)) return specifier.slice(0, 2);
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts[0] && parts[1]) return `${parts[0]}/${parts[1]}`;
  }
  const first = specifier.split('/')[0];
  return first || null;
}

function topUnresolvedReasons(symbols) {
  const fromSummary = countObjectFromSummary(symbols?.unresolvedInternalSummaryByReason);
  const reasons = fromSummary ?? (() => {
    const counts = new Map();
    for (const record of symbols?.unresolvedInternalSpecifierRecords ?? []) {
      const reason = record?.reason ?? 'unknown-internal-resolution';
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
  })();

  return reasons
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 10);
}

function buildTopSpecifierRoots(symbols) {
  const groups = new Map();

  for (const record of symbols?.unresolvedInternalSpecifierRecords ?? []) {
    const specifierRoot = unresolvedSpecifierRoot(record?.specifier);
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
    const reason = record?.reason ?? 'unknown-internal-resolution';
    group.count++;
    group.reasons.set(reason, (group.reasons.get(reason) ?? 0) + 1);
    group.examples.push({
      specifier: record.specifier,
      consumerFile: record.consumerFile ?? null,
    });
  }

  return [...groups.values()]
    .map((group) => ({
      specifierRoot: group.specifierRoot,
      count: group.count,
      reasons: sortCounterObject(group.reasons),
      examples: group.examples
        .sort((a, b) =>
          `${a.consumerFile ?? ''}|${a.specifier ?? ''}`
            .localeCompare(`${b.consumerFile ?? ''}|${b.specifier ?? ''}`))
        .slice(0, 5),
    }))
    .sort((a, b) =>
      b.count - a.count ||
      a.specifierRoot.localeCompare(b.specifierRoot))
    .slice(0, 20);
}

function buildResolverDiagnosticsSummary(symbols, {
  resolverCapabilities = null,
  resolverDiagnostics = null,
} = {}) {
  const blockedCandidateHints = Array.isArray(resolverDiagnostics?.blockedCandidateHints)
    ? resolverDiagnostics.blockedCandidateHints.slice(0, RESOLVER_BLOCKED_CANDIDATE_HINT_SAMPLE_LIMIT)
    : [];
  return {
    resolverVersion:
      resolverDiagnostics?.resolverVersion ??
      resolverCapabilities?.resolverVersion ??
      null,
    resolverCapabilityArtifact: resolverCapabilities ? 'resolver-capabilities.json' : null,
    resolverDiagnosticsArtifact: resolverDiagnostics ? 'resolver-diagnostics.json' : null,
    unresolvedInternal: symbols?.uses?.unresolvedInternal ?? null,
    unresolvedInternalRatio: symbols?.uses?.unresolvedInternalRatio ?? null,
    blindZoneCount: resolverDiagnostics?.summary?.blindZoneCount ?? null,
    blockedCandidateHintCount: resolverDiagnostics?.summary?.blockedCandidateHintCount ?? null,
    blockedCandidateHintSampleLimit: resolverDiagnostics ? RESOLVER_BLOCKED_CANDIDATE_HINT_SAMPLE_LIMIT : null,
    blockedCandidateHints,
    blockedCandidateHintReasonCounts: buildBlockedCandidateHintReasonCounts(
      resolverDiagnostics?.blockedCandidateHints
    ),
    blockedCandidateHintFamilyCounts: buildBlockedCandidateHintFamilyCounts(
      resolverDiagnostics?.blockedCandidateHints
    ),
    candidateTargetCount: resolverDiagnostics?.summary?.candidateTargetCount ?? null,
    topFamilies: resolverDiagnostics?.summary?.topFamilies ?? [],
    topAffectedPackageScopes:
      resolverDiagnostics?.summary?.topAffectedPackageScopes ?? [],
    topUnresolvedReasons:
      resolverDiagnostics?.summary?.topUnresolvedReasons ?? topUnresolvedReasons(symbols),
    topSpecifierRoots:
      resolverDiagnostics?.summary?.topSpecifierRoots ?? buildTopSpecifierRoots(symbols),
    topUnresolvedSpecifiers: (symbols?.topUnresolvedSpecifiers ?? []).slice(0, 20),
  };
}

function toRepoRelative(root, candidate) {
  const abs = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(root, candidate);
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function sortedGeneratedConsumerZoneExamples(zones) {
  return [...zones]
    .sort((a, b) =>
      String(a.consumerFile ?? '').localeCompare(String(b.consumerFile ?? '')) ||
      String(a.candidatePath ?? '').localeCompare(String(b.candidatePath ?? '')) ||
      String(a.specifier ?? '').localeCompare(String(b.specifier ?? '')))
    .slice(0, 5)
    .map((zone) => ({
      specifier: zone.specifier ?? null,
      consumerFile: zone.consumerFile ?? null,
      candidatePath: zone.candidatePath ?? null,
      status: zone.status ?? null,
      ...(zone.scanScopeReason ? { scanScopeReason: zone.scanScopeReason } : {}),
      mode: zone.mode ?? null,
    }));
}

function buildGeneratedConsumerBlindZoneSummary(zones) {
  const groups = new Map();
  for (const zone of zones ?? []) {
    if (!zone || typeof zone !== 'object') continue;
    const scopePackageRoot = zone.scopePackageRoot ?? 'unknown';
    if (!groups.has(scopePackageRoot)) {
      groups.set(scopePackageRoot, {
        scopePackageRoot,
        count: 0,
        statuses: new Map(),
        specifiers: new Map(),
        zones: [],
      });
    }
    const group = groups.get(scopePackageRoot);
    group.count++;
    group.statuses.set(zone.status ?? 'unknown', (group.statuses.get(zone.status ?? 'unknown') ?? 0) + 1);
    group.specifiers.set(zone.specifier ?? 'unknown', (group.specifiers.get(zone.specifier ?? 'unknown') ?? 0) + 1);
    group.zones.push(zone);
  }

  return [...groups.values()]
    .map((group) => ({
      scopePackageRoot: group.scopePackageRoot,
      count: group.count,
      statuses: sortCounterObject(group.statuses),
      topSpecifiers: [...group.specifiers.entries()]
        .map(([specifier, count]) => ({ specifier, count }))
        .sort((a, b) => b.count - a.count || a.specifier.localeCompare(b.specifier))
        .slice(0, 5),
      examples: sortedGeneratedConsumerZoneExamples(group.zones),
    }))
    .sort((a, b) => b.count - a.count || a.scopePackageRoot.localeCompare(b.scopePackageRoot))
    .slice(0, 20);
}

function buildGeneratedArtifactsSummary(symbols, options = {}) {
  const {
    root = process.cwd(),
    includeTests = true,
    excludes = [],
    generatedArtifactsMode = 'default',
  } = options;
  const mode = normalizeGeneratedArtifactsMode(generatedArtifactsMode);
  const reasonSummary = new Map();
  const misses = new Map();
  const presentButOutOfScope = [];
  const presentKeys = new Set();
  const generatedConsumerBlindZones = Array.isArray(symbols?.generatedConsumerBlindZones)
    ? symbols.generatedConsumerBlindZones
    : [];

  for (const record of symbols?.unresolvedInternalSpecifierRecords ?? []) {
    if (record?.reason !== GENERATED_ARTIFACT_MISSING_REASON) continue;
    reasonSummary.set(record.reason, (reasonSummary.get(record.reason) ?? 0) + 1);

    const generatedArtifact = record.generatedArtifact ?? {};
    const key = [
      record.specifier ?? '',
      generatedArtifact.matchedPackage ?? '',
      generatedArtifact.targetSubpath ?? '',
      generatedArtifact.generatorFamily ?? '',
      generatedArtifact.confidence ?? '',
    ].join('|');
    if (!misses.has(key)) {
      misses.set(key, {
        specifier: record.specifier,
        matchedPackage: generatedArtifact.matchedPackage ?? null,
        targetSubpath: generatedArtifact.targetSubpath ?? null,
        count: 0,
        generatorFamily: generatedArtifact.generatorFamily ?? null,
        confidence: generatedArtifact.confidence ?? null,
      });
    }
    misses.get(key).count += 1;

    if (mode !== 'default') {
      for (const candidate of record.targetCandidates ?? []) {
        const candidatePath = toRepoRelative(root, candidate);
        if (!candidatePath) continue;
        const absCandidate = path.resolve(root, candidatePath);
        if (!existsSync(absCandidate)) continue;
        const scope = scanScopeStatusForPath(root, absCandidate, { includeTests, exclude: excludes });
        if (scope.included) continue;
        const presentKey = [
          record.specifier ?? '',
          record.consumerFile ?? '',
          candidatePath,
          mode,
        ].join('|');
        if (presentKeys.has(presentKey)) continue;
        presentKeys.add(presentKey);
        const present = {
          specifier: record.specifier,
          consumerFile: record.consumerFile ?? null,
          matchedPackage: generatedArtifact.matchedPackage ?? null,
          targetSubpath: generatedArtifact.targetSubpath ?? null,
          candidatePath,
          reason: 'present-but-out-of-scope',
          mode,
        };
        if (mode === 'prepared') {
          present.staleStatus = 'unknown';
          present.staleReason = 'generator-input-hash-not-recorded';
        }
        presentButOutOfScope.push(present);
      }
    }
  }

  const topGeneratedMisses = [...misses.values()]
    .sort((a, b) =>
      b.count - a.count ||
      String(a.matchedPackage ?? '').localeCompare(String(b.matchedPackage ?? '')) ||
      String(a.specifier ?? '').localeCompare(String(b.specifier ?? '')))
    .slice(0, 20);

  return {
    mode,
    generatedArtifactPolicyVersion: GENERATED_ARTIFACT_POLICY_VERSION,
    executedGenerators: false,
    reasonSummary: sortCounterObject(reasonSummary),
    topGeneratedMisses,
    generatedConsumerBlindZoneCount: generatedConsumerBlindZones.length,
    topGeneratedConsumerBlindZones:
      buildGeneratedConsumerBlindZoneSummary(generatedConsumerBlindZones),
    presentButOutOfScopeCount: presentButOutOfScope.length,
    presentButOutOfScope: presentButOutOfScope.sort((a, b) =>
      String(a.candidatePath ?? '').localeCompare(String(b.candidatePath ?? '')) ||
      String(a.specifier ?? '').localeCompare(String(b.specifier ?? '')) ||
      String(a.consumerFile ?? '').localeCompare(String(b.consumerFile ?? ''))),
    supportedGenerators: [],
  };
}

function buildFrameworkResourceSurfacesSummary(artifact) {
  if (!artifact || typeof artifact !== 'object') return null;
  const files = Array.isArray(artifact.files) ? artifact.files : [];
  const summary = artifact.summary ?? {};
  const topExamples = Array.isArray(summary.topExamples)
    ? summary.topExamples.slice(0, 10)
    : files.slice(0, 10).map((entry) => ({
        file: entry.file ?? null,
        lanes: (entry.surfaceLanes ?? []).map((lane) => lane.lane).filter(Boolean),
        reasons: (entry.surfaceLanes ?? []).map((lane) => lane.reason).filter(Boolean),
      }));
  return {
    artifact: 'framework-resource-surfaces.json',
    schemaVersion: artifact.schemaVersion ?? null,
    policyVersion: artifact.policyVersion ?? null,
    totalFilesWithSurfaces: summary.totalFilesWithSurfaces ?? files.length,
    totalSurfaceLanes: summary.totalSurfaceLanes ?? files.reduce(
      (count, entry) => count + (Array.isArray(entry.surfaceLanes) ? entry.surfaceLanes.length : 0),
      0,
    ),
    byLane: summary.byLane ?? {},
    byConfidence: summary.byConfidence ?? {},
    byReason: summary.byReason ?? {},
    byFramework: summary.byFramework ?? {},
    topExamples,
  };
}

export function collectProducedArtifacts(outDir) {
  const produced = new Set();
  for (const name of ARTIFACT_CANDIDATES) {
    if (existsSync(path.join(outDir, name))) produced.add(name);
  }
  let entries = [];
  try {
    entries = readdirSync(outDir, { withFileTypes: true });
  } catch {
    return Array.from(produced).sort();
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (DYNAMIC_ARTIFACT_PATTERNS.some((pattern) => pattern.test(entry.name))) {
      produced.add(entry.name);
    }
  }
  return Array.from(produced).sort();
}

export function buildManifestEvidence({
  root,
  outDir,
  includeTests,
  production,
  excludes = [],
  autoExcludes = [],
  generatedArtifactsMode = 'default',
}) {
  const triage = loadArtifact(outDir, 'triage.json');
  const symbols = loadArtifact(outDir, 'symbols.json');
  const resolverCapabilities = loadArtifact(outDir, 'resolver-capabilities.json');
  const resolverDiagnostics = loadArtifact(outDir, 'resolver-diagnostics.json');
  const frameworkResourceSurfaces = loadArtifact(outDir, 'framework-resource-surfaces.json');
  const entrySurface = loadArtifact(outDir, 'entry-surface.json');
  const deadClassify = loadArtifact(outDir, 'dead-classify.json');

  const parseErrors = (() => {
    const w = (symbols?.meta?.warnings ?? []).find((x) =>
      x?.kind === 'parse-errors' || x?.type === 'parse-errors' || x?.code === 'parse-errors');
    return w?.count ?? symbols?.filesWithParseErrors?.length ?? 0;
  })();

  return {
    scanRange: {
      root,
      includeTests,
      production,
      excludes,
      autoExcludes,
      languages: languagesFromTriage(triage),
      files: triage?.summary?.files ?? triage?.files ?? triage?.shape?.totalFiles ?? null,
    },
    confidence: {
      parseErrors,
      unresolvedInternalRatio: symbols?.uses?.unresolvedInternalRatio ?? null,
      externalImports: symbols?.uses?.external ?? null,
      resolvedInternal: symbols?.uses?.resolvedInternal ?? null,
      unresolvedInternal: symbols?.uses?.unresolvedInternal ?? null,
    },
    resolverDiagnostics: buildResolverDiagnosticsSummary(symbols, {
      resolverCapabilities,
      resolverDiagnostics,
    }),
    blindZones: detectBlindZones({ triage, symbols, deadClassify, entrySurface, resolverDiagnostics }),
    generatedArtifacts: buildGeneratedArtifactsSummary(symbols, {
      root,
      includeTests,
      excludes,
      generatedArtifactsMode,
    }),
    frameworkResourceSurfaces: buildFrameworkResourceSurfacesSummary(frameworkResourceSurfaces),
    livingAudit: detectLivingAuditDocs(root),
  };
}

export function refreshManifestEvidence(manifest, options) {
  const evidence = buildManifestEvidence(options);
  manifest.scanRange = evidence.scanRange;
  manifest.confidence = evidence.confidence;
  manifest.resolverDiagnostics = evidence.resolverDiagnostics;
  manifest.blindZones = evidence.blindZones;
  manifest.generatedArtifacts = evidence.generatedArtifacts;
  manifest.frameworkResourceSurfaces = evidence.frameworkResourceSurfaces;
  manifest.livingAudit = evidence.livingAudit;
}
