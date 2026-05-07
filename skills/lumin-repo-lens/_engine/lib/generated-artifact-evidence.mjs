import { relPath } from './paths.mjs';

export const GENERATED_ARTIFACT_POLICY_VERSION = 'generated-artifact-policy-v1';
export const GENERATED_ARTIFACT_MISSING_HINT = 'generated-artifact-missing';
export const GENERATED_ARTIFACT_MISSING_REASON = 'workspace-generated-artifact-missing';

const OUTPUT_ARTIFACT_DIRS = new Set([
  'dist',
  'distribution',
  'build',
  'out',
  'es',
  'esm',
]);

export function evidence(kind, field, matched) {
  return { kind, field, matched };
}

function normalizedPackageFileEntries(pkgJson) {
  return Array.isArray(pkgJson.files)
    ? pkgJson.files
      .map((file) => String(file).replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+$/, ''))
      .filter(Boolean)
    : [];
}

function fileEntryCoversTarget(fileEntry, targetSubpath) {
  return fileEntry === targetSubpath || targetSubpath.startsWith(`${fileEntry}/`);
}

function buildScriptEvidence(pkgJson) {
  return Object.entries(pkgJson.scripts ?? {})
    .filter(([key, value]) =>
      /\b(build|bundle|compile|prepack|prepare)\b/i.test(String(key)) &&
      /\b(vite|rollup|webpack|tsup|tsc|swc|postcss|parcel|esbuild|unbuild)\b/i.test(String(value)))
    .map(([key, value]) => evidence('package-script', `scripts.${key}`, String(value)));
}

function staticOutputPathsFromScriptCommand(command) {
  const outputs = new Set();
  const re = /(?:^|\s)(?:-o|--output(?:-file)?|--out-file)\s+["']?([^"'`\s;&|]+\.[A-Za-z0-9]+)["']?/g;
  for (const match of String(command ?? '').matchAll(re)) {
    const output = String(match[1] ?? '')
      .replace(/^\.\//, '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
    if (output) outputs.add(output);
  }
  return [...outputs].sort();
}

function staticScriptOutputEvidence(pkgJson, targetSubpath) {
  const items = [];
  for (const [key, value] of Object.entries(pkgJson.scripts ?? {})) {
    if (!staticOutputPathsFromScriptCommand(value).includes(targetSubpath)) continue;
    items.push(evidence('package-script', `scripts.${key}`, String(value)));
    items.push(evidence('script-output-path', `scripts.${key}`, targetSubpath));
  }
  return items;
}

export function generatedOutputArtifactEvidence(pkgJson, target, sourceField, { outputArtifactDirs = OUTPUT_ARTIFACT_DIRS } = {}) {
  const targetSubpath = String(target ?? '').replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
  const firstSegment = targetSubpath.split('/')[0] ?? '';
  const outputDirs = outputArtifactDirs instanceof Set
    ? outputArtifactDirs
    : new Set(outputArtifactDirs);
  const filesEvidence = normalizedPackageFileEntries(pkgJson)
    .filter((entry) => fileEntryCoversTarget(entry, targetSubpath))
    .map((entry) => evidence('package-files', 'files', entry));
  if (filesEvidence.length === 0) return null;

  const scripts = buildScriptEvidence(pkgJson);
  if (outputDirs.has(firstSegment) && scripts.length > 0) {
    return {
      policyVersion: GENERATED_ARTIFACT_POLICY_VERSION,
      generatorFamily: 'build-output',
      confidence: 'strong',
      matchedPackage: pkgJson.name,
      targetSubpath,
      evidence: [
        evidence('package-json-target', sourceField, targetSubpath),
        ...filesEvidence,
        ...scripts,
      ],
    };
  }

  const staticScripts = staticScriptOutputEvidence(pkgJson, targetSubpath);
  if (staticScripts.length === 0) return null;
  return {
    policyVersion: GENERATED_ARTIFACT_POLICY_VERSION,
    generatorFamily: 'static-artifact',
    confidence: 'strong',
    matchedPackage: pkgJson.name,
    targetSubpath,
    evidence: [
      evidence('package-json-target', sourceField, targetSubpath),
      ...filesEvidence,
      ...staticScripts,
    ],
  };
}

export function exportsEvidenceField(subpath) {
  return subpath === '.' ? 'exports["."]' : `exports["${subpath}"]`;
}

export function normalizeGeneratedSubpath(value, { full = false } = {}) {
  const normalized = String(value ?? '').replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
  return full ? normalized : normalized.split('/')[0];
}

export function addGeneratedEvidence(packets, targetSubpath, generatorFamily, evidenceItems, options = {}) {
  const normalized = normalizeGeneratedSubpath(targetSubpath, options);
  if (!normalized || !Array.isArray(evidenceItems) || evidenceItems.length === 0) return;
  if (!packets.has(normalized)) {
    packets.set(normalized, {
      policyVersion: GENERATED_ARTIFACT_POLICY_VERSION,
      generatorFamily,
      confidence: 'strong',
      targetSubpath: normalized,
      evidence: [],
    });
  }
  const packet = packets.get(normalized);
  for (const item of evidenceItems) {
    if (!item || typeof item !== 'object') continue;
    if (packet.evidence.some((e) =>
      e.kind === item.kind && e.field === item.field && e.matched === item.matched)) {
      continue;
    }
    packet.evidence.push(item);
  }
}

export function unresolvedGeneratedArtifactHintForCandidates(candidates) {
  return candidates.some((candidate) =>
    /(^|\/)(generated|__generated__|gen)(\/|$)/i.test(String(candidate).replace(/\\/g, '/')))
    ? GENERATED_ARTIFACT_MISSING_HINT
    : undefined;
}

export function generatedArtifactForTargetCandidates(root, candidates) {
  for (const [idx, candidate] of candidates.entries()) {
    const targetSubpath = relPath(root, candidate).replace(/\\/g, '/').replace(/^\.\//, '');
    const segment = targetSubpath.split('/').find((part) =>
      /^(generated|__generated__|gen)$/i.test(part));
    if (!segment) continue;
    return {
      policyVersion: GENERATED_ARTIFACT_POLICY_VERSION,
      generatorFamily: 'path-segment',
      confidence: 'supporting',
      targetSubpath,
      evidence: [evidence('target-path-segment', `targetCandidates[${idx}]`, segment)],
    };
  }
  return null;
}

export function normalizeGeneratedSpecifierSubpath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\.(d\.ts|ts|tsx|mjs|cjs|js|jsx|mts|cts)$/, '');
}

export function generatedWorkspaceSubpathEvidence(entry, star) {
  if (!entry?.legacySubpath) return null;
  const subpath = String(star ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  const firstSegment = subpath.split('/')[0] ?? '';
  const wanted = new Set([
    normalizeGeneratedSpecifierSubpath(firstSegment),
    normalizeGeneratedSpecifierSubpath(subpath),
  ]);
  return (entry.generatedSubpathEvidence ?? []).find((packet) =>
    wanted.has(normalizeGeneratedSpecifierSubpath(packet?.targetSubpath))) ?? null;
}

export function isStrongGeneratedArtifact(packet) {
  return packet?.confidence === 'strong';
}

export function isGeneratedArtifactMissingRecord(record) {
  return record?.reason === GENERATED_ARTIFACT_MISSING_REASON &&
    record?.generatedArtifact &&
    typeof record.generatedArtifact === 'object';
}
