// Framework / convention exclusion policies for classify-dead-exports.
//
// Dead-export detection works by counting in-file and cross-file references.
// Some files have consumers the scanner can't see:
//
//   - Config files (vitest.config.ts, eslint.config.mjs, ...) — consumed
//     by tool name convention, never imported by app code.
//   - Framework-routed files (Next.js app/*/page.tsx, SvelteKit
//     routes/+page.svelte, Nuxt server/api/*.ts) — consumed by framework
//     runtime dispatch, not JS imports.
//   - Public API terminals — terminal file of a package.json `exports`
//     chain, consumed by external npm dependents outside our scan.
//
// This module owns the *patterns* that identify these cases. The
// orchestrator applies them as early-continue filters before any
// fact extraction. Centralizing them here means adding support for a
// new framework is a local edit, not a surgical strike across a
// 500-line decision tree.

import { existsSync } from 'node:fs';
import { readJsonFile } from './artifacts.mjs';
import path from 'node:path';
import { collectFiles } from './collect-files.mjs';
import { collectHonoRouteRegistrations } from './framework-policy-facts.mjs';
import {
  ACTION_MUTE,
  ACTION_NONE,
  ACTION_REVIEW_HINT,
  classifyFrameworkPolicy,
  createFrameworkPolicyContext,
  createFrameworkPolicyCounters,
  recordFrameworkPolicyDecision,
} from './framework-policy-matrix.mjs';

export {
  ACTION_MUTE,
  ACTION_NONE,
  ACTION_REVIEW_HINT,
  classifyFrameworkPolicy,
  createFrameworkPolicyCounters,
  recordFrameworkPolicyDecision,
};

// ─── FP-22: bundler/CLI-consumed config files ────────────────
// Never imported by TS code; consumed by tool name convention.
const CONFIG_PATTERNS = [
  /\.config\.(ts|tsx|mjs|js|cjs)$/,
  /^eslint\.config\./,
  /^vitest\.config\./,
  /^vite\.config\./,
  /^webpack\.config\./,
  /^rollup\.config\./,
  /^next\.config\./,
  /^astro\.config\./,
  /^svelte\.config\./,
  /^build\.config\./,
  /^tsup\.config\./,
  /^tailwind\.config\./,
  /^postcss\.config\./,
  /^playwright\.config\./,
  /^jest\.config\./,
  /^nuxt\.config\./,
  /^drizzle\.config\./,
  /^prettier\.config\./,
];

export function isConfigFile(relPath) {
  const basename = relPath.split(/[/\\]/).pop() ?? relPath;
  return CONFIG_PATTERNS.some((re) => re.test(basename));
}

// ─── FP-27: framework sentinel files (Next.js app router, SvelteKit) ─
const FRAMEWORK_SENTINEL_BASENAMES = new Set([
  'page', 'layout', 'loading', 'error', 'not-found', 'template', 'default',
  'route', 'middleware', 'instrumentation', 'global-error',
]);

export function isCoreSentinel(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  // Next.js pages router — everything in pages/ is framework-consumed.
  if (/(?:^|\/)pages\//.test(norm)) return true;
  // Next.js app router — specific basenames under app/.
  const inAppDir = /(?:^|\/)app\//.test(norm);
  if (inAppDir) {
    const basename = norm.split('/').pop() ?? '';
    const stem = basename.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
    if (FRAMEWORK_SENTINEL_BASENAMES.has(stem)) return true;
  }
  // SvelteKit +page / +layout / +server / +error convention.
  if (/\/\+(page|layout|server|error)\.(svelte|ts|tsx|js)$/.test(norm)) return true;
  if (/\/\+[a-z]+\.ts$/.test(norm)) return true;
  return false;
}

// ─── FP-30: Nuxt/Nitro detection + sentinel patterns ─────────
// Nuxt/Nitro filesystem conventions (server/api/, runtime/handlers/,
// plugins/, middleware/, composables/) overlap with legitimate path
// names in non-Nuxt codebases. Gate on dependency detection to avoid
// overmatching.
const NUXT_NAMESPACE_NON_RUNTIME_PACKAGES = new Set([
  '@nuxt/opencollective',
]);

function isNuxtNitroPackageName(name) {
  if (!name || typeof name !== 'string') return false;
  if (NUXT_NAMESPACE_NON_RUNTIME_PACKAGES.has(name)) return false;
  return name === 'nuxt' ||
    name === 'nitropack' ||
    name === 'nitro' ||
    name.startsWith('@nuxt/') ||
    name.startsWith('@nuxtjs/') ||
    name.startsWith('@nitro/');
}

export function detectNuxtNitro(rootPkgJson, workspaceDirs) {
  function matches(pkg) {
    if (!pkg) return false;
    const name = pkg.name || '';
    if (isNuxtNitroPackageName(name)) return true;
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
    };
    for (const k of Object.keys(allDeps)) {
      // `h3` is used outside Nuxt/Nitro. Do not let it activate broad
      // filesystem-route mutes for ordinary middleware/plugins folders.
      // `@nuxt/opencollective` is also not a Nuxt runtime signal; it is a
      // sponsorship helper used by non-Nuxt packages such as NestJS.
      if (isNuxtNitroPackageName(k)) return true;
    }
    return false;
  }
  if (matches(rootPkgJson)) return true;
  for (const wd of workspaceDirs || []) {
    // readJsonFile returns null on missing OR malformed — either way we
    // try the next workspace rather than erroring out. Conservative
    // default (framework policy won't apply where we can't prove it
    // does) preserved from the pre-v1.10.4 try/catch branch.
    const pkg = readJsonFile(path.join(wd, 'package.json'));
    if (pkg && matches(pkg)) return true;
  }
  return false;
}

