import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

function normalizeSlashes(value) {
  return value.split(path.sep).join('/');
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function ancestorsFrom(start) {
  const out = [];
  let current = path.resolve(start);
  for (;;) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function readPackageJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function hasWorkspacePackageJson(dir) {
  const pkg = readPackageJson(path.join(dir, 'package.json'));
  return pkg?.workspaces !== undefined;
}

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  const start = path.resolve(cwd);
  try {
    const stdout = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: start,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (stdout && existsSync(stdout) && statSync(stdout).isDirectory()) return path.resolve(stdout);
  } catch {
    // Fall back to marker walk below.
  }

  const ancestors = ancestorsFrom(start);
  for (const dir of ancestors) {
    const gitMarker = path.join(dir, '.git');
    if (existsSync(gitMarker)) return dir;
  }
  for (const dir of ancestors) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (hasWorkspacePackageJson(dir)) return dir;
  }
  return resolvePackageRoot(start);
}

export function resolvePackageRoot(cwd = process.cwd()) {
  for (const dir of ancestorsFrom(cwd)) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return null;
}

export function resolveAuditRoot(cwd = process.cwd()) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  return workspaceRoot ? path.join(workspaceRoot, '.audit') : null;
}

export function getToolTargetPath(toolName, toolInput) {
  if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) return null;
  const filePath = toolInput?.file_path;
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : null;
}

export function safeRepoPathSyntactic(repoRel) {
  if (typeof repoRel !== 'string' || repoRel.length === 0) {
    return { ok: false, reason: 'invalid-path' };
  }
  if (repoRel.includes('\\')) return { ok: false, reason: 'backslash-path' };
  if (path.isAbsolute(repoRel)) return { ok: false, reason: 'absolute-path' };
  const normalized = path.posix.normalize(repoRel);
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    return { ok: false, reason: 'outside-repo' };
  }
  return { ok: true, repoRel: normalized };
}

export function safeRepoPathForToolInput(cwd, filePath, opts = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, reason: 'invalid-path' };
  }
  const repoRoot = resolveWorkspaceRoot(cwd);
  if (!repoRoot) return { ok: false, reason: 'repo-root-not-found' };

  const absolute = path.resolve(cwd, filePath);
  if (!isInside(repoRoot, absolute)) {
    return { ok: false, reason: 'outside-repo', repoRoot, absolute };
  }

  const ext = path.extname(absolute);
  const allowedExts = opts.allowedExtensions ?? SOURCE_EXTENSIONS;
  if (!allowedExts.has(ext)) {
    return { ok: false, reason: 'unsupported-extension', repoRoot, absolute, ext };
  }

  const repoRel = normalizeSlashes(path.relative(repoRoot, absolute));
  const syntax = safeRepoPathSyntactic(repoRel);
  if (!syntax.ok) return { ...syntax, repoRoot, absolute };

  let exists = false;
  let sizeBytes = null;
  let kind = 'missing';
  try {
    const stat = statSync(absolute);
    exists = true;
    sizeBytes = stat.size;
    kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  } catch {
    // Missing files are valid for Write hooks as long as the path is safe.
  }

  return {
    ok: true,
    repoRoot,
    absolute,
    repoRel,
    ext,
    exists,
    sizeBytes,
    kind,
  };
}

export function safeRepoRelForRead(repoRoot, repoRel) {
  const syntax = safeRepoPathSyntactic(repoRel);
  if (!syntax.ok) return syntax;
  const absolute = path.resolve(repoRoot, syntax.repoRel);
  if (!isInside(path.resolve(repoRoot), absolute)) {
    return { ok: false, reason: 'outside-repo' };
  }
  try {
    const stat = statSync(absolute);
    return {
      ok: true,
      absolute,
      exists: true,
      sizeBytes: stat.size,
      kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    };
  } catch {
    return { ok: true, absolute, exists: false };
  }
}
