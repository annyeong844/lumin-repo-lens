// _lib/audit-manifest.mjs
//
// Helpers for audit-repo.mjs manifest evidence and artifact enumeration.
// NO orchestration. NO child process execution.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { detectBlindZones } from './blind-zones.mjs';
import { loadIfExists as loadArtifact } from './artifacts.mjs';

export const LIVING_AUDIT_DOC_CANDIDATES = [
  'docs/current/audit/lumin-structural-audit.md',
  'LUMIN_REPO_LENS.md',
  'LUMIN_AUDIT.md',
  'TECH_DEBT_AUDIT.md',
];

const ARTIFACT_CANDIDATES = [
  'triage.json', 'topology.json', 'discipline.json',
  'call-graph.json', 'barrels.json', 'shape-index.json',
  'function-clones.json',
  'symbols.json', 'dead-classify.json', 'runtime-evidence.json',
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

export function detectLivingAuditDocs(root) {
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
}) {
  const triage = loadArtifact(outDir, 'triage.json');
  const symbols = loadArtifact(outDir, 'symbols.json');
  const deadClassify = loadArtifact(outDir, 'dead-classify.json');

  const parseErrors = (() => {
    const w = (symbols?.meta?.warnings ?? []).find((x) =>
      x?.kind === 'parse-errors' || x?.type === 'parse-errors');
    return w?.count ?? 0;
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
    livingAudit: detectLivingAuditDocs(root),
  };
}

export function refreshManifestEvidence(manifest, options) {
  const evidence = buildManifestEvidence(options);
  manifest.scanRange = evidence.scanRange;
  manifest.confidence = evidence.confidence;
  manifest.blindZones = evidence.blindZones;
  manifest.livingAudit = evidence.livingAudit;
}
