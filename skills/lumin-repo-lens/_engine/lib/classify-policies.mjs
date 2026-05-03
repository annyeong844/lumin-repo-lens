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

import { existsSync, readdirSync } from 'node:fs';
import { readJsonFile } from './artifacts.mjs';
import path from 'node:path';
import { collectFiles } from './collect-files.mjs';
import { collectHonoRouteRegistrations } from './framework-policy-facts.mjs';
import {
  ACTION_MUTE,
  classifyFrameworkPolicy,
  createFrameworkPolicyContext,
  createFrameworkPolicyCounters,
  recordFrameworkPolicyDecision,
} from './framework-policy-matrix.mjs';

export {
  ACTION_MUTE,
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

const FRAMEWORK_CONFIG_FILE_NAMES = new Set([
  'wrangler.toml',
  'wrangler.json',
  'wrangler.jsonc',
]);
const FRAMEWORK_CONFIG_PRUNE_NAMES = new Set([
  'node_modules',
  '.git',
  'coverage',
  '.next',
  '.svelte-kit',
  '.astro',
  '.turbo',
  '.cache',
  '.nuxt',
  '.output',
]);
const FRAMEWORK_CONFIG_PRUNE_PREFIXES = ['dist', 'build'];

function shouldPruneFrameworkConfigDir(name) {
  if (FRAMEWORK_CONFIG_PRUNE_NAMES.has(name)) return true;
  return FRAMEWORK_CONFIG_PRUNE_PREFIXES.some((prefix) =>
    name === prefix || name.startsWith(`${prefix}-`));
}

function collectFrameworkConfigFiles(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldPruneFrameworkConfigDir(entry.name)) continue;
        walk(full);
        continue;
      }
      if (entry.isFile() && FRAMEWORK_CONFIG_FILE_NAMES.has(entry.name)) {
        out.push(relPath(root, full));
      }
    }
  }
  walk(root);
  return out;
}

function collectKnownFiles({ root, symbolsData, deadList, includeTests, exclude }) {
  const files = new Set();
  try {
    for (const file of collectFiles(root, { includeTests, exclude })) {
      files.add(relPath(root, file));
    }
    for (const file of collectFrameworkConfigFiles(root)) {
      files.add(file);
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

function packageDependencyNames(packageJson = {}) {
  return new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ]);
}

export function shouldCollectHonoRouteFactsForPackages(packageRecords = []) {
  return packageRecords.some((record) =>
    packageDependencyNames(record?.packageJson ?? {}).has('hono'));
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
  const packageRecords = packageRecordsFromRepoMode({ root, repoMode });
  let honoRouteRegistrations = [];
  if (shouldCollectHonoRouteFactsForPackages(packageRecords)) {
    try {
      honoRouteRegistrations = collectHonoRouteRegistrations({ root, files });
    } catch {
      honoRouteRegistrations = [];
    }
  }

  return createFrameworkPolicyContext({
    root,
    packageRecords,
    files,
    frameworkFacts: { honoRouteRegistrations },
  });
}
