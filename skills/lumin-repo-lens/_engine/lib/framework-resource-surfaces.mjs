export const FRAMEWORK_RESOURCE_SURFACE_POLICY_VERSION = 'framework-resource-surface-policy-v1';
export const FRAMEWORK_RESOURCE_SURFACE_SCHEMA_VERSION = 'framework-resource-surfaces.v1';

function normalizeRelPath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '.';
}

function normalizePackageRoot(value) {
  const rel = normalizeRelPath(value || '.');
  return rel === '.' ? '.' : rel;
}

function dependencyEntries(packageJson = {}) {
  const sections = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  const entries = [];
  for (const section of sections) {
    for (const name of Object.keys(packageJson?.[section] ?? {})) {
      entries.push({ section, name });
    }
  }
  return entries;
}

function dependencyEvidence(packageRecord, predicate) {
  return dependencyEntries(packageRecord.packageJson)
    .filter(({ name }) => predicate(name))
    .map(({ section, name }) => ({
      kind: 'dependency',
      field: `${section}.${name}`,
    }))
    .sort((a, b) => a.field.localeCompare(b.field));
}

function sortPackageRecords(packageRecords) {
  const records = (packageRecords.length > 0
    ? packageRecords
    : [{ relRoot: '.', packageJson: {} }])
    .map((record) => ({
      ...record,
      relRoot: normalizePackageRoot(record.relRoot ?? '.'),
      packageJson: record.packageJson ?? {},
    }));
  return records.sort((a, b) => {
    const aDepth = a.relRoot === '.' ? 0 : a.relRoot.split('/').length;
    const bDepth = b.relRoot === '.' ? 0 : b.relRoot.split('/').length;
    return bDepth - aDepth || a.relRoot.localeCompare(b.relRoot);
  });
}

function nearestPackage(packages, file) {
  return packages.find((pkg) => (
    pkg.relRoot === '.' ||
    file === pkg.relRoot ||
    file.startsWith(`${pkg.relRoot}/`)
  )) ?? packages.at(-1);
}

function packageRelative(file, pkg) {
  if (pkg.relRoot === '.') return file;
  if (file === pkg.relRoot) return '.';
  return file.startsWith(`${pkg.relRoot}/`)
    ? file.slice(pkg.relRoot.length + 1)
    : file;
}

function surfaceLane({ lane, capabilityPack, confidence, reason, defaultAction = 'review-hint', affectsAbsenceClaims = true, evidence, extra = {} }) {
  return {
    lane,
    capabilityPack,
    confidence,
    ...extra,
    reason,
    defaultAction,
    affectsAbsenceClaims,
    evidence: evidence.toSorted((a, b) =>
      String(a.kind ?? '').localeCompare(String(b.kind ?? '')) ||
      String(a.field ?? '').localeCompare(String(b.field ?? '')) ||
      String(a.matched ?? '').localeCompare(String(b.matched ?? ''))),
  };
}

function storybookDependencyEvidence(pkg) {
  return dependencyEvidence(pkg, (name) => name === 'storybook' || name.startsWith('@storybook/'));
}

function strapiDependencyEvidence(pkg) {
  return dependencyEvidence(pkg, (name) => name === 'strapi' || name === '@strapi/strapi');
}

function storybookLane(pkg, relFile) {
  if (!/(^|\/)[^/]+\.stories\.[cm]?[jt]sx?$/.test(relFile)) return null;
  const deps = storybookDependencyEvidence(pkg);
  return surfaceLane({
    lane: 'framework-dispatch-entry',
    capabilityPack: 'framework.storybook',
    confidence: deps.length > 0 ? 'grounded' : 'path-shaped-review',
    reason: 'storybook-story-file',
    extra: { framework: 'storybook' },
    evidence: [
      ...deps,
      { kind: 'path-convention', matched: '*.stories.*' },
    ],
  });
}

