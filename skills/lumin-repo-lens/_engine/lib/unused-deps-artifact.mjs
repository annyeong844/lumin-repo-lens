import path from 'node:path';

import { relPath } from './paths.mjs';

export const UNUSED_DEPS_SCHEMA_VERSION = 'unused-deps.v1';
export const UNUSED_DEPS_POLICY_VERSION = 'unused-deps-review-policy-v1';

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const DIRECT_EXEC_RUNNERS = new Set(['bunx', 'npx']);
const RUNNER_EXEC_SUBCOMMANDS = new Set(['exec', 'x', 'dlx']);
const WRAPPER_SUBCOMMANDS = new Set(['run', 'run-script']);

function slashPath(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

export function packageNameFromSpecifier(specifier) {
  if (typeof specifier !== 'string') return null;
  const spec = specifier.trim();
  if (!spec) return null;
  if (
    spec.startsWith('.') ||
    spec.startsWith('/') ||
    spec.startsWith('\\') ||
    spec.startsWith('node:') ||
    spec.startsWith('#') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec) ||
    /^[A-Za-z]:[\\/]/.test(spec)
  ) {
    return null;
  }
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return spec.split('/')[0] || null;
}

function commandName(token) {
  return slashPath(token)
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/\.(?:cmd|ps1|exe)$/i, '');
}

function tokenizeCommand(command) {
  const out = [];
  let token = '';
  let quote = null;
  let escaping = false;
  for (const ch of String(command ?? '')) {
    if (escaping) {
      token += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (token) {
        out.push(token);
        token = '';
      }
      continue;
    }
    token += ch;
  }
  if (token) out.push(token);
  return out;
}

function scriptToolFromTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  const first = commandName(tokens[0]);
  if (!first) return null;
  if (DIRECT_EXEC_RUNNERS.has(first)) return commandName(tokens[1]);
  if (!PACKAGE_RUNNERS.has(first)) return first;
  const subcommand = commandName(tokens[1]);
  if (!subcommand) return null;
  if (WRAPPER_SUBCOMMANDS.has(subcommand)) return null;
  if (RUNNER_EXEC_SUBCOMMANDS.has(subcommand)) return commandName(tokens[2]);
  if (first === 'npm') return null;
  return subcommand;
}

