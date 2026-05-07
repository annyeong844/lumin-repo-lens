// Alias map builder — reads each package's `exports` and `imports` fields
// and compiles them into a flat Map keyed by specifier pattern, with
// wildcard entries stored separately with pre-computed `matchPrefix` /
// `matchSuffix` for O(1) resolver lookup.
//
// Also exposes `mapOutputToSource` for resolver-core — when an `exports`
// entry points at compiled output (`./dist/index.js`), we probe sibling
// source-dir conventions (`src/`, `source/`, `lib/`, etc.) to prefer the
// authored `.ts` source.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileExists } from './paths.mjs';
import { discoverScopedTsconfigResolution } from './tsconfig-paths.mjs';
import { readJsonFile } from './artifacts.mjs';
import {
  addGeneratedEvidence,
  evidence,
  exportsEvidenceField,
  generatedOutputArtifactEvidence,
  normalizeGeneratedSubpath,
} from './generated-artifact-evidence.mjs';
import { buildPrismaEnumVirtualSurface } from './generated-virtual-surface.mjs';

// Recursively extract a string target from a conditional exports object.
// Handles nested forms like { node: { import: { types, default }, require: ... } }.
// FP-18 fix: earlier code did `target.import ?? target.default` which can return an object.
export function extractStringTarget(target, depth = 0) {
  if (depth > 8) return null;
  if (target == null) return null;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const r = extractStringTarget(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof target !== 'object') return null;

  // v0.6.5 FP-28: prefer "source" conditions first — these point at actual
  // source (e.g., `@zod/source: "./src/index.ts"`), not compiled output.
  // The skill always prefers source over compiled artifacts for analysis.
  for (const key of Object.keys(target)) {
    if (key === 'source' || key === '@*/source' || /^@[^/]+\/source$/.test(key) || key.endsWith('/source')) {
      const r = extractStringTarget(target[key], depth + 1);
      if (r) return r;
    }
  }

  // Standard preference order: import > default > node > require > types
  for (const key of ['import', 'default', 'node', 'require', 'types']) {
    if (key in target) {
      const r = extractStringTarget(target[key], depth + 1);
      if (r) return r;
    }
  }
  // Fallback: any string value
  for (const v of Object.values(target)) {
    const r = extractStringTarget(v, depth + 1);
    if (r) return r;
  }
  return null;
}

// v0.6.3: map a package.json "exports" output-dir target to the actual
// source file. Common output-dir → source-dir pairs:
//   dist/ → src/, source/, lib/
//   distribution/ → source/, src/   (sindresorhus convention)
//   build/ → src/
//   out/ → src/
// Also swaps compiled extensions (.mjs/.cjs/.js) to source (.ts/.tsx).
// Uses filesystem existence to pick the first plausible source path.
// Falls back to the original (stripped) target if no swap matches.
const OUT_SRC_PAIRS = [
  ['dist', 'src'],
  ['dist', 'source'],
  ['dist', 'lib'],
  ['distribution', 'source'],
  ['distribution', 'src'],
  ['build', 'src'],
  ['out', 'src'],
  ['es', 'src'],
  ['esm', 'src'],
];
const OUTPUT_ARTIFACT_DIRS = new Set(OUT_SRC_PAIRS.map(([out]) => out));

export function listPackageDirs(root, repoMode) {
  const dirs = [];
  const seen = new Set();
  function add(dir) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    dirs.push(resolved);
  }
  add(root);
  for (const wd of repoMode.workspaceDirs || []) add(wd);
  return dirs;
}

