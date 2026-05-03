export const ACTION_MUTE = 'mute';
export const ACTION_REVIEW_HINT = 'review-hint';
export const ACTION_NONE = 'none';

const NEXT_APP_SPECIAL = new Set([
  'default',
  'error',
  'forbidden',
  'global-error',
  'layout',
  'loading',
  'not-found',
  'page',
  'route',
  'template',
  'unauthorized',
]);

const NEXT_TOP_LEVEL_EXPORTS = new Set(['default', 'proxy', 'middleware', 'config']);
const NEXT_INSTRUMENTATION_EXPORTS = new Set(['register', 'onRequestError']);

const REACT_ROUTER_MUTE_EXPORTS = new Set([
  'default',
  'loader',
  'action',
  'meta',
  'links',
  'headers',
  'ErrorBoundary',
]);

const REACT_ROUTER_REVIEW_EXPORTS = new Set([
  'clientLoader',
  'clientAction',
  'HydrateFallback',
  'handle',
  'shouldRevalidate',
  'ServerComponent',
  'ServerErrorBoundary',
  'ServerLayout',
  'ServerHydrateFallback',
]);

const SVELTE_HTTP_EXPORTS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const SVELTE_OPTIONS = new Set(['prerender', 'ssr', 'csr', 'trailingSlash', 'config']);

const ASTRO_HTTP_EXPORTS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'ALL']);
const CLOUDFLARE_WORKER_DEPS = [
  'wrangler',
  '@cloudflare/workers-types',
  '@cloudflare/vite-plugin',
];
const CLOUDFLARE_WORKER_CONFIGS = new Set([
  'wrangler.toml',
  'wrangler.json',
  'wrangler.jsonc',
]);

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

function dependencyNames(packageJson = {}) {
  return new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ]);
}

function hasAny(deps, names) {
  return names.some((name) => deps.has(name));
}

function hasNuxtActivation(deps) {
  return hasAny(deps, ['nuxt', 'nuxt3', 'nitro', 'nitropack', '@nuxt/kit']);
}

function evidenceForPackage(packageRecord) {
  const deps = dependencyNames(packageRecord.packageJson);
  const frameworks = new Set();
  const activation = {};
  const rejectedSignals = [];

  if (deps.has('next')) {
    frameworks.add('next');
    activation.next = ['dependency:next'];
  }
  if (hasAny(deps, ['@remix-run/node', '@remix-run/react', '@react-router/dev', 'react-router'])) {
    frameworks.add('react-router');
    activation['react-router'] = [...deps]
      .filter((name) => ['@remix-run/node', '@remix-run/react', '@react-router/dev', 'react-router'].includes(name))
      .map((name) => `dependency:${name}`);
  }
  if (deps.has('hono')) {
    frameworks.add('hono');
    activation.hono = ['dependency:hono'];
  }
  if (deps.has('@sveltejs/kit')) {
    frameworks.add('sveltekit');
    activation.sveltekit = ['dependency:@sveltejs/kit'];
  }
  if (deps.has('astro')) {
    frameworks.add('astro');
    activation.astro = ['dependency:astro'];
  }
  if (hasAny(deps, CLOUDFLARE_WORKER_DEPS)) {
    frameworks.add('cloudflare-workers');
    activation['cloudflare-workers'] = [...deps]
      .filter((name) => CLOUDFLARE_WORKER_DEPS.includes(name))
      .map((name) => `dependency:${name}`);
  }
  if (hasNuxtActivation(deps)) {
    frameworks.add('nuxt');
    activation.nuxt = [...deps]
      .filter((name) => ['nuxt', 'nuxt3', 'nitro', 'nitropack', '@nuxt/kit'].includes(name))
      .map((name) => `dependency:${name}`);
  }
  if (deps.has('@nuxt/opencollective')) {
    rejectedSignals.push('@nuxt/opencollective');
  }

  return { deps, frameworks, activation, rejectedSignals };
}

function dirnameOf(relFile) {
  const idx = relFile.lastIndexOf('/');
  return idx === -1 ? '.' : relFile.slice(0, idx);
}