export function collectPackageScriptToolEvidence(packageRecord) {
  const scripts = packageRecord?.packageJson?.scripts;
  if (!scripts || typeof scripts !== 'object') return [];
  const out = [];
  for (const [scriptName, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue;
    const tokens = tokenizeCommand(command);
    const tool = scriptToolFromTokens(tokens);
    if (!tool) continue;
    out.push({
      kind: 'package-script',
      packageDir: packageRecord.relRoot ?? '.',
      scriptName,
      tool,
      command,
    });
  }
  return out.sort((a, b) =>
    `${a.packageDir}|${a.tool}|${a.scriptName}`.localeCompare(
      `${b.packageDir}|${b.tool}|${b.scriptName}`,
    ));
}

function declarationFieldRank(field) {
  const index = DEP_FIELDS.indexOf(field);
  return index === -1 ? DEP_FIELDS.length : index;
}

function collectDeclarations(packageRecord) {
  const declarations = [];
  const packageJson = packageRecord.packageJson ?? {};
  for (const field of DEP_FIELDS) {
    const entries = packageJson[field];
    if (!entries || typeof entries !== 'object') continue;
    for (const [name, range] of Object.entries(entries)) {
      declarations.push({
        name,
        field,
        range: typeof range === 'string' ? range : String(range),
      });
    }
  }
  return declarations.sort((a, b) =>
    a.name.localeCompare(b.name) ||
    declarationFieldRank(a.field) - declarationFieldRank(b.field));
}

function normalizePackageFile(root, file) {
  if (typeof file !== 'string' || !file) return null;
  const normalized = slashPath(file);
  if (path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) {
    return slashPath(relPath(root, file));
  }
  return normalized.replace(/^\.\//, '');
}

function fileBelongsToPackage(packageRelRoot, consumerFile, allPackageRelRoots) {
  const pkg = packageRelRoot === '.' ? '' : slashPath(packageRelRoot).replace(/\/$/, '');
  const file = slashPath(consumerFile);
  const childRoots = allPackageRelRoots
    .filter((root) => root !== packageRelRoot)
    .map((root) => root === '.' ? '' : slashPath(root).replace(/\/$/, ''))
    .filter(Boolean);
  if (!pkg) {
    return !childRoots.some((child) => file === child || file.startsWith(`${child}/`));
  }
  return file === pkg || file.startsWith(`${pkg}/`);
}

function buildObservedConsumerIndex({ root, packageRecord, symbols, allPackageRelRoots }) {
  const byName = new Map();
  const consumers = Array.isArray(symbols?.dependencyImportConsumers)
    ? symbols.dependencyImportConsumers
    : [];
  for (const consumer of consumers) {
    const depName = consumer.depRoot ?? packageNameFromSpecifier(consumer.fromSpec);
    if (!depName) continue;
    const file = normalizePackageFile(root, consumer.file);
    if (!file || !fileBelongsToPackage(packageRecord.relRoot ?? '.', file, allPackageRelRoots)) continue;
    if (!byName.has(depName)) byName.set(depName, []);
    byName.get(depName).push({
      file,
      fromSpec: consumer.fromSpec,
      kind: consumer.kind ?? 'import',
      source: consumer.source ?? 'symbols.json.dependencyImportConsumers',
      ...(typeof consumer.typeOnly === 'boolean' ? { typeOnly: consumer.typeOnly } : {}),
    });
  }
  for (const entries of byName.values()) {
    entries.sort((a, b) =>
      `${a.file}|${a.fromSpec}|${a.kind}`.localeCompare(
        `${b.file}|${b.fromSpec}|${b.kind}`,
      ));
  }
  return byName;
}

function scriptEvidenceForDependency(scriptEvidence, depName) {
  return scriptEvidence.filter((entry) => entry.tool === depName);
}

function classifyDependency({
  declaration,
  packageName,
  workspacePackageNames,
  observedConsumers,
  scriptEvidence,
}) {
  const consumers = observedConsumers.get(declaration.name) ?? [];
  if (consumers.length > 0) {
    return {
      status: 'used',
      reason: 'external-import-consumer',
      confidence: 'grounded',
      evidence: consumers.slice(0, 10).map((consumer) => ({
        kind: 'external-import-consumer',
        ...consumer,
      })),
      observedImportCount: consumers.length,
    };
  }

  const scripts = scriptEvidenceForDependency(scriptEvidence, declaration.name);
  if (scripts.length > 0) {
    return {
      status: 'muted',
      reason: 'package-script-tool',
      confidence: 'grounded',
      evidence: scripts.slice(0, 10),
      observedImportCount: 0,
    };
  }

  if (declaration.field === 'peerDependencies') {
    return {
      status: 'muted',
      reason: 'peer-contract',
      confidence: 'review',
      evidence: [],
      observedImportCount: 0,
    };
  }

  if (declaration.field === 'optionalDependencies') {
    return {
      status: 'muted',
      reason: 'optional-runtime',
      confidence: 'review',
      evidence: [],
      observedImportCount: 0,
    };
  }

  if (declaration.name.startsWith('@types/')) {
    return {
      status: 'muted',
      reason: 'ambient-types',
      confidence: 'review',
      evidence: [],
      observedImportCount: 0,
    };
  }

  if (workspacePackageNames.has(declaration.name) && declaration.name !== packageName) {
    return {
      status: 'muted',
      reason: 'workspace-internal',
      confidence: 'review',
      evidence: [],
      observedImportCount: 0,
    };
  }

  return {
    status: 'review-unused',
    reason: 'no-observed-consumer',
    confidence: 'review',
    evidence: [],
    observedImportCount: 0,
  };
}

function incrementCounter(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function emptySummary() {
  return {
    packageCount: 0,
    declaredDependencyCount: 0,
    usedCount: 0,
    mutedCount: 0,
    reviewUnusedCount: 0,
    confidenceLimitedCount: 0,
    unavailableCount: 0,
    byReason: {},
  };
}

function summarize(packages) {
  const byReason = new Map();
  const summary = emptySummary();
  summary.packageCount = packages.length;
  for (const pkg of packages) {
    for (const dep of pkg.dependencies ?? []) {
      summary.declaredDependencyCount++;
      incrementCounter(byReason, dep.reason ?? 'unknown');
      if (dep.status === 'used') summary.usedCount++;
      else if (dep.status === 'muted') summary.mutedCount++;
      else if (dep.status === 'review-unused') summary.reviewUnusedCount++;
      else if (dep.status === 'confidence-limited') summary.confidenceLimitedCount++;
      else if (dep.status === 'unavailable') summary.unavailableCount++;
    }
  }
  summary.byReason = Object.fromEntries([...byReason.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return summary;
}

function supportsDependencyImportConsumers(symbols) {
  return symbols?.meta?.supports?.dependencyImportConsumers === true &&
    Array.isArray(symbols?.dependencyImportConsumers);
}

function scanRangeFromInputs({ root, includeTests, exclude, symbols }) {
  const sourceRange = symbols?.meta?.scanRange;
  if (sourceRange && typeof sourceRange === 'object') {
    return {
      root: sourceRange.root ?? root,
      includeTests: sourceRange.includeTests ?? includeTests,
      exclude: Array.isArray(sourceRange.exclude) ? [...sourceRange.exclude] : [...(exclude ?? [])],
      source: 'symbols.meta.scanRange',
    };
  }
  return {
    root,
    includeTests,
    exclude: [...(exclude ?? [])],
    source: 'producer-cli',
  };
}

function inputSummary(symbols, scanRange) {
  return {
    symbols: {
      artifact: 'symbols.json',
      supportsDependencyImportConsumers: supportsDependencyImportConsumers(symbols),
      scanRangeSource: scanRange.source,
    },
  };
}

function unavailableArtifact({ root, includeTests, exclude, symbols, reason }) {
  const scanRange = scanRangeFromInputs({ root, includeTests, exclude, symbols });
  return {
    schemaVersion: UNUSED_DEPS_SCHEMA_VERSION,
    policyVersion: UNUSED_DEPS_POLICY_VERSION,
    status: 'unavailable',
    reason,
    root,
    scanRange,
    inputs: inputSummary(symbols, scanRange),
    summary: emptySummary(),
    packages: [],
  };
}

export function buildUnusedDepsArtifact({
  root,
  includeTests = true,
  exclude = [],
  packageRecords = [],
  symbols,
} = {}) {
  if (!supportsDependencyImportConsumers(symbols)) {
    return unavailableArtifact({
      root,
      includeTests,
      exclude,
      symbols,
      reason: 'input-artifact-missing',
    });
  }

  const scanRange = scanRangeFromInputs({ root, includeTests, exclude, symbols });
  const allPackageRelRoots = packageRecords.map((record) => record.relRoot ?? '.');
  const workspacePackageNames = new Set(
    packageRecords
      .map((record) => record.packageJson?.name)
      .filter((name) => typeof name === 'string' && name.length > 0),
  );

  const packages = packageRecords
    .map((packageRecord) => {
      const scriptEvidence = collectPackageScriptToolEvidence(packageRecord);
      const observedConsumers = buildObservedConsumerIndex({
        root,
        packageRecord,
        symbols,
        allPackageRelRoots,
      });
      const packageName = packageRecord.packageJson?.name ?? null;
      const dependencies = collectDeclarations(packageRecord).map((declaration) => {
        const classification = classifyDependency({
          declaration,
          packageName,
          workspacePackageNames,
          observedConsumers,
          scriptEvidence,
        });
        return {
          name: declaration.name,
          field: declaration.field,
          range: declaration.range,
          status: classification.status,
          reason: classification.reason,
          confidence: classification.confidence,
          observedImportCount: classification.observedImportCount,
          evidence: classification.evidence,
        };
      });
      return {
        packageDir: packageRecord.relRoot ?? '.',
        packageName,
        manifestPath: packageRecord.relRoot === '.'
          ? 'package.json'
          : `${slashPath(packageRecord.relRoot)}/package.json`,
        status: 'complete',
        dependencies,
      };
    })
    .sort((a, b) => a.packageDir.localeCompare(b.packageDir));

  return {
    schemaVersion: UNUSED_DEPS_SCHEMA_VERSION,
    policyVersion: UNUSED_DEPS_POLICY_VERSION,
    status: 'complete',
    root,
    scanRange,
    inputs: inputSummary(symbols, scanRange),
    summary: summarize(packages),
    packages,
  };
}