export function mapOutputToSource(pkgDir, target) {
  const stripped = target.replace(/^\.\//, '');
  const sourceCandidates = [];
  const fallbackCandidates = [];

  function addCandidate(list, candidate) {
    if (!candidate || list.includes(candidate)) return;
    list.push(candidate);
  }

  for (const [out, src] of OUT_SRC_PAIRS) {
    if (!stripped.startsWith(out + '/')) continue;
    const rest = stripped.slice(out.length + 1);
    addCandidate(sourceCandidates, src + '/' + rest);
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.(mjs|cjs|js)$/, '.ts'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.(mjs|cjs|js)$/, '.tsx'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.jsx$/, '.tsx'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.d\.[cm]?ts$/, '.ts'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.d\.[cm]?ts$/, '.tsx'));
    const restStem = rest.replace(/\.d\.[cm]?ts$/, '').replace(/\.[^.]+$/, '');
    const asDir = src + '/' + restStem + '/index.ts';
    addCandidate(sourceCandidates, asDir);
    // Some workspace packages compile root-level source directly to
    // dist/ (`index.ts` → `dist/index.js`, `api.ts` → `dist/api.js`)
    // rather than through src/. Several private/workspace packages use this
    // shape; without root-source candidates their workspace imports are
    // reported as UNRESOLVED_INTERNAL.
    addCandidate(sourceCandidates, rest);
    addCandidate(sourceCandidates, rest.replace(/\.(mjs|cjs|js)$/, '.ts'));
    addCandidate(sourceCandidates, rest.replace(/\.(mjs|cjs|js)$/, '.tsx'));
    addCandidate(sourceCandidates, rest.replace(/\.jsx$/, '.tsx'));
    addCandidate(sourceCandidates, rest.replace(/\.d\.[cm]?ts$/, '.ts'));
    addCandidate(sourceCandidates, rest.replace(/\.d\.[cm]?ts$/, '.tsx'));
    addCandidate(sourceCandidates, restStem + '/index.ts');
  }

  addCandidate(fallbackCandidates, stripped);
  addCandidate(fallbackCandidates, stripped.replace(/\.(mjs|cjs|js)$/, '.ts'));
  addCandidate(fallbackCandidates, stripped.replace(/\.(mjs|cjs|js)$/, '.tsx'));
  addCandidate(fallbackCandidates, stripped.replace(/\.jsx$/, '.tsx'));
  addCandidate(fallbackCandidates, stripped.replace(/\.d\.[cm]?ts$/, '.ts'));
  addCandidate(fallbackCandidates, stripped.replace(/\.d\.[cm]?ts$/, '.tsx'));

  const candidates = [...sourceCandidates, ...fallbackCandidates];
  for (const c of candidates) {
    const abs = path.join(pkgDir, c);
    if (fileExists(abs)) return abs;
  }
  return path.join(pkgDir, stripped);
}

// Pattern-form sibling of `mapOutputToSource`. Used when the target
// contains `*` (e.g. `./dist/*.js`) and FS probing doesn't apply —
// the wildcard isn't a real file, so we can't pick among candidates
// by existence. Returns the first plausible source pattern after
// applying the same out-dir + extension swaps. Previously each
// wildcard-using call site rolled its own narrow `.js → .ts`
// replacement and silently missed `.mjs`/`.cjs`/`.jsx` (FP-40 class
// — same bug fixed for the `exports` side in v1.10.0 R-8).
export function mapOutputPatternToSource(pattern) {
  let s = pattern.replace(/^\.\//, '');
  for (const [out, src] of OUT_SRC_PAIRS) {
    if (s.startsWith(out + '/')) {
      s = src + '/' + s.slice(out.length + 1);
      break;
    }
  }
  return s
    .replace(/\.(mjs|cjs|js)$/, '.ts')
    .replace(/\.jsx$/, '.tsx');
}

export function mapOutputPatternToSourceCandidates(pattern) {
  const stripped = pattern.replace(/^\.\//, '');
  const sourceCandidates = [];
  const fallbackCandidates = [];

  function addCandidate(list, candidate) {
    if (!candidate || list.includes(candidate)) return;
    list.push(candidate);
  }

  for (const [out, src] of OUT_SRC_PAIRS) {
    if (!stripped.startsWith(out + '/')) continue;
    const rest = stripped.slice(out.length + 1);
    addCandidate(sourceCandidates, src + '/' + rest);
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.(mjs|cjs|js)$/, '.ts'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.(mjs|cjs|js)$/, '.tsx'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.jsx$/, '.tsx'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.d\.[cm]?ts$/, '.ts'));
    addCandidate(sourceCandidates, src + '/' + rest.replace(/\.d\.[cm]?ts$/, '.tsx'));
    addCandidate(sourceCandidates, rest);
    addCandidate(sourceCandidates, rest.replace(/\.(mjs|cjs|js)$/, '.ts'));
    addCandidate(sourceCandidates, rest.replace(/\.(mjs|cjs|js)$/, '.tsx'));
    addCandidate(sourceCandidates, rest.replace(/\.jsx$/, '.tsx'));
    addCandidate(sourceCandidates, rest.replace(/\.d\.[cm]?ts$/, '.ts'));
    addCandidate(sourceCandidates, rest.replace(/\.d\.[cm]?ts$/, '.tsx'));
  }

  addCandidate(fallbackCandidates, stripped);
  addCandidate(fallbackCandidates, stripped.replace(/\.(mjs|cjs|js)$/, '.ts'));
  addCandidate(fallbackCandidates, stripped.replace(/\.(mjs|cjs|js)$/, '.tsx'));
  addCandidate(fallbackCandidates, stripped.replace(/\.jsx$/, '.tsx'));
  addCandidate(fallbackCandidates, stripped.replace(/\.d\.[cm]?ts$/, '.ts'));
  addCandidate(fallbackCandidates, stripped.replace(/\.d\.[cm]?ts$/, '.tsx'));

  return [...sourceCandidates, ...fallbackCandidates];
}

