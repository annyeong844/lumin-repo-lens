// Repo mode detection — classifies a root directory as
// `monorepo` / `single-package` / `non-node`, and enumerates workspace
// directories for the monorepo case.
//
// Workspace patterns are additive across workspace manifests. A repo can expose
// a narrow `package.json#workspaces` list while a sibling manifest carries
// additional roots, so detection must collect every supported source instead of
// picking one owner.
// See CHANGELOG FP-26, FP-29.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { readJsonFile } from './artifacts.mjs';

// v0.6.5 FP-26 helper: parse pnpm-workspace.yaml (minimal — packages list only).
// We don't want a full YAML parser dependency; the file is almost always
// a simple "packages: - pattern" list in practice. Handles both the
// legacy `packages:` at top level and the modern schema.
function parsePnpmWorkspaceYaml(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const patterns = [];
  let inPackages = false;
  let packagesIndent = -1;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, ''); // strip comments
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      packagesIndent = indent;
      continue;
    }
    if (inPackages) {
      // Exit packages block if we hit another top-level key.
      if (indent <= packagesIndent && !line.trimStart().startsWith('- ')) {
        inPackages = false;
        continue;
      }
      const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/);
      if (m) {
        const p = m[1].trim();
        // v0.6.7 FP-29: keep negation patterns (`!foo/bar`); detectRepoMode
        // applies them as exclusions after include expansion.
        patterns.push(p);
      }
    }
  }
  return patterns;
}

function workspacePatternsFromPackageJson(pkgJson) {
  if (!pkgJson?.workspaces) return [];
  return Array.isArray(pkgJson.workspaces)
    ? pkgJson.workspaces
    : (pkgJson.workspaces.packages ?? []);
}

function workspacePatternsFromPnpmWorkspaceYaml(root) {
  const pnpmYamlPath = path.join(root, 'pnpm-workspace.yaml');
  if (!existsSync(pnpmYamlPath)) return [];
  try {
    const yaml = readFileSync(pnpmYamlPath, 'utf8');
    return parsePnpmWorkspaceYaml(yaml);
  } catch {
    // pnpm-workspace.yaml exists but couldn't be read or parsed. Ignore only
    // that source; other workspace manifests may still provide useful roots.
    return [];
  }
}

function collectWorkspacePatterns(root, pkgJson) {
  return [
    ...new Set([
      ...workspacePatternsFromPackageJson(pkgJson),
      ...workspacePatternsFromPnpmWorkspaceYaml(root),
    ]),
  ];
}

export function detectRepoMode(root) {
  const pkgJsonPath = path.join(root, 'package.json');
  // readJsonFile returns null on missing OR malformed — either path
  // takes us to the non-node branch (matching historical behavior when
  // `existsSync` was false, AND covering the previously-crashing case
  // of a root pkg.json with a BOM or trailing-comma parse error).
  const pkgJson = readJsonFile(pkgJsonPath);
  if (!pkgJson) {
    return {
      mode: 'non-node',
      language: existsSync(path.join(root, 'pyproject.toml')) || existsSync(path.join(root, 'setup.py'))
        ? 'python'
        : 'unknown',
      rootPkgName: null,
      hasExports: false,
      hasImports: false,
      workspaceDirs: [],
      rootPkgJson: null,
    };
  }

  const workspacePatterns = collectWorkspacePatterns(root, pkgJson);
  const hasWorkspaces = workspacePatterns.length > 0;

  // v0.6.7 FP-29: pnpm globs support `packages/**` (recursive) + negated
  // patterns (`!packages/nuxi`). Previous `.endsWith('/*')` branch missed
  // `/**` entirely — on nuxt, that hid all 10 packages/* entries (71%
  // unresolved imports).
  let workspaceDirs = [];
  if (hasWorkspaces) {
    const includes = [];
    const excludes = [];
    for (const raw of workspacePatterns) {
      if (raw.startsWith('!')) excludes.push(raw.slice(1));
      else includes.push(raw);
    }

    const collected = new Set();
    function walkForPkgs(dir) {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const sub = path.join(dir, e.name);
        if (existsSync(path.join(sub, 'package.json'))) collected.add(sub);
        walkForPkgs(sub);
      }
    }

    for (const pattern of includes) {
      if (pattern.endsWith('/**')) {
        const parent = path.join(root, pattern.slice(0, -3));
        if (existsSync(parent)) walkForPkgs(parent);
      } else if (pattern.endsWith('/*')) {
        const parent = path.join(root, pattern.slice(0, -2));
        if (existsSync(parent)) {
          for (const entry of readdirSync(parent, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              const wd = path.join(parent, entry.name);
              if (existsSync(path.join(wd, 'package.json'))) collected.add(wd);
            }
          }
        }
      } else {
        const wd = path.join(root, pattern);
        if (existsSync(wd)) collected.add(wd);
      }
    }

    const excludeAbs = excludes.map((p) => path.resolve(root, p));
    workspaceDirs = [...collected].filter((wd) => {
      const resolved = path.resolve(wd);
      return !excludeAbs.some((ex) => resolved === ex || resolved.startsWith(ex + path.sep));
    });
  }

  return {
    mode: hasWorkspaces ? 'monorepo' : 'single-package',
    language: 'typescript',
    rootPkgName: pkgJson.name,
    hasExports: !!pkgJson.exports,
    hasImports: !!pkgJson.imports,
    workspaceDirs,
    rootPkgJson: pkgJson,
  };
}
