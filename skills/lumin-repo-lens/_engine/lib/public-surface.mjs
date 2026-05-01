// Package/public surface collector for dead-export policy.
//
// The resolver alias map intentionally picks one executable target for a
// specifier. Public API protection needs a wider lens: every package.json
// target that external consumers can name is evidence, including `types`
// conditions and top-level declaration fields.

import path from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { readJsonFile } from './artifacts.mjs';
import {
  listPackageDirs,
  mapOutputPatternToSourceCandidates,
  mapOutputToSource,
} from './alias-map.mjs';
import { collectFiles } from './collect-files.mjs';
import { parseOxcOrThrow } from './parse-oxc.mjs';

function normalizeExportsToEntries(rawExports) {
  if (typeof rawExports === 'string') return [['.', rawExports]];
  if (rawExports && typeof rawExports === 'object' && !Array.isArray(rawExports)) {
    const keys = Object.keys(rawExports);
    const isSubpathMap = keys.some((k) => k === '.' || k.startsWith('./'));
    return isSubpathMap ? Object.entries(rawExports) : [['.', rawExports]];
  }
  return [];
}

function collectStringTargets(value, pathBits = [], out = []) {
  if (value == null || value === false) return out;
  if (typeof value === 'string') {
    out.push({ target: value, conditionPath: pathBits.join('.') || null });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectStringTargets(item, [...pathBits, String(i)], out));
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectStringTargets(item, [...pathBits, key], out);
    }
  }
  return out;
}

function isRelativeFileTarget(target) {
  return typeof target === 'string' &&
    target.startsWith('./') &&
    !target.includes('*');
}

function isRelativeWildcardTarget(target) {
  return typeof target === 'string' &&
    target.startsWith('./') &&
    target.includes('*');
}

function normalizeRel(root, abs) {
  return path.relative(root, abs).replace(/\\/g, '/');
}

function addEntry(entries, root, pkgDir, target, evidence) {
  if (!isRelativeFileTarget(target)) return;
  const abs = mapOutputToSource(pkgDir, target);
  entries.push({
    file: normalizeRel(root, abs),
    evidence: {
      ...evidence,
      target,
      resolvedFile: normalizeRel(root, abs),
      packageDir: normalizeRel(root, pkgDir) || '.',
    },
  });
}

function addWildcardEntries(entries, root, pkgDir, target, evidence) {
  if (!isRelativeWildcardTarget(target)) return;
  const sourcePatterns = mapOutputPatternToSourceCandidates(target)
    .map((candidate) => candidate.replace(/\\/g, '/'));

  const files = collectFiles(pkgDir, { includeTests: true });
  const seen = new Set();
  for (const sourcePattern of sourcePatterns) {
    const starIdx = sourcePattern.indexOf('*');
    if (starIdx < 0) continue;
    const prefix = sourcePattern.slice(0, starIdx);
    const suffix = sourcePattern.slice(starIdx + 1);

    for (const abs of files) {
      const relToPkg = normalizeRel(pkgDir, abs);
      if (!relToPkg.startsWith(prefix)) continue;
      if (suffix && !relToPkg.endsWith(suffix)) continue;
      const matched = relToPkg.slice(prefix.length, suffix ? -suffix.length : undefined);
      if (!matched) continue;
      const entryKey = `${relToPkg}\0${sourcePattern}`;
      if (seen.has(entryKey)) continue;
      seen.add(entryKey);
      entries.push({
        file: normalizeRel(root, abs),
        evidence: {
          ...evidence,
          target,
          sourcePattern,
          resolvedFile: normalizeRel(root, abs),
          packageDir: normalizeRel(root, pkgDir) || '.',
          wildcard: true,
        },
      });
    }
  }
}

function collectFieldTargets(pkg, field) {
  if (!(field in pkg)) return [];
  return collectStringTargets(pkg[field]).map((t) => ({
    ...t,
    field,
  }));
}

function tokenizeCommand(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && i + 1 < command.length) current += command[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      tokens.push(ch + ch);
      i++;
      continue;
    }
    if (ch === ';') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      tokens.push(ch);
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function isTsupToken(token) {
  const normalized = token.replace(/\\/g, '/');
  return normalized === 'tsup' ||
    normalized.endsWith('/tsup') ||
    normalized.endsWith('/tsup.cmd') ||
    normalized.endsWith('/tsup.ps1');
}

function isRollupToken(token) {
  const normalized = token.replace(/\\/g, '/');
  return normalized === 'rollup' ||
    normalized.endsWith('/rollup') ||
    normalized.endsWith('/rollup.cmd') ||
    normalized.endsWith('/rollup.ps1');
}

function isEsbuildToken(token) {
  const normalized = token.replace(/\\/g, '/');
  return normalized === 'esbuild' ||
    normalized.endsWith('/esbuild') ||
    normalized.endsWith('/esbuild.cmd') ||
    normalized.endsWith('/esbuild.ps1');
}