// Detect the source-file counterpart of each workspace's public entry
// (package.json `exports['.']`). Used by build-symbol-graph to skip
// barrel files — they serve as re-export hubs, not definition
// sources, so their "dead exports" are false by construction.
//
// Moved here from build-symbol-graph.mjs in v1.10.1: this function
// is a tiny wrapper over `extractStringTarget` + `mapOutputToSource`
// (both defined in this module), so it belongs where those live.
// Returns a `Set<absolutePath>` — caller checks membership by abs
// path as def files are keyed.
//
// Unparseable or missing package.json files are silently skipped:
// workspaces aren't required to export anything; a workspace without
// exports just doesn't contribute a barrel entry.
export function detectBarrelFiles(root, repoMode) {
  const barrels = new Set();
  for (const wd of listPackageDirs(root, repoMode)) {
    // readJsonFile returns null on missing OR malformed — either is a
    // non-fatal skip here. See docblock above.
    const pkg = readJsonFile(path.join(wd, 'package.json'));
    if (!pkg) continue;
    for (const [subpath, target] of normalizeExportsToEntries(pkg.exports)) {
      if (subpath !== '.') continue;
      const t = extractStringTarget(target);
      if (t) barrels.add(mapOutputToSource(wd, t));
    }
  }
  return barrels;
}

// Normalize `pkgJson.exports` into a list of [subpath, target] pairs,
// covering the three shapes permitted by Node.js's exports spec:
//   1. String         "exports": "./dist/index.mjs"
//   2. Conditional    "exports": { import: X, default: Y }
//   3. Subpaths map   "exports": { ".": X, "./sub": Y, ... }
// Legacy code assumed shape 3 only and iterated Object.entries — which
// for a string value yields character-position iteration (BUG). v0.6.3
// landed the normalization.
function normalizeExportsToEntries(rawExports) {
  if (typeof rawExports === 'string') return [['.', rawExports]];
  if (rawExports && typeof rawExports === 'object' && !Array.isArray(rawExports)) {
    const keys = Object.keys(rawExports);
    const isSubpathMap = keys.some((k) => k === '.' || k.startsWith('./'));
    return isSubpathMap ? Object.entries(rawExports) : [['.', rawExports]];
  }
  return [];
}