function collectCloudflareWorkerConfigs(files) {
  const configs = [];
  for (const file of files) {
    const base = file.split('/').pop() ?? '';
    if (CLOUDFLARE_WORKER_CONFIGS.has(base)) {
      configs.push({ dir: dirnameOf(file), file });
    }
  }
  return configs.toSorted((a, b) => {
    const depth = (value) => value === '.' ? 0 : value.split('/').length;
    return depth(b.dir) - depth(a.dir) || a.file.localeCompare(b.file);
  });
}

function packageRelative(file, packageRecord) {
  const rel = normalizeRelPath(file);
  const root = packageRecord.relRoot;
  if (root === '.') return rel;
  if (rel === root) return '.';
  if (rel.startsWith(`${root}/`)) return rel.slice(root.length + 1);
  return rel;
}

function sortPackages(packageRecords) {
  return [...packageRecords].sort((a, b) => {
    const aLen = a.relRoot === '.' ? 0 : a.relRoot.split('/').length;
    const bLen = b.relRoot === '.' ? 0 : b.relRoot.split('/').length;
    return bLen - aLen;
  });
}

function nearestPackage(packages, file) {
  const rel = normalizeRelPath(file);
  return packages.find((pkg) => (
    pkg.relRoot === '.'
    || rel === pkg.relRoot
    || rel.startsWith(`${pkg.relRoot}/`)
  )) ?? packages[packages.length - 1];
}

function hasFilePrefix(packageRecord, prefix) {
  return packageRecord.files.some((file) => file.startsWith(prefix));
}

function packageHasNextRouterSibling(packageRecord, relFile) {
  if (relFile.startsWith('src/')) {
    return hasFilePrefix(packageRecord, 'src/app/') || hasFilePrefix(packageRecord, 'src/pages/');
  }
  return hasFilePrefix(packageRecord, 'app/') || hasFilePrefix(packageRecord, 'pages/');
}

function basenameNoExt(relFile) {
  const base = relFile.split('/').pop() ?? '';
  return base.replace(/\.[^.]+$/, '');
}

function isKnownSourceFile(relFile) {
  return /\.(mjs|cjs|js|jsx|ts|tsx|svelte|astro|md|mdx|html)$/.test(relFile);
}

function decision(action, framework, reason, ruleId, evidence, extra = {}) {
  return { action, framework, reason, ruleId, evidence, ...extra };
}

function noDecision(extra = {}) {
  return { action: ACTION_NONE, ...extra };
}

function conventionEvidence(packageRecord, framework, convention) {
  return {
    packageRoot: packageRecord.relRoot,
    activation: packageRecord.activation[framework] ?? [],
    convention,
  };
}

function relInsideDir(relFile, dir) {
  if (dir === '.') return relFile;
  if (relFile === dir) return '.';
  if (!relFile.startsWith(`${dir}/`)) return null;
  return relFile.slice(dir.length + 1);
}

function classifyNext(packageRecord, relFile, exportName) {
  if (!packageRecord.frameworks.has('next')) return null;

  const isPages = relFile.startsWith('pages/') || relFile.startsWith('src/pages/');
  if (isPages && isKnownSourceFile(relFile)) {
    return decision(
      ACTION_MUTE,
      'next',
      'frameworkSentinel_FP27',
      'next-pages-route',
      conventionEvidence(packageRecord, 'next', relFile.startsWith('src/') ? 'src/pages/**' : 'pages/**'),
    );
  }

  const appPrefix = relFile.startsWith('src/app/') ? 'src/app/' : relFile.startsWith('app/') ? 'app/' : null;
  if (appPrefix) {
    const base = basenameNoExt(relFile);
    if (NEXT_APP_SPECIAL.has(base)) {
      return decision(
        ACTION_MUTE,
        'next',
        'frameworkSentinel_FP27',
        'next-app-router-special-file',
        conventionEvidence(packageRecord, 'next', `${appPrefix}**/${base}.*`),
      );
    }
  }

  const topLevel = /^(src\/)?(middleware|proxy)\.[^.]+$/.exec(relFile);
  if (topLevel && NEXT_TOP_LEVEL_EXPORTS.has(exportName) && packageHasNextRouterSibling(packageRecord, relFile)) {
    return decision(
      ACTION_MUTE,
      'next',
      'frameworkSentinel_FP27',
      `next-${topLevel[2]}`,
      conventionEvidence(packageRecord, 'next', `${topLevel[1] ?? ''}${topLevel[2]}.*`),
    );
  }

  if (/^(src\/)?instrumentation\.[^.]+$/.test(relFile) && NEXT_INSTRUMENTATION_EXPORTS.has(exportName)) {
    return decision(
      ACTION_MUTE,
      'next',
      'frameworkSentinel_FP27',
      'next-instrumentation',
      conventionEvidence(packageRecord, 'next', relFile.startsWith('src/') ? 'src/instrumentation.*' : 'instrumentation.*'),
    );
  }

  if (/^(src\/)?instrumentation-client\.[^.]+$/.test(relFile)) {
    return decision(
      ACTION_REVIEW_HINT,
      'next',
      'frameworkReviewHint',
      'next-instrumentation-client',
      conventionEvidence(packageRecord, 'next', relFile.startsWith('src/') ? 'src/instrumentation-client.*' : 'instrumentation-client.*'),
    );
  }

  return null;
}

