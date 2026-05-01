// Small path utilities shared across audit scripts.

import { statSync } from 'node:fs';

// Relative path from a root directory to an absolute path. Normalizes both
// sides to forward slashes so Windows paths (with backslashes) match
// correctly. Returns a forward-slash path even on Windows — artifacts are
// more portable that way, and SARIF URIs require forward slashes.
export function relPath(root, abs) {
  if (!abs) return abs;
  const absN = abs.replace(/\\/g, '/');
  const rootN = root.replace(/\\/g, '/');
  const prefix = rootN.endsWith('/') ? rootN : rootN + '/';
  return absN.startsWith(prefix) ? absN.slice(prefix.length) : absN;
}

// v1.8.2 hardening: filesystem existence probes. These wrap statSync with
// the expected "doesn't exist → false" semantic that replaces a cluster of
// inline `try { statSync(...).isFile() } catch {}` sites in resolver-core
// and elsewhere. Keeping them in one place:
//   (1) makes the intent readable — we're probing, not asserting;
//   (2) narrows the scope of the silent catch — the helper is short
//       enough to audit at a glance; consumers can use a real boolean;
//   (3) lets us one day add observability (log ENOENT vs EACCES
//       separately) without touching dozens of call sites.
// Any exception from statSync (ENOENT, EACCES, EIO, broken symlink) is
// treated as "not usable" — correct for the resolver's pick-a-winner
// pattern. If you want to distinguish causes, statSync + a typed handler
// is still the right tool; these helpers are the common-case shortcut.

export function fileExists(p) {
  try { return statSync(p).isFile(); }
  catch { return false; }
}

export function dirExists(p) {
  try { return statSync(p).isDirectory(); }
  catch { return false; }
}

// Same semantics as `existsSync` from node:fs but uses statSync so we
// don't import two different filesystem facades across the codebase.
// (Also avoids the small correctness bug in legacy existsSync for dangling
// symlinks — statSync throws, we catch, returning false consistently.)
export function pathExists(p) {
  try { statSync(p); return true; }
  catch { return false; }
}

// Submodule / package bucket classifier. Returns a closure so the
// workspace-prefix table is computed once per (root, repoMode) — not per
// file. Accepts either absolute or root-relative paths; normalizes both to
// forward slashes.
//
// Order of matching:
//   1. Longest workspace-dir prefix wins — `repoMode.workspaceDirs` lists
//      the actual package directories discovered from `pkgJson.workspaces`
//      or `pnpm-workspace.yaml`. Nested workspaces (e.g. a deep
//      `packages/ui/components` alongside `packages/`) resolve to the
//      deeper match.
//   2. Fallback heuristic for non-workspace layouts:
//        `src/<name>/...`            → `<name>`
//        `apps|packages/<name>/...`  → `<prefix>/<name>`
//        bare filenames              → `'root'`
//        else                        → first segment
//
// Consolidates three previously duplicated `submoduleOf` copies in
// build-symbol-graph / measure-topology / resolve-method-calls (which had
// only the heuristic) and the workspace-aware `pkgOf` in
// classify-dead-exports. Merging avoids dashboard mismatch where the same
// file appeared under different buckets across artifacts.
export function buildSubmoduleResolver(root, repoMode) {
  const rootN = String(root ?? '').replace(/\\/g, '/');
  const rootPrefix = rootN.endsWith('/') ? rootN : rootN + '/';

  const pkgPrefixes = (repoMode?.workspaceDirs ?? [])
    .map((abs) => {
      const absN = String(abs).replace(/\\/g, '/');
      return absN.startsWith(rootPrefix) ? absN.slice(rootPrefix.length) : '';
    })
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  return function submoduleOf(p) {
    const n = String(p ?? '').replace(/\\/g, '/');
    const rel = n.startsWith(rootPrefix) ? n.slice(rootPrefix.length) : n;

    for (const prefix of pkgPrefixes) {
      if (rel === prefix || rel.startsWith(prefix + '/')) return prefix;
    }

    const parts = rel.split('/');
    if (parts.length <= 1) return 'root';
    if (parts[0] === 'src' && parts.length > 2) return parts[1];
    if ((parts[0] === 'apps' || parts[0] === 'packages') && parts.length > 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return parts[0];
  };
}
