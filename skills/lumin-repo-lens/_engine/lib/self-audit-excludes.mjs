import { existsSync } from 'node:fs';
import path from 'node:path';
import { readJsonFile } from './artifacts.mjs';

const MAINTAINER_SELF_AUDIT_EXCLUDES = Object.freeze([
  'p6-corpus',
  'output/corpus',
  'review-output',
  'audit-artifacts',
  '.audit',
  'test-harness',
  'skills/lumin-repo-lens/_engine',
  'skills/lumin-repo-lens/scripts',
  'node_modules',
]);

export function detectMaintainerSelfAuditExcludes(root) {
  const pkg = readJsonFile(path.join(root, 'package.json'));
  const isMaintainerCheckout =
    (
      pkg?.name === 'lumin-repo-lens-scripts' ||
      pkg?.name === 'lumin-audit-scripts' ||
      pkg?.name === 'grounded-audit-scripts'
    ) &&
    existsSync(path.join(root, 'audit-repo.mjs')) &&
    existsSync(path.join(root, '_lib'));
  if (!isMaintainerCheckout) return [];

  return MAINTAINER_SELF_AUDIT_EXCLUDES.filter((rel) =>
    existsSync(path.join(root, ...rel.split('/'))));
}

export function mergeExcludes(userExcludes = [], autoExcludes = []) {
  const seen = new Set();
  const out = [];
  for (const item of [...userExcludes, ...autoExcludes]) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