// Pass 1: pkgJson.exports → map entries. Handles exact subpaths and
// wildcard subpaths (`./*`, `./features/*`, ...). Wildcard entries carry
// pre-computed matchPrefix / matchSuffix for O(1) resolver lookup.
function addExportsEntries(map, pkgDir, pkgJson) {
  for (const [subpath, target] of normalizeExportsToEntries(pkgJson.exports)) {
    const t = extractStringTarget(target);
    if (!t || typeof t !== 'string') continue;

    if (subpath.includes('*')) {
      // v0.6.8 fix: broadened from `subpath === './*'` to any subpath
      // containing `*` — covers `./features/*`, `./ui/components/*`, and
      // patterns with suffixes like `./sub/*.js`. Multiple wildcards per
      // package supported; resolver picks the longest prefix match.
      const starIdx = subpath.indexOf('*');
      const subpathPrefix = subpath.slice(1, starIdx);
      const subpathSuffix = subpath.slice(starIdx + 1);
      const uniqueKey = `${pkgJson.name}${subpath.slice(1)}__WILDCARD__`;
      map.set(uniqueKey, {
        type: 'wildcard',
        source: 'exports',
        pkgDir,
        pkgName: pkgJson.name,
        matchPrefix: pkgJson.name + subpathPrefix,
        matchSuffix: subpathSuffix,
        targetPattern: t,
      });
    } else {
      const resolvedTarget = mapOutputToSource(pkgDir, t);
      const spec = subpath === '.' ? pkgJson.name : pkgJson.name + subpath.slice(1);
      const generatedArtifact = generatedOutputArtifactEvidence(pkgJson, t, exportsEvidenceField(subpath), {
        outputArtifactDirs: OUTPUT_ARTIFACT_DIRS,
      });
      map.set(spec, {
        type: 'exact',
        source: 'exports',
        path: resolvedTarget,
        ...(generatedArtifact ? { generatedArtifact } : {}),
      });
    }
  }
}

function dependencyNames(pkgJson) {
  return [
    ...Object.keys(pkgJson.dependencies ?? {}),
    ...Object.keys(pkgJson.devDependencies ?? {}),
    ...Object.keys(pkgJson.peerDependencies ?? {}),
    ...Object.keys(pkgJson.optionalDependencies ?? {}),
  ];
}

function localScriptPathsFromCommand(command) {
  const text = String(command ?? '');
  const paths = [];
  const re = /["']?((?:\.{1,2}\/|[A-Za-z0-9_-]+\/)[^"'`\s;&|]+?\.(?:mjs|cjs|js|ts))["']?/g;
  for (const match of text.matchAll(re)) {
    const scriptPath = String(match[1] ?? '').replace(/\\/g, '/');
    if (!scriptPath || scriptPath.includes('node_modules/')) continue;
    paths.push(scriptPath);
  }
  return [...new Set(paths)];
}

function readPackageScriptFile(pkgDir, scriptPath) {
  const abs = path.resolve(pkgDir, scriptPath);
  if (!fileExists(abs)) return null;
  try {
    const src = readFileSync(abs, 'utf8');
    // Package scripts can be arbitrary code. This classifier only needs small
    // path literals; oversized files stay out of strong evidence.
    if (src.length > 256_000) return null;
    return src;
  } catch {
    return null;
  }
}

