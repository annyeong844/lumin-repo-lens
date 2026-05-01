#!/usr/bin/env node
// triage-repo.mjs — 10-minute repo shape
//
// Usage: node triage-repo.mjs --root <repo> [--output <dir>]

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseCliArgs } from '../lib/cli.mjs';
import { detectRepoMode } from '../lib/repo-mode.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { isTestLikePath } from '../lib/test-paths.mjs';
import { relPath } from '../lib/paths.mjs';
import { readJsonFile, producerMetaBase } from '../lib/artifacts.mjs';

const cli = parseCliArgs();
const { root, output, verbose, includeTests } = cli;

if (verbose) console.error(`[triage] root: ${root}`);

const repoMode = detectRepoMode(root);

// ─── Shape ────────────────────────────────────────────────
// v0.6.8 Issue 7 fix: previously Python detection used shell `find` with
// string-interpolated ROOT (injection risk) AND was gated on `src/` or
// `tests/` existence — silently dropping root-only Python repos from the
// count. Go was not tracked at all. Route everything through collectFiles
// so the same pruning / test-filter / language rules apply uniformly.
// v1.3.0: respect `--exclude` patterns supplied at the CLI.
// v1.8.3: count `.mts` / `.cts` alongside `.ts`/`.tsx` and the full JS
// family (`.jsx`, `.cjs`). Previously these were dropped from the triage
// count, making dual-emit packages look half their actual size.
const tsFiles = collectFiles(root, { languages: ['ts', 'tsx', 'mts', 'cts'], includeTests, exclude: cli.exclude });
const jsFiles = collectFiles(root, { languages: ['js', 'jsx', 'mjs', 'cjs'], includeTests, exclude: cli.exclude });
const pyFiles = collectFiles(root, { languages: ['py'], includeTests, exclude: cli.exclude });
const goFiles = collectFiles(root, { languages: ['go'], includeTests, exclude: cli.exclude });

const totalFiles = tsFiles.length + jsFiles.length + pyFiles.length + goFiles.length;
let totalLoc = 0;
const loc = (f) => {
  try { return readFileSync(f, 'utf8').split('\n').length; } catch { return 0; }
};
for (const f of [...tsFiles, ...jsFiles, ...pyFiles, ...goFiles]) totalLoc += loc(f);

// Test vs production — v1.3.0: delegate to the shared helper so the count
// matches what `--no-include-tests` scans actually drop.
const testFiles = [...tsFiles, ...jsFiles, ...pyFiles, ...goFiles].filter(isTestLikePath);

// ─── Build system ─────────────────────────────────────────
const buildSystem = { type: 'unknown' };
const pkgJsonPath = path.join(root, 'package.json');
// readJsonFile is null on missing OR malformed — either way we stay with
// type='unknown' rather than crashing triage on a bad root pkg.json.
const pkg = readJsonFile(pkgJsonPath);
if (pkg) {
  buildSystem.type = 'node';
  buildSystem.name = pkg.name;
  buildSystem.version = pkg.version;
  buildSystem.scripts = Object.keys(pkg.scripts || {});
  buildSystem.deps = Object.keys(pkg.dependencies || {}).length;
  buildSystem.devDeps = Object.keys(pkg.devDependencies || {}).length;
  buildSystem.workspaces = !!pkg.workspaces;
  buildSystem.hasExports = !!pkg.exports;
  buildSystem.hasImports = !!pkg.imports;
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) buildSystem.packageManager = 'pnpm';
  else if (existsSync(path.join(root, 'yarn.lock'))) buildSystem.packageManager = 'yarn';
  else if (existsSync(path.join(root, 'package-lock.json'))) buildSystem.packageManager = 'npm';
}
if (existsSync(path.join(root, 'pyproject.toml'))) buildSystem.python = 'pyproject.toml';

// ─── Config files ─────────────────────────────────────────
const configs = {
  tsconfig: findAll(root, /^tsconfig.*\.json$/, 3),
  eslintConfig: findAll(root, /^\.eslintrc.*$|^eslint\.config\.[mc]?[jt]s$/, 3),
  prettier: findAll(root, /^\.prettierrc.*$|^prettier\.config\.[mc]?[jt]s$/, 3),
  pyproject: existsSync(path.join(root, 'pyproject.toml')),
  mypyIni: existsSync(path.join(root, 'mypy.ini')) || existsSync(path.join(root, '.mypy.ini')),
  setupCfg: existsSync(path.join(root, 'setup.cfg')),
};