function classifyReactRouter(packageRecord, relFile, exportName) {
  if (!packageRecord.frameworks.has('react-router')) return null;
  if (!relFile.startsWith('app/routes/') && !relFile.startsWith('routes/')) return null;

  if (REACT_ROUTER_MUTE_EXPORTS.has(exportName)) {
    return decision(
      ACTION_MUTE,
      'react-router',
      'frameworkSentinel_FP27',
      'react-router-route-module-export',
      conventionEvidence(packageRecord, 'react-router', relFile.startsWith('app/') ? 'app/routes/**' : 'routes/**'),
    );
  }
  if (REACT_ROUTER_REVIEW_EXPORTS.has(exportName)) {
    return decision(
      ACTION_REVIEW_HINT,
      'react-router',
      'frameworkReviewHint',
      'react-router-route-module-review-export',
      conventionEvidence(packageRecord, 'react-router', relFile.startsWith('app/') ? 'app/routes/**' : 'routes/**'),
    );
  }
  return null;
}

function classifyHono(packageRecord, relFile, exportName, frameworkFacts) {
  if (!packageRecord.frameworks.has('hono')) return null;
  const registrations = frameworkFacts?.honoRouteRegistrations ?? [];
  const matched = registrations.some((registration) => (
    registration.handlerRefs ?? []
  ).some((ref) => normalizeRelPath(ref.file) === packageRecord.qualify(relFile) && ref.exportName === exportName));

  if (!matched) return null;
  return decision(
    ACTION_MUTE,
    'hono',
    'frameworkSentinel_FP27',
    'hono-route-registration-handler',
    conventionEvidence(packageRecord, 'hono', 'honoRouteRegistrations[].handlerRefs[]'),
  );
}

function classifySvelteKit(packageRecord, relFile, exportName) {
  if (!packageRecord.frameworks.has('sveltekit')) return null;
  if (!relFile.startsWith('src/routes/')) return null;

  const base = relFile.split('/').pop() ?? '';
  const routePath = relFile.slice('src/routes/'.length);
  const isDynamic = routePath.split('/').some((part) => part.includes('[') && part.includes(']'));

  if (/^\+server\./.test(base)) {
    if (SVELTE_HTTP_EXPORTS.has(exportName) || ['prerender', 'config'].includes(exportName)) {
      return decision(ACTION_MUTE, 'sveltekit', 'frameworkSentinel_FP27', 'sveltekit-server-export', conventionEvidence(packageRecord, 'sveltekit', 'src/routes/**/+server.*'));
    }
    if (exportName === 'entries' && isDynamic) {
      return decision(ACTION_MUTE, 'sveltekit', 'frameworkSentinel_FP27', 'sveltekit-dynamic-entries', conventionEvidence(packageRecord, 'sveltekit', 'dynamic +server entries'));
    }
    return null;
  }

  const isPageOrLayout = /^\+(page|page\.server|layout|layout\.server)\./.test(base);
  if (!isPageOrLayout) return null;

  if (exportName === 'load' || SVELTE_OPTIONS.has(exportName)) {
    return decision(ACTION_MUTE, 'sveltekit', 'frameworkSentinel_FP27', 'sveltekit-page-layout-export', conventionEvidence(packageRecord, 'sveltekit', 'src/routes/**/+page|+layout.*'));
  }
  if (exportName === 'actions' && /^\+page\.server\./.test(base)) {
    return decision(ACTION_MUTE, 'sveltekit', 'frameworkSentinel_FP27', 'sveltekit-form-actions', conventionEvidence(packageRecord, 'sveltekit', 'src/routes/**/+page.server.*'));
  }
  if (exportName === 'entries' && isDynamic && /^\+(page|page\.server)\./.test(base)) {
    return decision(ACTION_MUTE, 'sveltekit', 'frameworkSentinel_FP27', 'sveltekit-dynamic-entries', conventionEvidence(packageRecord, 'sveltekit', 'dynamic +page entries'));
  }

  return null;
}

