// check-barrel-discipline.mjs — Barrel import discipline (parameterized)
//
// For monorepos: checks whether workspace packages' root barrel imports are
// blocked (via ESLint no-restricted-syntax or similar) in favor of subpath imports.
//
// For single-package repos: there are no workspace barrels to discipline.
// Emits a note artifact and exits.
//
// Usage: node check-barrel-discipline.mjs --root <repo> [--output <dir>]

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseOxcOrThrow } from '../lib/parse-oxc.mjs';
import { computeLineStarts, lineOf } from '../lib/line-offset.mjs';
import { parseCliArgs } from '../lib/cli.mjs';
import { detectRepoMode } from '../lib/repo-mode.mjs';
import { buildAliasMap } from '../lib/alias-map.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { relPath } from '../lib/paths.mjs';

const cli = parseCliArgs();
const { root: ROOT, output, verbose } = cli;

const repoMode = detectRepoMode(ROOT);

// Early exit for single-package repos
if (repoMode.mode === 'single-package') {
  const artifact = {
    meta: {
      generated: new Date().toISOString(),
      root: ROOT,
      tool: 'check-barrel-discipline.mjs',
    },
    mode: 'single-package',
    skipped: true,
    reason: 'Single-package repo has no workspace barrels to discipline. This check is monorepo-only.',
  };
  const outPath = path.join(output, 'barrels.json');
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`[barrels] single-package mode — analysis skipped`);
  console.log(`[barrels] saved → ${outPath}`);
  process.exit(0);
}

// ─── Monorepo path ────────────────────────────────────────
const aliasMap = buildAliasMap(ROOT, repoMode);
const rootBarrelSpecs = new Set();
const subpathPrefixes = new Set();

for (const [spec, _entry] of aliasMap) {
  if (spec.includes('__WILDCARD__') || spec.includes('__HASHWILDCARD__')) continue;
  if (spec.includes('/')) {
    const atScope = spec.startsWith('@');
    if (atScope) {
      const parts = spec.split('/');
      if (parts.length >= 2) {
        const root = `${parts[0]}/${parts[1]}`;
        rootBarrelSpecs.add(root);
        subpathPrefixes.add(root + '/');
      }
    }
  } else {
    rootBarrelSpecs.add(spec);
  }
}

if (verbose) {
  console.error(`[barrels] workspace packages: ${[...rootBarrelSpecs].join(', ')}`);
}

const files = collectFiles(ROOT, { includeTests: cli.includeTests, exclude: cli.exclude });

// Line-offset helpers moved to _lib/line-offset.mjs (v1.8.2).

const rootImportsByPkg = new Map();
const subpathUsage = new Map();
let totalImports = 0;
let parseErrors = 0;
let unreadableCount = 0; // E-4: surface per-file read skips so totals aren't silently low.

for (const f of files) {
  let src;
  try { src = readFileSync(f, 'utf8'); } catch { unreadableCount++; continue; }
  let parsed;
  try {
    parsed = parseOxcOrThrow(f, src);
  } catch {
    parseErrors++;
    continue;
  }
  const lineStarts = computeLineStarts(src);
  const lines = src.split('\n');

  for (const node of parsed.program.body) {
    const isImport = node.type === 'ImportDeclaration';
    const isReExport =
      (node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') &&
      node.source;
    if (!isImport && !isReExport) continue;
    totalImports++;

    const source = node.source.value;
    const lineNum = lineOf(lineStarts, node.start);
    const prev = lines[lineNum - 2] ?? '';
    const curr = lines[lineNum - 1] ?? '';
    const eslintDisable = prev.includes('eslint-disable') || curr.includes('eslint-disable');

    if (rootBarrelSpecs.has(source)) {
      if (!rootImportsByPkg.has(source)) rootImportsByPkg.set(source, []);
      const specifiers = (isImport ? (node.specifiers ?? []) : []).map(s => s.imported?.name ?? s.local?.name);
      rootImportsByPkg.get(source).push({
        file: relPath(ROOT, f),
        line: lineNum,
        symbols: specifiers,
        typeOnly: isImport ? node.importKind === 'type' : false,
        eslintDisable,
        reExport: isReExport,
      });
    }

    for (const prefix of subpathPrefixes) {
      if (source.startsWith(prefix)) {
        subpathUsage.set(source, (subpathUsage.get(source) || 0) + 1);
        break;
      }
    }
  }
}

const byPackage = {};
for (const pkg of rootBarrelSpecs) {
  const directList = rootImportsByPkg.get(pkg) ?? [];
  const prefix = pkg + '/';
  const subpathCount = [...subpathUsage.entries()]
    .filter(([k]) => k.startsWith(prefix))
    .reduce((a, [, v]) => a + v, 0);
  const subpathBreakdown = Object.fromEntries(
    [...subpathUsage.entries()].filter(([k]) => k.startsWith(prefix))
  );
  const total = directList.length + subpathCount;

  byPackage[pkg] = {
    rootImports: directList.length,
    subpathImports: subpathCount,
    total,
    policyCompliance: total === 0 ? 'n/a (no imports)' : `${((subpathCount / total) * 100).toFixed(1)}%`,
    rootImportDisabledByEslint: directList.filter(x => x.eslintDisable).length,
    subpathBreakdown,
    sampleRootImporters: directList.slice(0, 10),
  };
}

const artifact = {
  meta: {
    generated: new Date().toISOString(),
    root: ROOT,
    mode: repoMode.mode,
    tool: 'check-barrel-discipline.mjs',
  },
  summary: {
    workspacePackages: [...rootBarrelSpecs],
    filesScanned: files.length,
    totalImports,
    parseErrors,
    unreadableFiles: unreadableCount,
  },
  byPackage,
};

const outPath = path.join(output, 'barrels.json');
writeFileSync(outPath, JSON.stringify(artifact, null, 2));

console.log(`[barrels] ${rootBarrelSpecs.size} workspace packages scanned`);
for (const [pkg, data] of Object.entries(byPackage)) {
  console.log(`  ${pkg}: root=${data.rootImports}, subpath=${data.subpathImports}, compliance=${data.policyCompliance}`);
}
if (unreadableCount > 0) {
  console.warn(`[barrels] WARN: ${unreadableCount} file(s) could not be read — counts may be low. Check permissions/symlinks.`);
}
console.log(`[barrels] saved → ${outPath}`);
