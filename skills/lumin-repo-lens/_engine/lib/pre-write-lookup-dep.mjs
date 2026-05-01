// Dependency-candidate lookup for the pre-write gate (P1-2).
//
// Classifies a dep-name into:
//   - DEPENDENCY_AVAILABLE — declared AND at least one observed static
//                             import consumer.
//   - DEPENDENCY_AVAILABLE_NO_OBSERVED_IMPORTS — declared and the available
//                             static import graph observed zero consumers.
//                             The word "unused" / "cleanup" is FORBIDDEN —
//                             packages may be consumed by scripts, config,
//                             runtime plugins, or build steps outside the
//                             static import graph.
//   - DEPENDENCY_AVAILABLE_IMPORT_GRAPH_UNAVAILABLE — declared, but the
//                             static import graph was not available. This is
//                             "not measured", never "0 observed".
//   - NEW_PACKAGE — absent from all three declaration maps.
//
// Canonical anchors: maintainer history notes §4.2 + §5.2. Package-root normalization
// algorithm is specified there and mirrored in packageRoot() below.

const EXAMPLE_CAP = 5;
const HUB_DEPENDENCY_CONSUMER_THRESHOLD = 10;

// ── packageRoot() — public helper, exported for tests ────────
//
// Exact algorithm from maintainer history notes §4.2:
//   - null / empty / relative / absolute → null (not a package spec)
//   - scoped `@s/pkg[/...]` → `@s/pkg`
//   - bare `pkg[/...]` → `pkg`

export function packageRoot(spec) {
  if (spec === null || spec === undefined) return null;
  if (typeof spec !== 'string' || spec.length === 0) return null;
  if (spec.startsWith('.') || spec.startsWith('/')) return null;

  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    if (parts.length < 2) return null;         // malformed: @scope alone
    if (parts[1].length === 0) return null;    // malformed: @scope/
    return `${parts[0]}/${parts[1]}`;
  }

  return spec.split('/')[0];
}

// ── Watch-for eligibility for the renderer ───────────────────
//
// `existingImports.countConfidence === 'sample-only'` NEVER triggers
// Watch-for, regardless of examples.length. Only `'grounded'` + a real
// count clearing the threshold qualifies. This is pinned structurally
// so the renderer can delegate without re-checking invariants.

export function isWatchForEligible(existingImports) {
  if (!existingImports) return false;
  if (existingImports.countConfidence !== 'grounded') return false;
  if (typeof existingImports.observedImportCount !== 'number') return false;
  return existingImports.observedImportCount >= HUB_DEPENDENCY_CONSUMER_THRESHOLD;
}

export const DEPENDENCY_WATCH_FOR_THRESHOLD = HUB_DEPENDENCY_CONSUMER_THRESHOLD;

// ── Declaration lookup ───────────────────────────────────────

function findDeclaration(pkg, depName) {
  const map = [
    ['dependencies', pkg?.dependencies],
    ['devDependencies', pkg?.devDependencies],
    ['peerDependencies', pkg?.peerDependencies],
  ];
  for (const [bucket, obj] of map) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, depName)) {
      return { declaredIn: bucket, declaredVersion: obj[depName] };
    }
  }
  return null;
}

// ── Consumer discovery ───────────────────────────────────────
//
// Walk the package-import consumer stream emitted by symbols.json. Older
// fixtures may still provide the pre-v1.10.21 `symbols.uses[]` shape, so
// keep it as a legacy fallback. Relative/absolute specifiers return null
// from packageRoot() and are excluded by construction.

function consumerRecords(symbols) {
  if (!symbols) {
    return {
      records: null,
      field: null,
      unavailableReason: 'symbols.json absent',
    };
  }

  if (Array.isArray(symbols.dependencyImportConsumers)) {
    return {
      records: symbols.dependencyImportConsumers,
      field: 'dependencyImportConsumers',
      unavailableReason: null,
    };
  }

  if (Array.isArray(symbols.uses)) {
    return {
      records: symbols.uses,
      field: 'uses',
      unavailableReason: null,
    };
  }

  const supports = symbols.meta?.supports?.dependencyImportConsumers;
  return {
    records: null,
    field: null,
    unavailableReason: supports === true
      ? 'symbols.json.dependencyImportConsumers absent or malformed'
      : 'symbols.json.dependencyImportConsumers absent; producer did not emit dependencyImportConsumers capability',
  };
}

function findConsumers(symbols, depRoot) {
  const consumerData = consumerRecords(symbols);
  if (!consumerData.records) {
    return {
      examples: [],
      total: null,
      confidence: 'unavailable',
      unavailableReason: consumerData.unavailableReason,
      citationField: consumerData.field,
    };
  }
  const examples = [];
  let total = 0;
  for (const u of consumerData.records) {
    const root = packageRoot(u.fromSpec);
    if (root === depRoot) {
      total++;
      if (examples.length < EXAMPLE_CAP) {
        examples.push({ file: u.file, fromSpec: u.fromSpec });
      }
    }
  }
  return {
    examples,
    total,
    confidence: 'grounded',
    unavailableReason: null,
    citationField: consumerData.field,
  };
}

// ── Entry point ──────────────────────────────────────────────

/**
 * @param {string} depName  e.g. `dayjs`, `@scope/pkg`, `dayjs/plugin/utc`
 * @param {{ packageJson: object, symbols: object }} ctx
 */
export function lookupDependency(depName, ctx) {
  const pkg = ctx?.packageJson ?? {};
  const symbols = ctx?.symbols ?? null;

  // Normalize the caller's depName to its root so `dayjs/plugin/utc`
  // in the intent matches a `dayjs` declaration.
  const depRoot = packageRoot(depName) ?? depName;

  const decl = findDeclaration(pkg, depRoot);
  const consumers = findConsumers(symbols, depRoot);

  const citations = [];
  let result;

  if (decl) {
    if (consumers.confidence !== 'grounded') {
      result = 'DEPENDENCY_AVAILABLE_IMPORT_GRAPH_UNAVAILABLE';
      citations.push(`[grounded, package.json.${decl.declaredIn}['${depRoot}'] = '${decl.declaredVersion}']`);
      citations.push(`[확인 불가, reason: ${consumers.unavailableReason}; observed static-import consumer count unavailable for '${depRoot}']`);
    } else if (consumers.total > 0) {
      result = 'DEPENDENCY_AVAILABLE';
      citations.push(`[grounded, package.json.${decl.declaredIn}['${depRoot}'] = '${decl.declaredVersion}']`);
      citations.push(`[grounded, symbols.json.${consumers.citationField} fromSpec matches '${depRoot}' → ${consumers.total} observed static-import consumer${consumers.total === 1 ? '' : 's'}]`);
    } else {
      result = 'DEPENDENCY_AVAILABLE_NO_OBSERVED_IMPORTS';
      citations.push(`[grounded, package.json.${decl.declaredIn}['${depRoot}'] = '${decl.declaredVersion}']`);
      citations.push(`[확인 불가, scan range: import graph only — '${depRoot}' may still be consumed by scripts, config, runtime plugins, or build steps outside static imports]`);
    }
  } else {
    result = 'NEW_PACKAGE';
    citations.push(`[grounded, package.json.{dependencies, devDependencies, peerDependencies} does not contain '${depRoot}']`);
  }

  return {
    kind: 'dependency',
    depName,
    declaredIn: decl?.declaredIn ?? null,
    result,
    existingImports: {
      examples: consumers.examples,
      observedImportCount: consumers.total,
      countConfidence: consumers.confidence,
      unavailableReason: consumers.unavailableReason ?? null,
    },
    citations,
  };
}