function classifyAstro(packageRecord, relFile, exportName) {
  if (!packageRecord.frameworks.has('astro')) return null;
  if (!relFile.startsWith('src/pages/')) return null;

  if (ASTRO_HTTP_EXPORTS.has(exportName) || exportName === 'getStaticPaths') {
    return decision(
      ACTION_MUTE,
      'astro',
      'frameworkSentinel_FP27',
      'astro-page-endpoint-export',
      conventionEvidence(packageRecord, 'astro', 'src/pages/** endpoint exports'),
    );
  }

  return null;
}

function cloudflareWorkerEntryScope(packageRecord, relFile) {
  for (const configDir of packageRecord.cloudflareWorkerConfigDirs ?? []) {
    const scoped = relInsideDir(relFile, configDir);
    if (scoped !== null) {
      return {
        scopedRelFile: scoped,
        convention: configDir === '.'
          ? 'wrangler.* + worker entry'
          : `${configDir}/wrangler.* + worker entry`,
      };
    }
  }

  if (packageRecord.activation['cloudflare-workers']?.some((item) => item.startsWith('dependency:'))) {
    return { scopedRelFile: relFile, convention: 'package dependency + worker entry' };
  }
  return null;
}

function classifyCloudflareWorker(packageRecord, relFile, exportName) {
  if (!packageRecord.frameworks.has('cloudflare-workers')) return null;
  if (exportName !== 'default') return null;
  const scope = cloudflareWorkerEntryScope(packageRecord, relFile);
  if (!scope) return null;

  const protectedEntry = (
    /^(src\/)?index\.[^.]+$/.test(scope.scopedRelFile)
    || /^(src\/)?worker\.[^.]+$/.test(scope.scopedRelFile)
  );
  if (!protectedEntry || !isKnownSourceFile(relFile)) return null;

  return decision(
    ACTION_MUTE,
    'cloudflare-workers',
    'frameworkSentinel_FP27',
    'cloudflare-worker-module-default-export',
    conventionEvidence(packageRecord, 'cloudflare-workers', scope.convention),
  );
}

function isNuxtTopLevelComposable(relFile) {
  return /^app\/composables\/[^/]+\.[^.]+$/.test(relFile) || /^composables\/[^/]+\.[^.]+$/.test(relFile);
}

function classifyNuxt(packageRecord, relFile) {
  if (!packageRecord.frameworks.has('nuxt')) return null;

  if (isNuxtTopLevelComposable(relFile)) {
    return decision(ACTION_MUTE, 'nuxt', 'nuxtNitro_FP30', 'nuxt-top-level-composable', conventionEvidence(packageRecord, 'nuxt', 'top-level composables'));
  }

  const protectedPath = (
    /^server\/(api|routes|middleware)\//.test(relFile)
    || /^(app\/)?plugins\/[^/]+\.[^.]+$/.test(relFile)
    || /^(app\/)?middleware\/[^/]+\.[^.]+$/.test(relFile)
    || /^runtime\/(utils|plugins|server)\//.test(relFile)
  );

  if (protectedPath) {
    return decision(ACTION_MUTE, 'nuxt', 'nuxtNitro_FP30', 'nuxt-nitro-convention-path', conventionEvidence(packageRecord, 'nuxt', 'Nuxt/Nitro convention path'));
  }

  return null;
}

