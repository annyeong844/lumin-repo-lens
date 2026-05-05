// package.json exports helpers for public deep-import risk checks.
//
// PCEF reachability evidence can support confidence only when an apparently
// unreachable file is not externally observable through package deep imports.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readJsonFile } from './artifacts.mjs';

function normalizeRel(file) {
  return String(file ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function flattenStringLeaves(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) flattenStringLeaves(item, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) flattenStringLeaves(item, out);
  }
  return out;
}

function patternMatchesRel(pattern, relFileFromPkgRoot) {
  const patternRel = normalizeRel(pattern);
  const rel = normalizeRel(relFileFromPkgRoot);
  if (!patternRel.includes('*')) return patternRel === rel;
  const [prefix, ...rest] = patternRel.split('*');
  const suffix = rest.join('*');
  return rel.startsWith(prefix) && rel.endsWith(suffix);
}

function exportsMapHasWildcard(exportsValue) {
  if (typeof exportsValue === 'string') return exportsValue.includes('*');
  if (Array.isArray(exportsValue)) return exportsValue.some(exportsMapHasWildcard);
  if (exportsValue && typeof exportsValue === 'object') {
    return Object.entries(exportsValue).some(([key, value]) =>
      key.includes('*') || exportsMapHasWildcard(value));
  }
  return false;
}

export function hasPublicDeepImportRisk(pkgJson, relFileFromPkgRoot) {
  if (!pkgJson || pkgJson.private === true) return false;
  if (typeof pkgJson.name !== 'string' || pkgJson.name.trim() === '') return false;
  if (!pkgJson.exports) return true;

  const leaves = flattenStringLeaves(pkgJson.exports);
  if (leaves.some((leaf) => patternMatchesRel(leaf, relFileFromPkgRoot))) {
    return true;
  }

  return exportsMapHasWildcard(pkgJson.exports) &&
    leaves.some((leaf) => leaf.includes('*') && patternMatchesRel(leaf, relFileFromPkgRoot));
}

export function findNearestPackageInfo(root, relFile) {
  const absRoot = path.resolve(root);
  let dir = path.dirname(path.resolve(absRoot, relFile));
  while (dir.startsWith(absRoot)) {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkgJson = readJsonFile(pkgPath, { tag: 'package-exports' });
      return {
        packageRoot: dir,
        packageJson: pkgJson,
        relFileFromPkgRoot: normalizeRel(path.relative(dir, path.resolve(absRoot, relFile))),
      };
    }
    if (dir === absRoot) break;
    dir = path.dirname(dir);
  }
  return null;
}