function strapiLane(pkg, relFile) {
  if (!/^src\/api\/[^/]+\/(controllers|routes|services)\//.test(relFile)) return null;
  const deps = strapiDependencyEvidence(pkg);
  return surfaceLane({
    lane: 'framework-dispatch-entry',
    capabilityPack: 'framework.strapi',
    confidence: deps.length > 0 ? 'grounded' : 'path-shaped-review',
    reason: 'strapi-filesystem-api',
    extra: { framework: 'strapi' },
    evidence: [
      ...deps,
      { kind: 'path-convention', matched: 'src/api/*/{controllers,routes,services}/**' },
    ],
  });
}

function generatedDeclarationLane(relFile) {
  if (!/\.d\.ts$/.test(relFile)) return null;
  if (!/(^|\/)generated(\/|$)/.test(relFile)) return null;
  return surfaceLane({
    lane: 'generated-declaration-surface',
    capabilityPack: 'surface.generated-declaration',
    confidence: 'generated-output-review',
    reason: 'generated-declaration-path',
    evidence: [
      { kind: 'path-convention', matched: '**/generated/**/*.d.ts' },
    ],
  });
}

function bundledBuildLane(relFile, content) {
  const base = relFile.split('/').pop() ?? '';
  const emscripten = /@ts-nocheck/.test(content ?? '') && /emscripten/i.test(content ?? '');
  const reason = emscripten
    ? 'emscripten-generated-header'
    : base === 'vendor.js'
      ? 'vendor-bundle-name'
      : /\.bundle\.[cm]?[jt]sx?$/.test(base)
        ? 'bundle-file-name'
        : /\.min\.[cm]?[jt]sx?$/.test(base)
          ? 'minified-file-name'
          : null;
  if (!reason) return null;
  return surfaceLane({
    lane: 'bundled-build-artifact',
    capabilityPack: 'surface.bundled-build-artifact',
    confidence: 'generated-output-review',
    reason,
    evidence: [
      emscripten
        ? { kind: 'file-header', matched: '@ts-nocheck + Emscripten' }
        : { kind: 'path-convention', matched: base },
    ],
  });
}

function scaffoldTemplateLane(relFile) {
  if (!/(^|\/)templates\//.test(relFile) && !/\.hbs$/.test(relFile)) return null;
  return surfaceLane({
    lane: 'scaffold-template-resource',
    capabilityPack: 'surface.scaffold-template',
    confidence: 'resource-only',
    reason: /\.hbs$/.test(relFile) ? 'handlebars-template-resource' : 'templates-directory-resource',
    affectsAbsenceClaims: true,
    evidence: [
      { kind: 'path-convention', matched: /\.hbs$/.test(relFile) ? '*.hbs' : 'templates/**' },
    ],
  });
}

function codemodResourceLane(relFile) {
  const matched = /(^|\/)resources\/codemods\//.test(relFile)
    ? 'resources/codemods/**'
    : /(^|\/)codemods\//.test(relFile)
      ? 'codemods/**'
      : /(^|\/)__testfixtures__\//.test(relFile)
        ? '__testfixtures__/**'
        : null;
  if (!matched) return null;
  return surfaceLane({
    lane: 'codemod-resource',
    capabilityPack: 'surface.codemod-resource',
    confidence: 'resource-only',
    reason: matched === '__testfixtures__/**' ? 'testfixture-resource' : 'codemod-resource-path',
    evidence: [
      { kind: 'path-convention', matched },
    ],
  });
}

function increment(map, key) {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

function sortedObject(map) {
  return Object.fromEntries(
    Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
  );
}

function buildSummary(files) {
  const byLane = Object.create(null);
  const byCapabilityPack = Object.create(null);
  const byConfidence = Object.create(null);
  const byReason = Object.create(null);
  const byFramework = Object.create(null);
  let totalSurfaceLanes = 0;
  for (const entry of files) {
    for (const lane of entry.surfaceLanes) {
      totalSurfaceLanes++;
      increment(byLane, lane.lane);
      increment(byCapabilityPack, lane.capabilityPack);
      increment(byConfidence, lane.confidence);
      increment(byReason, lane.reason);
      increment(byFramework, lane.framework);
    }
  }
  return {
    totalFilesWithSurfaces: files.length,
    totalSurfaceLanes,
    byLane: sortedObject(byLane),
    byCapabilityPack: sortedObject(byCapabilityPack),
    byConfidence: sortedObject(byConfidence),
    byReason: sortedObject(byReason),
    byFramework: sortedObject(byFramework),
    topExamples: files.slice(0, 10).map((entry) => ({
      file: entry.file,
      lanes: entry.surfaceLanes.map((lane) => lane.lane),
      capabilityPacks: entry.surfaceLanes.map((lane) => lane.capabilityPack).filter(Boolean),
      reasons: entry.surfaceLanes.map((lane) => lane.reason),
    })),
  };
}

export function classifyFrameworkResourceSurfaces({
  root = process.cwd(),
  files = [],
  packageRecords = [],
  contentsByFile = {},
} = {}) {
  const packages = sortPackageRecords(packageRecords);
  const entries = [];
  for (const rawFile of files) {
    const file = normalizeRelPath(rawFile);
    const pkg = nearestPackage(packages, file);
    const relFile = packageRelative(file, pkg);
    const content = contentsByFile[file] ?? contentsByFile[rawFile] ?? '';
    const surfaceLanes = [
      storybookLane(pkg, relFile),
      strapiLane(pkg, relFile),
      generatedDeclarationLane(relFile),
      bundledBuildLane(relFile, content),
      scaffoldTemplateLane(relFile),
      codemodResourceLane(relFile),
    ].filter(Boolean);
    if (surfaceLanes.length === 0) continue;
    entries.push({
      file,
      packageRoot: pkg.relRoot,
      surfaceLanes: surfaceLanes.sort((a, b) =>
        a.lane.localeCompare(b.lane) ||
        a.reason.localeCompare(b.reason)),
    });
  }

  const sortedEntries = entries.sort((a, b) => a.file.localeCompare(b.file));
  return {
    schemaVersion: FRAMEWORK_RESOURCE_SURFACE_SCHEMA_VERSION,
    policyVersion: FRAMEWORK_RESOURCE_SURFACE_POLICY_VERSION,
    root,
    files: sortedEntries,
    summary: buildSummary(sortedEntries),
  };
}