function isSourceEntrypointToken(token) {
  return /^\.{0,2}\//.test(token) || /^[A-Za-z0-9_@][^:]*\.(?:[cm]?[jt]sx?)$/i.test(token);
}

function hasSourceEntrypointExtension(token) {
  return /\.(?:[cm]?[jt]sx?)$/i.test(token);
}

function isCommandSeparator(token) {
  return token === '&&' || token === '||' || token === ';';
}

function normalizeScriptTarget(token) {
  return token.replace(/^\.\//, '');
}

function extractTsupEntrypoints(command) {
  const tokens = tokenizeCommand(command);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isTsupToken(tokens[i])) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (isCommandSeparator(t)) break;
      if (t.startsWith('-')) continue;
      if (!hasSourceEntrypointExtension(t)) continue;
      if (isSourceEntrypointToken(t)) out.push(normalizeScriptTarget(t));
    }
  }
  return out;
}

function collectRootDynamicInputEntrypoints(pkgDir) {
  const out = [];
  let entries;
  try { entries = readdirSync(pkgDir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!hasSourceEntrypointExtension(entry.name)) continue;
    if (/\.d\.[cm]?ts$/i.test(entry.name)) continue;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(entry.name)) continue;
    if (/^(rollup|vite|webpack|tsup|eslint|prettier|jest|vitest|tailwind|postcss)\.config\./i.test(entry.name)) continue;
    out.push(entry.name);
  }
  return out.sort();
}

function extractRollupEntrypoints(command, pkgDir) {
  const tokens = tokenizeCommand(command);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isRollupToken(tokens[i])) continue;
    let foundInputFlag = false;
    let foundExplicitInput = false;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (isCommandSeparator(t)) break;
      if (t === '--input' || t === '-i') {
        foundInputFlag = true;
        const next = tokens[j + 1];
        if (next && !isCommandSeparator(next) && !next.startsWith('-') &&
            hasSourceEntrypointExtension(next) && isSourceEntrypointToken(next)) {
          out.push({ target: normalizeScriptTarget(next), tool: 'rollup' });
          foundExplicitInput = true;
          j++;
        }
        continue;
      }
      const longInput = t.match(/^--input=(.+)$/);
      if (longInput) {
        foundInputFlag = true;
        const target = longInput[1];
        if (hasSourceEntrypointExtension(target) && isSourceEntrypointToken(target)) {
          out.push({ target: normalizeScriptTarget(target), tool: 'rollup' });
          foundExplicitInput = true;
        }
      }
    }
    if (foundInputFlag && !foundExplicitInput) {
      for (const target of collectRootDynamicInputEntrypoints(pkgDir)) {
        out.push({ target, tool: 'rollup', dynamicInput: true });
      }
    }
  }
  return out;
}

function extractEsbuildEntrypoints(command) {
  const tokens = tokenizeCommand(command);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isEsbuildToken(tokens[i])) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (isCommandSeparator(t)) break;
      if (t.startsWith('-')) continue;
      if (!hasSourceEntrypointExtension(t)) continue;
      if (isSourceEntrypointToken(t)) {
        out.push({ target: normalizeScriptTarget(t), tool: 'esbuild' });
      }
    }
  }
  return out;
}

function extractScriptEntrypoints(command, pkgDir) {
  return [
    ...extractTsupEntrypoints(command).map((target) => ({ target, tool: 'tsup' })),
    ...extractRollupEntrypoints(command, pkgDir),
    ...extractEsbuildEntrypoints(command),
  ];
}

function collectStringLiteralsFromFile(filePath) {
  let src;
  try { src = readFileSync(filePath, 'utf8'); } catch { return []; }
  let ast;
  try { ast = parseOxcOrThrow(filePath, src); } catch { return []; }
  const out = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if ((node.type === 'Literal' || node.type === 'StringLiteral') &&
        typeof node.value === 'string') {
      out.push(node.value);
      return;
    }
    if (node.type === 'TemplateLiteral' &&
        Array.isArray(node.expressions) &&
        node.expressions.length === 0 &&
        node.quasis?.[0]?.value?.cooked) {
      out.push(node.quasis[0].value.cooked);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else if (value && typeof value === 'object') {
        visit(value);
      }
    }
  }
  visit(ast.program);
  return out;
}

function collectHtmlFiles(pkgDir, repoMode, root) {
  const out = [];
  const workspaceRoots = new Set((repoMode.workspaceDirs || [])
    .map((wd) => path.resolve(wd)));
  const pkgResolved = path.resolve(pkgDir);
  const rootResolved = path.resolve(root);
  const prune = new Set([
    'node_modules', '.git', 'coverage', 'dist', 'build',
    '.next', '.svelte-kit', '.astro', '.turbo', '.cache', '.nuxt', '.output',
  ]);

  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const resolved = path.resolve(full);
        if (prune.has(entry.name)) continue;
        if (pkgResolved === rootResolved && workspaceRoots.has(resolved)) continue;
        walk(full);
      } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
        out.push(full);
      }
    }
  }
  if (existsSync(pkgDir)) walk(pkgDir);
  return out.sort();
}