export function detectVitePress(rootPkgJson, workspaceDirs) {
  function matches(pkg) {
    if (!pkg) return false;
    const name = pkg.name || '';
    if (name === 'vitepress') return true;
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
    };
    return Object.hasOwn(allDeps, 'vitepress');
  }
  if (matches(rootPkgJson)) return true;
  for (const wd of workspaceDirs || []) {
    const pkg = readJsonFile(path.join(wd, 'package.json'));
    if (pkg && matches(pkg)) return true;
  }
  return false;
}

export function isNuxtNitroSentinel(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  if (/(?:^|\/)server\/(api|middleware|plugins|routes)\//.test(norm)) return true;
  if (/(?:^|\/)runtime\/(handlers|middleware|plugins|utils|server-assets)\//.test(norm)) return true;
  if (/(?:^|\/)app\/(plugins|middleware)\//.test(norm)) return true;
  if (/(?:^|\/)app\/entry(?:-spa)?\.(ts|tsx|js|mjs)$/.test(norm)) return true;
  if (/(?:^|\/)(plugins|middleware|composables)\/[^\/]+\.(ts|tsx|js|mjs)$/.test(norm)) return true;
  if (/(?:^|\/)components\/runtime\//.test(norm)) return true;
  return false;
}

export function isVitePressSentinel(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  if (/(?:^|\/)\.vitepress\/config\.(ts|tsx|js|mjs|cjs)$/.test(norm)) return true;
  if (/(?:^|\/)\.vitepress\/theme\/index\.(ts|tsx|js|mjs|cjs)$/.test(norm)) return true;
  return false;
}

// ─── FP-48: declaration sidecars for runtime JS modules ─────────
// A hand-written or generated `.d.ts` next to a `.js`/`.mjs`/`.cjs`
// runtime file is consumed by TypeScript's module typing even when app
// code imports the runtime `.js` path. Static import fan-in lands on the
// runtime file, so the declaration sidecar can falsely look removable.
export function isDeclarationSidecar(relPath, root) {
  const norm = relPath.replace(/\\/g, '/');
  if (!/\.d\.[cm]?ts$/.test(norm)) return false;
  const abs = path.join(root, norm);
  const runtimeBases = [
    abs.replace(/\.d\.ts$/, '.js'),
    abs.replace(/\.d\.ts$/, '.mjs'),
    abs.replace(/\.d\.ts$/, '.cjs'),
    abs.replace(/\.d\.mts$/, '.mjs'),
    abs.replace(/\.d\.mts$/, '.js'),
    abs.replace(/\.d\.cts$/, '.cjs'),
    abs.replace(/\.d\.cts$/, '.js'),
  ];
  return runtimeBases.some((candidate) => candidate !== abs && existsSync(candidate));
}

function relPath(root, full) {
  return path.relative(root, full).replace(/\\/g, '/');
}

function collectKnownFiles({ root, symbolsData, deadList, includeTests, exclude }) {
  const files = new Set();
  try {
    for (const file of collectFiles(root, { includeTests, exclude })) {
      files.add(relPath(root, file));
    }
  } catch {
    // Fall back to artifact-visible files. Framework facts are optional;
    // ordinary classification still runs with the symbol graph evidence.
  }

  for (const file of Object.keys(symbolsData?.defIndex ?? {})) files.add(file.replace(/\\/g, '/'));
  for (const file of Object.keys(symbolsData?.reExportsByFile ?? {})) files.add(file.replace(/\\/g, '/'));
  for (const d of deadList ?? []) {
    if (d?.file) files.add(String(d.file).replace(/\\/g, '/'));
  }
  return [...files].sort();
}

function packageRecordsFromRepoMode({ root, repoMode }) {
  const records = [{
    root,
    relRoot: '.',
    packageJson: repoMode.rootPkgJson ?? readJsonFile(path.join(root, 'package.json')) ?? {},
  }];

  for (const workspaceRoot of repoMode.workspaceDirs ?? []) {
    const relRoot = relPath(root, workspaceRoot);
    const packageJson = readJsonFile(path.join(workspaceRoot, 'package.json'));
    records.push({
      root: workspaceRoot,
      relRoot,
      packageJson: packageJson ?? {},
    });
  }
  return records;
}

export function createFrameworkPolicyContextForRepo({
  root,
  repoMode,
  symbolsData,
  deadList,
  includeTests,
  exclude,
}) {
  const files = collectKnownFiles({ root, symbolsData, deadList, includeTests, exclude });
  let honoRouteRegistrations = [];
  try {
    honoRouteRegistrations = collectHonoRouteRegistrations({ root, files });
  } catch {
    honoRouteRegistrations = [];
  }

  return createFrameworkPolicyContext({
    root,
    packageRecords: packageRecordsFromRepoMode({ root, repoMode }),
    files,
    frameworkFacts: { honoRouteRegistrations },
  });
}
