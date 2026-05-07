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
  'symbols.json', 'entry-surface.json', 'module-reachability.json',
  'dead-classify.json', 'runtime-evidence.json',
  'staleness.json', 'fix-plan.json', 'checklist-facts.json',
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

function sortCounterObject(counter) {
  return Object.fromEntries([...counter.entries()]
    .sort((a, b) => a[0].localeCompare(b[0])));
}

function toRepoRelative(root, candidate) {
  const abs = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(root, candidate);
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
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
    presentButOutOfScopeCount: presentButOutOfScope.length,
    presentButOutOfScope: presentButOutOfScope.sort((a, b) =>
      String(a.candidatePath ?? '').localeCompare(String(b.candidatePath ?? '')) ||
      String(a.specifier ?? '').localeCompare(String(b.specifier ?? '')) ||
      String(a.consumerFile ?? '').localeCompare(String(b.consumerFile ?? ''))),
    supportedGenerators: [],
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
    blindZones: detectBlindZones({ triage, symbols, deadClassify }),
    generatedArtifacts: buildGeneratedArtifactsSummary(symbols, {
      root,
      includeTests,
      excludes,
      generatedArtifactsMode,
    }),
    livingAudit: detectLivingAuditDocs(root),
  };
}

export function refreshManifestEvidence(manifest, options) {
  const evidence = buildManifestEvidence(options);
  manifest.scanRange = evidence.scanRange;
  manifest.confidence = evidence.confidence;
  manifest.blindZones = evidence.blindZones;
  manifest.generatedArtifacts = evidence.generatedArtifacts;
  manifest.livingAudit = evidence.livingAudit;
}