function pathShapeFor(relFile) {
  if (/(^|\/)middleware(\/|\.|$)/.test(relFile)) return 'middleware';
  if (/(^|\/)routes(\/|$)/.test(relFile)) return 'routes';
  if (/(^|\/)app(\/|$)/.test(relFile)) return 'app';
  return null;
}

function withPackageHelpers(record, allFiles) {
  const relRoot = normalizePackageRoot(record.relRoot);
  const evidence = evidenceForPackage(record);
  const files = allFiles
    .filter((file) => relRoot === '.' || file === relRoot || file.startsWith(`${relRoot}/`))
    .map((file) => packageRelative(file, { relRoot }));
  const cloudflareWorkerConfigs = collectCloudflareWorkerConfigs(files);
  const cloudflareWorkerConfigDirs = [...new Set(cloudflareWorkerConfigs.map((config) => config.dir))];
  if (cloudflareWorkerConfigDirs.length > 0) {
    evidence.frameworks.add('cloudflare-workers');
    const configEvidence = cloudflareWorkerConfigs.map((config) => `config:${config.file}`);
    evidence.activation['cloudflare-workers'] = [
      ...(evidence.activation['cloudflare-workers'] ?? []),
      ...configEvidence,
    ];
  }

  return {
    ...record,
    relRoot,
    files,
    cloudflareWorkerConfigDirs,
    ...evidence,
    qualify(relFile) {
      return relRoot === '.' ? normalizeRelPath(relFile) : `${relRoot}/${normalizeRelPath(relFile)}`;
    },
  };
}

export function createFrameworkPolicyContext({ root, packageRecords = [], files = [], frameworkFacts = {} }) {
  const normalizedFiles = [...new Set(files.map(normalizeRelPath))];
  const normalizedRecords = (packageRecords.length > 0 ? packageRecords : [{ relRoot: '.', root, packageJson: {} }])
    .map((record) => ({
      ...record,
      relRoot: normalizePackageRoot(record.relRoot ?? '.'),
      packageJson: record.packageJson ?? {},
    }));
  const packages = sortPackages(normalizedRecords.map((record) => withPackageHelpers(record, normalizedFiles)));

  return {
    root,
    files: normalizedFiles,
    packages,
    frameworkFacts,
  };
}

export function classifyFrameworkPolicy(context, candidate) {
  const file = normalizeRelPath(candidate.file);
  const exportName = candidate.exportName ?? candidate.name ?? 'default';
  const pkg = nearestPackage(context.packages, file);
  const relFile = packageRelative(file, pkg);

  const decisionResult = (
    classifyNext(pkg, relFile, exportName)
    ?? classifyReactRouter(pkg, relFile, exportName)
    ?? classifyHono(pkg, relFile, exportName, context.frameworkFacts)
    ?? classifySvelteKit(pkg, relFile, exportName)
    ?? classifyAstro(pkg, relFile, exportName)
    ?? classifyCloudflareWorker(pkg, relFile, exportName)
    ?? classifyNuxt(pkg, relFile, exportName)
  );

  if (decisionResult) return decisionResult;
  const pathShape = pathShapeFor(relFile);
  return noDecision(pathShape ? { pathShape } : {});
}

export function createFrameworkPolicyCounters(context) {
  const rejectedSignalOccurrences = {};
  for (const pkg of context.packages) {
    for (const signal of pkg.rejectedSignals) {
      rejectedSignalOccurrences[signal] ??= { packages: 0, findingsAffected: 0 };
      rejectedSignalOccurrences[signal].packages++;
    }
  }

  return {
    mutedFindings: {},
    reviewHintFindings: {},
    rejectedSignalOccurrences,
    pathShapedCandidatesKeptVisible: {},
  };
}

function increment(map, key) {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

export function recordFrameworkPolicyDecision(counters, decisionResult) {
  if (!decisionResult || !counters) return;

  if (decisionResult.action === ACTION_MUTE) {
    increment(counters.mutedFindings, decisionResult.framework);
    return;
  }
  if (decisionResult.action === ACTION_REVIEW_HINT) {
    increment(counters.reviewHintFindings, decisionResult.framework);
    return;
  }
  if (decisionResult.action === ACTION_NONE) {
    increment(counters.pathShapedCandidatesKeptVisible, decisionResult.pathShape);
  }
}
