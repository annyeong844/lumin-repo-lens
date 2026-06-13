// Shared conservative scan-exclude matching.
//
// Exclude patterns are directory-segment or explicit file-path filters:
//   --exclude build       prunes a `build/` directory segment
//   --exclude src/a.ts    excludes that exact path suffix
//   --exclude skip-me.js  excludes files with that basename

import path from 'node:path';

export function normalizeExcludePattern(pattern) {
  return String(pattern ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\*\//, '')
    .replace(/\/\*$/, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

export function buildExcludeRules(exclude = []) {
  return exclude
    .map((p) => normalizeExcludePattern(p))
    .filter(Boolean)
    .map((pattern) => {
      const lastSegment = pattern.split('/').at(-1) ?? pattern;
      const fileLike = /\.[^/]+$/.test(lastSegment);
      return fileLike
        ? { kind: 'file', pattern }
        : { kind: 'directory', needle: '/' + pattern + '/' };
    });
}

function boundedRelativePath(root, full, { directory = false } = {}) {
  const rel = path.relative(root, full).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    const normalized = full.replace(/\\/g, '/').replace(/^\/+/, '');
    return '/' + normalized + (directory ? '/' : '');
  }
  return '/' + rel + (directory ? '/' : '');
}

export function isExcludedPath(root, full, excludeRules, { directory = false } = {}) {
  const normalized = boundedRelativePath(root, full, { directory });
  return excludeRules.some((rule) => {
    if (rule.kind === 'directory') return normalized.includes(rule.needle);
    if (directory) return false;
    return normalized.endsWith('/' + rule.pattern);
  });
}