function extractHtmlModuleScriptTargets(html) {
  const out = [];
  const scriptRe = /<script\b[^>]*>/gi;
  let match;
  while ((match = scriptRe.exec(html))) {
    const tag = match[0];
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (src) out.push(src);
  }
  return out;
}

function normalizeHtmlScriptTarget(pkgDir, htmlFile, src) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return null;
  const clean = src.split(/[?#]/, 1)[0];
  if (!/\.(?:[cm]?[jt]sx?)$/i.test(clean)) return null;
  if (clean.startsWith('/')) return `./${clean.slice(1)}`;
  if (clean.startsWith('./') || clean.startsWith('../')) {
    const abs = path.resolve(path.dirname(htmlFile), clean);
    const rel = path.relative(pkgDir, abs).replace(/\\/g, '/');
    if (rel.startsWith('../')) return null;
    return `./${rel}`;
  }
  return null;
}

export function collectPackagePublicSurfaceFiles({ root, repoMode }) {
  const entries = [];

  for (const pkgDir of listPackageDirs(root, repoMode)) {
    const pkg = readJsonFile(path.join(pkgDir, 'package.json'));
    if (!pkg || !pkg.name) continue;

    for (const [subpath, rawTarget] of normalizeExportsToEntries(pkg.exports)) {
      for (const t of collectStringTargets(rawTarget)) {
        const evidence = {
          source: 'package.exports',
          packageName: pkg.name,
          subpath,
          conditionPath: t.conditionPath,
        };
        addEntry(entries, root, pkgDir, t.target, evidence);
        addWildcardEntries(entries, root, pkgDir, t.target, evidence);
      }
    }

    for (const field of ['main', 'module', 'browser', 'types', 'typings', 'bin']) {
      for (const t of collectFieldTargets(pkg, field)) {
        addEntry(entries, root, pkgDir, t.target, {
          source: `package.${field}`,
          packageName: pkg.name,
          conditionPath: t.conditionPath,
        });
      }
    }
  }

  return entries;
}

export function collectHtmlModuleEntrypointFiles({ root, repoMode }) {
  const entries = [];

  for (const pkgDir of listPackageDirs(root, repoMode)) {
    const pkg = readJsonFile(path.join(pkgDir, 'package.json'));
    if (!pkg || !pkg.name) continue;
    for (const htmlFile of collectHtmlFiles(pkgDir, repoMode, root)) {
      let html;
      try { html = readFileSync(htmlFile, 'utf8'); } catch { continue; }
      for (const src of extractHtmlModuleScriptTargets(html)) {
        const target = normalizeHtmlScriptTarget(pkgDir, htmlFile, src);
        if (!target) continue;
        addEntry(entries, root, pkgDir, target, {
          source: 'html-module-script',
          packageName: pkg.name,
          htmlFile: normalizeRel(root, htmlFile),
        });
      }
    }
  }

  return entries;
}

export function collectScriptEntrypointFiles({ root, repoMode }) {
  const entries = [];

  for (const pkgDir of listPackageDirs(root, repoMode)) {
    const pkg = readJsonFile(path.join(pkgDir, 'package.json'));
    if (!pkg || !pkg.name) continue;
    const commandSources = [];

    for (const [scriptName, command] of Object.entries(pkg.scripts ?? {})) {
      if (typeof command === 'string') {
        commandSources.push({
          command,
          evidence: {
            source: 'package.scripts',
            packageName: pkg.name,
            scriptName,
          },
        });
      }
    }

    const scriptFiles = collectFiles(pkgDir, {
      includeTests: true,
      languages: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'],
    }).filter((filePath) =>
      path.relative(pkgDir, filePath).replace(/\\/g, '/').startsWith('scripts/'));

    for (const filePath of scriptFiles) {
      const rel = normalizeRel(root, filePath);
      for (const command of collectStringLiteralsFromFile(filePath)) {
        commandSources.push({
          command,
          evidence: {
            source: 'script-string-literal',
            packageName: pkg.name,
            scriptFile: rel,
          },
        });
      }
    }

    for (const source of commandSources) {
      for (const entry of extractScriptEntrypoints(source.command, pkgDir)) {
        const { target } = entry;
        const relativeTarget = target.startsWith('./') ? target : `./${target}`;
        addEntry(entries, root, pkgDir, relativeTarget, {
          ...source.evidence,
          tool: entry.tool,
          ...(entry.dynamicInput ? { dynamicInput: true } : {}),
        });
      }
    }
  }

  return entries;
}

export function indexPublicSurfaceEntries(entries) {
  const byFile = new Map();
  for (const entry of entries) {
    if (!byFile.has(entry.file)) byFile.set(entry.file, []);
    byFile.get(entry.file).push(entry.evidence);
  }
  return byFile;
}