function findAll(dir, pattern, maxDepth) {
  const results = [];
  function walk(d, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.git') || e.name === 'node_modules' || e.name === 'dist') continue;
      const full = path.join(d, e.name);
      if (e.isFile() && pattern.test(e.name)) results.push(relPath(root, full));
      else if (e.isDirectory()) walk(full, depth + 1);
    }
  }
  walk(dir, 0);
  return results;
}

// ─── Top-level directory shape ────────────────────────────
// v0.6.8 Issue 7 fix: previously shelled out to `find` per subdir. Now
// partition the pre-collected file list in-memory — no subprocess, no
// shell-injection exposure, and consistent with the language filters used
// above (Go is included; Python no longer gated on src/tests existence).
const allShapeFiles = [...tsFiles, ...jsFiles, ...pyFiles, ...goFiles];
const topDirs = {};
try {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build'].includes(entry.name)) continue;
    const subPath = path.join(root, entry.name);
    const prefix = subPath + path.sep;
    const subFiles = allShapeFiles.filter((f) => f.startsWith(prefix));
    if (subFiles.length === 0) continue;
    let lc = 0;
    for (const sf of subFiles) lc += loc(sf);
    topDirs[entry.name] = { files: subFiles.length, loc: lc };
  }
} catch {
  // readdirSync may fail on constrained environments (e.g. root is a
  // symlink mounted from a stale NFS share). Skip topDirs enrichment;
  // the rest of the triage report is still meaningful without it.
}

// ─── Declared boundaries ──────────────────────────────────
const boundaries = [];
for (const eslintConf of configs.eslintConfig) {
  try {
    const content = readFileSync(path.join(root, eslintConf), 'utf8');
    if (content.includes('no-restricted-syntax')) boundaries.push({ rule: 'no-restricted-syntax', file: eslintConf });
    if (content.includes('no-restricted-imports')) boundaries.push({ rule: 'no-restricted-imports', file: eslintConf });
    if (content.includes('no-restricted-paths')) boundaries.push({ rule: 'no-restricted-paths', file: eslintConf });
    if (content.includes('no-explicit-any')) boundaries.push({ rule: 'no-explicit-any', file: eslintConf });
    if (content.includes('boundaries/')) boundaries.push({ rule: 'eslint-plugin-boundaries', file: eslintConf });
  } catch {
    // ESLint config file was listed but unreadable (race, permissions,
    // or the user deleted it since the configs scan). Skip; not having
    // this file's boundaries is isomorphic to the user not having that
    // rule.
  }
}

// ─── Initial hypotheses (blind, for M3 drill selection) ──
const hypotheses = [];
if (configs.eslintConfig.length === 0 && buildSystem.type === 'node') {
  hypotheses.push({
    claim: 'ESLint config absent — typing discipline likely uneven',
    basis: 'no .eslintrc / eslint.config.* found',
    grounding: 'blind',
  });
}
if (buildSystem.workspaces === false && totalFiles > 100) {
  hypotheses.push({
    claim: 'Single package with 100+ files — likely some layer violations',
    basis: 'workspaces undefined, code size moderate',
    grounding: 'blind',
  });
}
// biggest top-dir often contains god modules
const biggestDir = Object.entries(topDirs).sort((a, b) => b[1].loc - a[1].loc)[0];
if (biggestDir && biggestDir[1].loc > 10000) {
  hypotheses.push({
    claim: `${biggestDir[0]}/ is largest module (${biggestDir[1].loc} LOC) — inspect for god modules`,
    basis: 'LOC distribution across top-level dirs',
    grounding: 'blind',
  });
}

// ─── Output ───────────────────────────────────────────────
const artifact = {
  meta: producerMetaBase({ tool: 'triage-repo.mjs', root }),
  shape: {
    totalFiles,
    totalLoc,
    tsFiles: tsFiles.length,
    jsFiles: jsFiles.length,
    pyFiles: pyFiles.length,
    goFiles: goFiles.length,
    testFiles: testFiles.length,
    meanLocPerFile: Math.round(totalLoc / Math.max(totalFiles, 1)),
  },
  buildSystem,
  configs,
  boundaries,
  topDirs,
  mode: repoMode.mode,
  hypotheses,
};

const outPath = path.join(output, 'triage.json');
writeFileSync(outPath, JSON.stringify(artifact, null, 2));

console.log(`[triage] ${totalFiles} files, ${totalLoc.toLocaleString()} LOC`);
console.log(`[triage] mode: ${repoMode.mode}, build: ${buildSystem.type}, eslint: ${configs.eslintConfig.length > 0 ? 'yes' : 'NO'}`);
console.log(`[triage] hypotheses: ${hypotheses.length}`);
for (const h of hypotheses) console.log(`  - ${h.claim}`);
console.log(`[triage] saved → ${outPath}`);
