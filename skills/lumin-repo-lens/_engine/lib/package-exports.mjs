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

function flattenExportLeaves(value, out = [], keyPath = []) {
  if (typeof value === 'string') {
    out.push({
      value,
      wildcard: value.includes('*') || keyPath.some((key) => key.includes('*')),
    });
  } else if (Array.isArray(value)) {
    for (const item of value) flattenExportLeaves(item, out, keyPath);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      flattenExportLeaves(item, out, [...keyPath, key]);
    }
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

export function getPublicDeepImportRisk(pkgJson, relFileFromPkgRoot) {
  const rel = normalizeRel(relFileFromPkgRoot);
  const base = { risk: false, relFileFromPkgRoot: rel };

  if (!pkgJson) {
    return { ...base, reason: 'package-json-absent' };
  }
  if (pkgJson.private === true) {
    return { ...base, reason: 'private-package' };
  }

  const packageName = typeof pkgJson.name === 'string' ? pkgJson.name.trim() : '';
  if (!packageName) {
    return { ...base, reason: 'package-name-absent' };
  }

  if (!pkgJson.exports) {
    return {
      ...base,
      risk: true,
      reason: 'exports-absent-publishable-package',
      packageName,
    };
  }

  const leaves = flattenExportLeaves(pkgJson.exports);
  const match = leaves.find((leaf) => patternMatchesRel(leaf.value, rel));
  if (match) {
    return {
      ...base,
      risk: true,
      reason: match.wildcard ? 'wildcard-exposes-file' : 'explicitly-exposed-file',
      packageName,
      matchedExport: match.value,
    };
  }

  return {
    ...base,
    reason: exportsMapHasWildcard(pkgJson.exports)
      ? 'exports-map-wildcard-does-not-expose-file'
      : 'exports-map-does-not-expose-file',
    packageName,
  };
}

export function hasPublicDeepImportRisk(pkgJson, relFileFromPkgRoot) {
  return getPublicDeepImportRisk(pkgJson, relFileFromPkgRoot).risk;
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
