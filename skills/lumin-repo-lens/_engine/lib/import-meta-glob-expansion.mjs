import path from 'node:path';

import { JS_FAMILY_LANGS } from './lang.mjs';

export const DEFAULT_IMPORT_META_GLOB_CAP = 64;

const SOURCE_EXTENSIONS = new Set(JS_FAMILY_LANGS.map((lang) => `.${lang.toLowerCase()}`));

function slash(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function isInsideOrSame(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function unsupported(reason, extra = {}) {
  return {
    ok: false,
    reason,
    outputLevel: 'unsupported',
    unsupportedFamily: 'dynamic-modules',
    resolverStage: 'import-meta-glob',
    scanPolicy: 'scanned-source-files',
    ...extra,
  };
}

function isSourceSuffix(suffix) {
  const lower = suffix.toLowerCase();
  if (/\.(?:d\.)[cm]?ts$/i.test(lower)) return false;
  for (const ext of SOURCE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function validateGlobPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return unsupported('import-meta-glob-nonliteral-unsupported');
  }
  if (pattern === 'import.meta.glob(<nonliteral>)') {
    return unsupported('import-meta-glob-nonliteral-unsupported');
  }

  const normalized = slash(pattern);
  if (!normalized.startsWith('./') && !normalized.startsWith('../')) {
    return unsupported('import-meta-glob-nonrelative-unsupported');
  }
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    return unsupported('import-meta-glob-absolute-unsupported');
  }
  if (/[?[\]{}]/.test(normalized)) {
    return unsupported('import-meta-glob-unsupported-pattern');
  }

  const starCount = (normalized.match(/\*/g) ?? []).length;
  if (starCount !== 1) {
    return unsupported('import-meta-glob-unsupported-pattern');
  }

  const segments = normalized.split('/');
  const starIndex = segments.findIndex((segment) => segment.includes('*'));
  const starSegment = segments[starIndex];
  if (starIndex < 0 || !starSegment || starSegment.includes('**')) {
    return unsupported('import-meta-glob-unsupported-pattern');
  }

  const [prefix, suffix] = starSegment.split('*');
  if (!isSourceSuffix(suffix)) {
    return unsupported('import-meta-glob-target-extension-unsupported');
  }

  return {
    ok: true,
    normalized,
    segments,
    starIndex,
    prefix,
    suffix,
  };
}

export function expandImportMetaGlobPattern({
  root,
  consumerFile,
  pattern,
  scannedSourceFileSet,
  cap = DEFAULT_IMPORT_META_GLOB_CAP,
}) {
  const parsed = validateGlobPattern(pattern);
  if (!parsed.ok) return parsed;

  const rootAbs = path.resolve(root);
  const consumerDir = path.dirname(path.resolve(consumerFile));
  const basePattern = parsed.segments.slice(0, parsed.starIndex).join('/') || '.';
  const baseDir = path.resolve(consumerDir, ...basePattern.split('/'));

  if (!isInsideOrSame(rootAbs, baseDir)) {
    return unsupported('import-meta-glob-outside-root-unsupported');
  }

  const scannedFiles =
    scannedSourceFileSet instanceof Set
      ? [...scannedSourceFileSet]
      : Array.isArray(scannedSourceFileSet)
        ? scannedSourceFileSet
        : [];
  const matches = [];

  for (const file of scannedFiles) {
    const absFile = path.resolve(file);
    if (path.dirname(absFile) !== baseDir) continue;
    const basename = path.basename(absFile);
    if (!basename.startsWith(parsed.prefix) || !basename.endsWith(parsed.suffix)) {
      continue;
    }
    if (!isInsideOrSame(rootAbs, absFile)) continue;
    matches.push(absFile);
  }

  matches.sort((a, b) => slash(path.relative(rootAbs, a)).localeCompare(slash(path.relative(rootAbs, b))));

  if (matches.length === 0) {
    return unsupported('import-meta-glob-zero-matches', {
      matchCount: 0,
      affectedPackageScope: slash(path.relative(rootAbs, baseDir)),
    });
  }
  if (matches.length > cap) {
    return unsupported('import-meta-glob-match-cap-exceeded', {
      matchCount: matches.length,
      cap,
      affectedPackageScope: slash(path.relative(rootAbs, baseDir)),
    });
  }

  return {
    ok: true,
    targets: matches,
    matchCount: matches.length,
    cap,
    scanPolicy: 'scanned-source-files',
  };
}
