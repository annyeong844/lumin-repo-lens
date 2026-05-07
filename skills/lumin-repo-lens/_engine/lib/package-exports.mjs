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

function normalizePackageMetadataPath(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.includes('\\')) return null;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return null;
  if (raw.startsWith('/')) return null;

  const normalized = normalizeRel(raw);
  if (!normalized || normalized === '.') return null;
  if (normalized.split('/').some((part) => part === '..')) return null;
  return normalized;
}

function isRootReadme(rel) {
  return !rel.includes('/') && /^readme(?:\..+)?$/iu.test(rel);
}

function isRootLicense(rel) {
  return !rel.includes('/') && /^licen[cs]e(?:\..+)?$/iu.test(rel);
}

function pathIsExactOrUnder(base, rel) {
  return rel === base || rel.startsWith(`${base}/`);
}

function getNpmAlwaysIncludedMatch(pkgJson, relFileFromPkgRoot) {
  const rel = normalizeRel(relFileFromPkgRoot);

  if (rel === 'package.json') {
    return {
      matchedAlwaysIncludedRule: 'package-json',
      matchedPackageJsonField: 'package.json',
    };
  }
  if (isRootReadme(rel)) {
    return {
      matchedAlwaysIncludedRule: 'readme',
      matchedPackageJsonField: 'README',
    };
  }
  if (isRootLicense(rel)) {
    return {
      matchedAlwaysIncludedRule: 'license',
      matchedPackageJsonField: 'LICENSE',
    };
  }

  const main = normalizePackageMetadataPath(pkgJson?.main ?? 'index.js');
  if (main && rel === main) {
    return {
      matchedAlwaysIncludedRule: pkgJson?.main ? 'main' : 'default-main',
      matchedPackageJsonField: pkgJson?.main ? 'main' : 'main-default',
    };
  }

  const bin = pkgJson?.bin;
  const binValues = typeof bin === 'string'
    ? [bin]
    : bin && typeof bin === 'object' && !Array.isArray(bin)
      ? Object.values(bin)
      : [];
  for (const value of binValues) {
    const binPath = normalizePackageMetadataPath(value);
    if (binPath && rel === binPath) {
      return {
        matchedAlwaysIncludedRule: 'bin',
        matchedPackageJsonField: 'bin',
      };
    }
  }

  const directoriesBin = normalizePackageMetadataPath(pkgJson?.directories?.bin);
  if (directoriesBin && pathIsExactOrUnder(directoriesBin, rel)) {
    return {
      matchedAlwaysIncludedRule: 'directories.bin',
      matchedPackageJsonField: 'directories.bin',
    };
  }

  return null;
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

function escapeRegExp(text) {
  return String(text).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function filesGlobToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length;) {
    if (pattern.slice(i, i + 3) === '**/') {
      out += '(?:.*/)?';
      i += 3;
    } else if (pattern.slice(i, i + 2) === '**') {
      out += '.*';
      i += 2;
    } else if (pattern[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else {
      out += escapeRegExp(pattern[i]);
      i += 1;
    }
  }
  out += '$';
  return new RegExp(out, 'u');
}

function normalizeFilesEntry(entry) {
  return normalizePackageMetadataPath(entry);
}

function filesEntryMatchesRel(entry, relFileFromPkgRoot) {
  const entryRel = normalizeFilesEntry(entry);
  if (!entryRel) return { supported: false, matched: false };

  const rel = normalizeRel(relFileFromPkgRoot);
  if (entryRel.includes('*')) {
    return {
      supported: true,
      matched: filesGlobToRegExp(entryRel).test(rel),
      normalizedEntry: entryRel,
    };
  }

  const matched = entryRel.includes('.')
    ? rel === entryRel
    : pathIsExactOrUnder(entryRel, rel);
  return { supported: true, matched, normalizedEntry: entryRel };
}

function getFilesAllowlistMatch(filesValue, relFileFromPkgRoot) {
  if (!Array.isArray(filesValue)) {
    return { hasFilesField: true, unsupported: true, matchedEntry: null, checkedEntries: [] };
  }

  let unsupported = false;
  const checkedEntries = [];
  for (const entry of filesValue) {
    const result = filesEntryMatchesRel(entry, relFileFromPkgRoot);
    if (!result.supported) {
      unsupported = true;
      continue;
    }
    checkedEntries.push(result.normalizedEntry);
    if (result.matched) {
      return {
        hasFilesField: true,
        unsupported,
        matchedEntry: result.normalizedEntry,
        checkedEntries,
      };
    }
  }

  return {
    hasFilesField: true,
    unsupported,
    matchedEntry: null,
    checkedEntries,
  };
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
    const alwaysIncluded = getNpmAlwaysIncludedMatch(pkgJson, rel);
    if (alwaysIncluded) {
      return {
        ...base,
        risk: true,
        reason: 'exports-absent-file-published-always-included',
        packageName,
        publishSurfaceSource: 'npm-always-included',
        ...alwaysIncluded,
      };
    }

    if (Object.hasOwn(pkgJson, 'files')) {
      const filesMatch = getFilesAllowlistMatch(pkgJson.files, rel);
      if (filesMatch.matchedEntry) {
        return {
          ...base,
          risk: true,
          reason: 'exports-absent-file-published',
          packageName,
          publishSurfaceSource: 'package-json-files',
          matchedFilesEntry: filesMatch.matchedEntry,
          filesEntriesChecked: filesMatch.checkedEntries,
        };
      }
      if (filesMatch.unsupported) {
        return {
          ...base,
          risk: true,
          reason: 'exports-absent-files-unsupported',
          packageName,
          publishSurfaceSource: 'package-json-files',
          filesEntriesChecked: filesMatch.checkedEntries,
        };
      }
      return {
        ...base,
        reason: 'files-excludes-file',
        packageName,
        publishSurfaceSource: 'package-json-files',
        filesEntriesChecked: filesMatch.checkedEntries,
      };
    }

    return {
      ...base,
      risk: true,
      reason: 'exports-absent-publish-surface-unknown',
      packageName,
      publishSurfaceSource: 'implicit-npm-surface',
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