function normalizeStaticOutputPath(parts) {
  const start = parts.findIndex((part) => /^(public|static|generated|__generated__)$/i.test(part));
  if (start < 0) return null;
  const rel = parts.slice(start)
    .map((part) => String(part).trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  if (!/\.[A-Za-z0-9]+$/.test(rel)) return null;
  return rel;
}

function staticOutputPathsFromScriptSource(src) {
  const outputs = new Set();
  const literalRe = /["'`]((?:public|static|generated|__generated__)\/[^"'`]+?\.[A-Za-z0-9]+)["'`]/g;
  for (const match of src.matchAll(literalRe)) {
    const rel = String(match[1] ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (rel) outputs.add(rel);
  }

  const joinRe = /path\.join\(\s*(?:process\.cwd\(\)\s*,\s*)?([^)]*)\)/g;
  for (const match of src.matchAll(joinRe)) {
    const args = String(match[1] ?? '');
    const parts = [...args.matchAll(/["'`]([^"'`]+)["'`]/g)]
      .map((m) => String(m[1] ?? '').replace(/\\/g, '/'));
    const rel = normalizeStaticOutputPath(parts);
    if (rel) outputs.add(rel);
  }
  return [...outputs].sort();
}

function addGeneratedStaticEvidenceFromScripts(packets, pkgDir, scriptEntries) {
  for (const [key, value] of scriptEntries) {
    const scriptPaths = localScriptPathsFromCommand(value);
    for (const scriptPath of scriptPaths) {
      const src = readPackageScriptFile(pkgDir, scriptPath);
      if (!src) continue;
      for (const outputPath of staticOutputPathsFromScriptSource(src)) {
        addGeneratedEvidence(packets, outputPath, 'static-artifact', [
          evidence('package-script', `scripts.${key}`, String(value)),
          evidence('script-output-path', `scripts.${key}`, outputPath),
          evidence('script-source', scriptPath, outputPath),
        ], { full: true });
      }
    }
  }
}

function inferGeneratedSubpathEvidence(pkgJson, pkgDir) {
  const packets = new Map();
  const deps = new Set(dependencyNames(pkgJson));
  const prismaDeps = [...deps].filter((name) => /^(@prisma\/client|prisma|prisma-)/.test(name));
  const zodPrismaDeps = [...deps].filter((name) => /zod[-_]prisma|prisma[-_]zod/.test(name));
  const scriptEntries = Object.entries(pkgJson.scripts ?? {});
  const binEntries = typeof pkgJson.bin === 'string'
    ? [[pkgJson.name, pkgJson.bin]]
    : Object.entries(pkgJson.bin ?? {});
  const fileEntries = Array.isArray(pkgJson.files) ? pkgJson.files : [];

  const prismaScriptEvidence = scriptEntries
    .filter(([, value]) => /\bprisma\s+generate\b/i.test(String(value)))
    .map(([key, value]) => evidence('package-script', `scripts.${key}`, String(value)));
  const prismaConfigEvidence = pkgJson.prisma && typeof pkgJson.prisma === 'object'
    ? [evidence('package-metadata', 'prisma', 'package.json#prisma')]
    : [];
  const prismaDependencyEvidence = prismaDeps.map((name) =>
    evidence('dependency', `dependencies.${name}`, name));

  const enumEvidence = [
    ...binEntries
      .filter(([key, value]) => /prisma[-_]enum|enum[-_]generator/i.test(`${key} ${value}`))
      .map(([key, value]) => evidence('package-bin', `bin.${key}`, String(value))),
    ...scriptEntries
      .filter(([key, value]) => /prisma[-_]enum|enum[-_]generator/i.test(`${key} ${value}`))
      .map(([key, value]) => evidence('package-script', `scripts.${key}`, String(value))),
  ];
  addGeneratedEvidence(packets, 'enums', 'prisma', enumEvidence);

  for (const file of fileEntries) {
    const normalized = String(file).replace(/^\.\//, '').replace(/\\/g, '/');
    const first = normalizeGeneratedSubpath(normalized);
    const fileEvidence = [
      evidence('package-files', 'files', String(file)),
      ...prismaScriptEvidence,
      ...prismaConfigEvidence,
    ];
    if (/^(generated|__generated__)(\/|$)/i.test(normalized)) {
      addGeneratedEvidence(packets, first, 'prisma', fileEvidence);
    }
    if (/^(client|zod)(\/|$)/i.test(normalized) && prismaScriptEvidence.length > 0) {
      addGeneratedEvidence(packets, first, 'prisma', fileEvidence);
    }
  }

  if (prismaScriptEvidence.length > 0 || prismaConfigEvidence.length > 0) {
    addGeneratedEvidence(packets, 'generated', 'prisma', [
      ...prismaScriptEvidence,
      ...prismaConfigEvidence,
      ...prismaDependencyEvidence,
    ]);
  }
  if (zodPrismaDeps.length > 0 && (prismaScriptEvidence.length > 0 || prismaConfigEvidence.length > 0)) {
    const zodEvidence = [
      ...zodPrismaDeps.map((name) => evidence('dependency', `dependencies.${name}`, name)),
      ...prismaScriptEvidence,
      ...prismaConfigEvidence,
    ];
    addGeneratedEvidence(packets, 'zod', 'prisma', zodEvidence);
    addGeneratedEvidence(packets, 'zod-utils.ts', 'prisma', zodEvidence);
  }

  if (pkgDir) {
    addGeneratedStaticEvidenceFromScripts(packets, pkgDir, scriptEntries);
  }

  return [...packets.values()].sort((a, b) => a.targetSubpath.localeCompare(b.targetSubpath));
}

// Pass 2 (v1.9.11 FP-38): workspace packages without `exports`. Older
// pnpm / Bun / Turborepo workspaces use `main` + legacy subpath
// resolution. If we don't register a fallback, the resolver treats the
// entire package as EXTERNAL and every workspace-consumed symbol falls
// dead. Observed impact: 13/229 Tier C findings on duyet (2026-04) were
// this class.
//
// Only adds when the `exports` pass (above) did NOT already register a
// matching entry — an explicit `exports` map always wins.
function buildGeneratedVirtualSurfaces(root, pkgDir, pkgJson, generatedSubpathEvidence) {
  const surfaces = [];
  for (const packet of generatedSubpathEvidence ?? []) {
    const surface = buildPrismaEnumVirtualSurface({
      root,
      pkgDir,
      pkgName: pkgJson.name,
      targetSubpath: packet.targetSubpath,
      generatedArtifact: {
        ...packet,
        matchedPackage: pkgJson.name,
      },
    });
    if (surface) surfaces.push(surface);
  }
  return surfaces.sort((a, b) => a.id.localeCompare(b.id));
}

function addLegacySubpathFallback(map, root, pkgDir, pkgJson) {
  const hasExplicitBare = map.has(pkgJson.name);
  if (!hasExplicitBare && typeof pkgJson.main === 'string') {
    const mainResolved = mapOutputToSource(pkgDir, pkgJson.main);
    const generatedArtifact = generatedOutputArtifactEvidence(pkgJson, pkgJson.main, 'main', {
      outputArtifactDirs: OUTPUT_ARTIFACT_DIRS,
    });
    map.set(pkgJson.name, {
      type: 'exact',
      source: 'legacy-main',
      path: mainResolved,
      ...(generatedArtifact ? { generatedArtifact } : {}),
    });
  }

  // Legacy subpath wildcard. Check for existing wildcard OR exact entry
  // with matching package-name prefix.
  const hasSubpathCoverage =
    [...map.keys()].some((k) => k.startsWith(pkgJson.name + '/')) ||
    [...map.values()].some((v) =>
      v && typeof v === 'object' &&
      v.matchPrefix && v.matchPrefix.startsWith(pkgJson.name + '/'));
  if (hasSubpathCoverage) return;

  const uniqueKey = `${pkgJson.name}/__LEGACY_SUBPATH__`;
  const generatedSubpathEvidence = inferGeneratedSubpathEvidence(pkgJson, pkgDir);
  const generatedVirtualSurfaces = buildGeneratedVirtualSurfaces(
    root,
    pkgDir,
    pkgJson,
    generatedSubpathEvidence,
  );
  map.set(uniqueKey, {
    type: 'wildcard',
    source: 'legacy-subpath',
    pkgDir,
    pkgName: pkgJson.name,
    matchPrefix: pkgJson.name + '/',
    matchSuffix: '',
    // '*' means "take the subpath verbatim and probe from pkgDir".
    // mapOutputToSource isn't needed here — we point at source files
    // directly, not compiled output.
    targetPattern: './*',
    legacySubpath: true,
    ...(generatedSubpathEvidence.length
      ? {
          generatedSubpathHints: generatedSubpathEvidence.map((p) => p.targetSubpath),
          generatedSubpathEvidence,
        }
      : {}),
    ...(generatedVirtualSurfaces.length ? { generatedVirtualSurfaces } : {}),
  });
}

// TypeScript declaration-output subpaths. Some workspace packages import
// their generated declaration tree from sibling packages, but a source
// checkout may only contain the source files. If tsconfig says
// `declarationDir: "types/server"` and the current source set lives under
// `server/`, map `<pkg>/types/server/*` back to `<pkg>/server/*`.
function addDeclarationDirFallback(map, pkgDir, pkgJson, declarationDirs = []) {
  const pkgResolved = path.resolve(pkgDir);
  for (const entry of declarationDirs) {
    const configDir = path.resolve(path.dirname(entry.configPath));
    if (configDir !== pkgResolved) continue;
    if (!entry.declarationDir || !entry.sourceDir) continue;

    const declarationRel = path.relative(pkgResolved, path.resolve(entry.declarationDir)).replace(/\\/g, '/');
    const sourceRel = path.relative(pkgResolved, path.resolve(entry.sourceDir)).replace(/\\/g, '/');
    if (!declarationRel || !sourceRel || declarationRel.startsWith('..') || sourceRel.startsWith('..')) continue;
    if (path.isAbsolute(declarationRel) || path.isAbsolute(sourceRel)) continue;

    const uniqueKey = `${pkgJson.name}/${declarationRel}/__DECLARATION_DIR__`;
    map.set(uniqueKey, {
      type: 'wildcard',
      source: 'tsconfig-declarationDir',
      pkgDir,
      pkgName: pkgJson.name,
      matchPrefix: `${pkgJson.name}/${declarationRel.replace(/\/$/, '')}/`,
      matchSuffix: '',
      targetPattern: `./${sourceRel.replace(/\/$/, '')}/*`,
      declarationDirSubpath: true,
    });
  }
}

// Pass 3 (FP-03): Node.js `#imports` subpath support. Covers both exact
// form (`"#foo": "./dist/foo.mjs"`) and hash-wildcard form
// (`"#foo/*": "./dist/foo/*.mjs"`). Share the same out-dir + extension
// logic as `exports` via `mapOutputToSource` / `mapOutputPatternToSource`
// (v1.10.1 consolidation).
function addHashImports(map, pkgDir, pkgJson) {
  const imports = pkgJson.imports ?? {};
  for (const [key, target] of Object.entries(imports)) {
    const t = extractStringTarget(target);
    if (!t || typeof t !== 'string') continue;
    if (key.includes('*')) {
      // Wildcard form can't FS-probe (the `*` isn't a file) — use
      // mapOutputPatternToSource. Covers `.mjs` / `.cjs` / `.jsx` and
      // the wider set of source-dir conventions (src/ source/ lib/
      // build/ out/ es/ esm/) via OUT_SRC_PAIRS.
      const starIdx = key.indexOf('*');
      const keyPrefix = key.slice(0, starIdx);
      const keySuffix = key.slice(starIdx + 1);
      const targetPatterns = mapOutputPatternToSourceCandidates(t);
      map.set(`${key}__HASHWILDCARD__`, {
        type: 'hash-wildcard',
        source: 'imports',
        pkgDir,
        keyPrefix,
        keySuffix,
        targetPattern: mapOutputPatternToSource(t),
        targetPatterns,
      });
    } else {
      // Exact form can FS-probe through mapOutputToSource — returns an
      // absolute path to the first existing candidate (or to the literal
      // target if none exist).
      map.set(key, { type: 'exact', source: 'imports', path: mapOutputToSource(pkgDir, t) });
    }
  }
}

export function buildAliasMap(root, repoMode) {
  const map = new Map();
  const packages = listPackageDirs(root, repoMode);
  const tsconfigResolution = discoverScopedTsconfigResolution(root);

  for (const pkgDir of packages) {
    // readJsonFile returns null on missing OR malformed — either way we
    // skip this workspace rather than aborting alias map build for the
    // others (E1 regression protection: a truncated / BOM-mangled /
    // comment-containing pkg.json in one workspace used to cascade into
    // Tier C over-claims across every sibling).
    const pkgJson = readJsonFile(path.join(pkgDir, 'package.json'));
    if (!pkgJson || !pkgJson.name) continue;

    // Pass order matters: legacy-subpath fallback checks for entries the
    // exports pass added; hash-imports uses an independent key namespace
    // so its order is flexible.
    addExportsEntries(map, pkgDir, pkgJson);
    addLegacySubpathFallback(map, root, pkgDir, pkgJson);
    // Add after the broad legacy wildcard. Resolver wildcard lookup prefers
    // the longest matchPrefix, so declarationDir-specific mappings win for
    // `pkg/types/...` without suppressing ordinary `pkg/server/...` subpaths.
    addDeclarationDirFallback(map, pkgDir, pkgJson, tsconfigResolution.declarationDirs);
    addHashImports(map, pkgDir, pkgJson);
  }

  // v1.9.7 FP-36: discover per-scope tsconfig `compilerOptions.paths`.
  // Attached as a property on the Map to preserve backward compat with
  // callers that iterate the Map as `for (const [k, v] of aliasMap)`.
  // Resolver-core reads `.scopedTsconfigPaths` and applies
  // nearest-scope-first for non-relative specifiers.
  map.scopedTsconfigPaths = tsconfigResolution.paths;
  map.scopedTsconfigBaseUrls = tsconfigResolution.baseUrls;
  map.scopedTsconfigDeclarationDirs = tsconfigResolution.declarationDirs;

  return map;
}
