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
import { collectFiles, scanScopeStatusForPath } from './collect-files.mjs';
import { fileExists } from './paths.mjs';
import { parseOxcOrThrow } from './parse-oxc.mjs';

const UNSUPPORTED_SCRIPT_ENTRYPOINT_SAMPLE_LIMIT = 50;
const NON_ENTRY_SCRIPT_TOOLS = new Set([
  'eslint',
  'prettier',
  'jest',
  'vitest',
  'tsc',
  'tsserver',
  'tailwindcss',
  'postcss',
]);

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
    target: normalizePackageFieldTarget(field, t),
    field,
  }));
}

function normalizePackageFieldTarget(field, targetInfo) {
  const target = targetInfo?.target;
  if (typeof target !== 'string') return target;
  if (target.startsWith('./') || target.startsWith('../')) return target;
  if (target.startsWith('/') || target.startsWith('#')) return target;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;

  // `browser` object values may be package specifier replacements. The
  // top-level string form is a package-relative file, like `main`.
  if (field === 'browser' && targetInfo.conditionPath) return target;

  return `./${target}`;
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

function commandName(token) {
  return String(token ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/\.(?:cmd|ps1|exe)$/i, '');
}

function runtimeScriptTool(token) {
  const name = commandName(token);
  if (name === 'node') return 'node';
  if (name === 'tsx') return 'tsx';
  if (name === 'ts-node' || name === 'ts-node-esm') return name;
  if (name === 'bun') return 'bun';
  return null;
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

function isCommandPosition(tokens, index) {
  return index === 0 || isCommandSeparator(tokens[index - 1]);
}

function isRuntimeModeToken(tool, token) {
  const normalized = String(token ?? '').toLowerCase();
  if (tool === 'tsx') return normalized === 'watch';
  if (tool === 'bun') return normalized === 'run';
  return false;
}

function packageScriptWrapper(tokens, index) {
  const tool = commandName(tokens[index]);
  if (tool === 'npm') {
    const subcommand = commandName(tokens[index + 1]);
    if (subcommand === 'run' || subcommand === 'run-script') {
      return { tool, targetScript: tokens[index + 2] ?? null };
    }
    if (['start', 'stop', 'restart', 'test'].includes(subcommand)) {
      return { tool, targetScript: subcommand };
    }
    return null;
  }
  if (tool === 'pnpm') {
    for (let i = index + 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (isCommandSeparator(token)) break;
      if (token === '--filter' || token === '-F') {
        i++;
        continue;
      }
      const subcommand = commandName(token);
      if (subcommand === 'run') return { tool, targetScript: tokens[i + 1] ?? null };
      if (!token.startsWith('-') && !token.includes('=')) return { tool, targetScript: token };
    }
    return null;
  }
  if (tool === 'yarn') {
    const subcommand = commandName(tokens[index + 1]);
    if (subcommand === 'run') return { tool, targetScript: tokens[index + 2] ?? null };
    if (subcommand) return { tool, targetScript: tokens[index + 1] ?? null };
  }
  return null;
}

function extractUnsupportedScriptEntrypoints(command) {
  const tokens = tokenizeCommand(command);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isCommandPosition(tokens, i)) continue;
    const wrapper = packageScriptWrapper(tokens, i);
    if (wrapper) {
      out.push({
        reason: 'package-script-recursion-unsupported',
        tool: wrapper.tool,
        targetScript: wrapper.targetScript,
      });
      continue;
    }

    const toolName = commandName(tokens[i]);
    if (
      runtimeScriptTool(tokens[i]) ||
      isTsupToken(tokens[i]) ||
      isRollupToken(tokens[i]) ||
      isEsbuildToken(tokens[i]) ||
      NON_ENTRY_SCRIPT_TOOLS.has(toolName)
    ) {
      continue;
    }

    const targetCandidates = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j];
      if (isCommandSeparator(token)) break;
      if (token.startsWith('-')) continue;
      if (hasSourceEntrypointExtension(token) && isSourceEntrypointToken(token)) {
        targetCandidates.push(normalizeScriptTarget(token));
      }
    }
    if (targetCandidates.length > 0) {
      out.push({
        reason: 'unknown-script-wrapper',
        tool: toolName || String(tokens[i] ?? ''),
        targetCandidates,
      });
    }
  }
  return out;
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

function extractRuntimeScriptEntrypoints(command) {
  const tokens = tokenizeCommand(command);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isCommandPosition(tokens, i)) continue;
    const tool = runtimeScriptTool(tokens[i]);
    if (!tool) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (isCommandSeparator(t)) break;
      if (t.startsWith('-')) continue;
      if (isRuntimeModeToken(tool, t)) continue;
      if (!hasSourceEntrypointExtension(t)) continue;
      if (isSourceEntrypointToken(t)) {
        out.push({ target: normalizeScriptTarget(t), tool, runtime: true });
        break;
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
    ...extractRuntimeScriptEntrypoints(command),
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

function inScanScope(root, full, { includeTests = true, exclude = [], languages, directory = false } = {}) {
  return scanScopeStatusForPath(root, full, {
    includeTests,
    exclude,
    languages,
    directory,
  }).included;
}

function collectHtmlFiles(pkgDir, repoMode, root, { includeTests = true, exclude = [] } = {}) {
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
    if (!inScanScope(root, dir, { includeTests, exclude, directory: true })) return;
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
        if (!inScanScope(root, full, {
          includeTests,
          exclude,
          languages: ['html', 'htm'],
        })) continue;
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

function htmlScriptTargetCandidates(pkgDir, htmlFile, src) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return null;
  const clean = src.split(/[?#]/, 1)[0];
  if (!/\.(?:[cm]?[jt]sx?)$/i.test(clean)) return null;
  if (clean.startsWith('/')) {
    const out = [];
    const htmlRootAbs = path.resolve(path.dirname(htmlFile), `.${clean}`);
    const htmlRootRel = path.relative(pkgDir, htmlRootAbs).replace(/\\/g, '/');
    if (!htmlRootRel.startsWith('../') && htmlRootRel !== '..') {
      out.push({
        target: `./${htmlRootRel}`,
        resolutionBase: 'html-directory',
      });
    }
    const packageRootTarget = `./${clean.slice(1)}`;
    if (!out.some((candidate) => candidate.target === packageRootTarget)) {
      out.push({
        target: packageRootTarget,
        resolutionBase: 'package-root',
      });
    }
    return out;
  }
  if (clean.startsWith('./') || clean.startsWith('../')) {
    const abs = path.resolve(path.dirname(htmlFile), clean);
    const rel = path.relative(pkgDir, abs).replace(/\\/g, '/');
    if (rel.startsWith('../')) return null;
    return [{
      target: `./${rel}`,
      resolutionBase: 'html-relative',
    }];
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

export function collectHtmlModuleEntrypointFiles({ root, repoMode, includeTests = true, exclude = [] }) {
  return collectHtmlModuleEntrypoints({ root, repoMode, includeTests, exclude }).entries;
}

export function collectHtmlModuleEntrypoints({ root, repoMode, includeTests = true, exclude = [] }) {
  const entries = [];
  const unresolved = [];

  for (const pkgDir of listPackageDirs(root, repoMode)) {
    const pkg = readJsonFile(path.join(pkgDir, 'package.json'));
    if (!pkg || !pkg.name) continue;
    for (const htmlFile of collectHtmlFiles(pkgDir, repoMode, root, { includeTests, exclude })) {
      let html;
      try { html = readFileSync(htmlFile, 'utf8'); } catch { continue; }
      for (const src of extractHtmlModuleScriptTargets(html)) {
        const targetCandidates = htmlScriptTargetCandidates(pkgDir, htmlFile, src);
        if (!targetCandidates?.length) continue;
        const resolvedCandidates = targetCandidates.map((candidate) => {
          const resolved = mapOutputToSource(pkgDir, candidate.target);
          return {
            ...candidate,
            resolved,
            resolvedFile: normalizeRel(root, resolved),
          };
        });
        const matched = resolvedCandidates.find((candidate) => fileExists(candidate.resolved));
        const selected = matched ?? resolvedCandidates[0];
        const evidence = {
          source: 'html-module-script',
          packageName: pkg.name,
          htmlFile: normalizeRel(root, htmlFile),
          src,
          target: selected.target,
          resolvedFile: selected.resolvedFile,
          packageDir: normalizeRel(root, pkgDir) || '.',
          resolutionBase: selected.resolutionBase,
        };
        if (matched) {
          entries.push({
            file: matched.resolvedFile,
            evidence,
          });
        } else {
          unresolved.push({
            ...evidence,
            targetCandidates: resolvedCandidates.map((candidate) => ({
              target: candidate.target,
              resolvedFile: candidate.resolvedFile,
              resolutionBase: candidate.resolutionBase,
            })),
            reason: 'html-module-script-target-missing',
            effect:
              'HTML module script target was not found under the package root; ' +
              'static server URL-to-filesystem mappings are not modeled.',
          });
        }
      }
    }
  }

  return { entries, unresolved };
}

export function collectScriptEntrypoints({ root, repoMode }) {
  const entries = [];
  const unsupported = [];
  let unsupportedRawCount = 0;

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
      const extracted = extractScriptEntrypoints(source.command, pkgDir);
      if (extracted.length === 0 && source.evidence.source === 'package.scripts') {
        for (const diagnostic of extractUnsupportedScriptEntrypoints(source.command)) {
          unsupportedRawCount++;
          if (unsupported.length < UNSUPPORTED_SCRIPT_ENTRYPOINT_SAMPLE_LIMIT) {
            unsupported.push({
              ...source.evidence,
              ...diagnostic,
              command: source.command,
              packageDir: normalizeRel(root, pkgDir) || '.',
              confidence: 'advisory',
              effect:
                'Script command may name entrypoint-relevant code, but this extractor does not model the wrapper. ' +
                'No concrete entry file was added.',
            });
          }
        }
      }
      for (const entry of extracted) {
        const { target } = entry;
        const relativeTarget = target.startsWith('./') ? target : `./${target}`;
        addEntry(entries, root, pkgDir, relativeTarget, {
          ...source.evidence,
          tool: entry.tool,
          ...(entry.runtime ? { runtime: true } : {}),
          ...(entry.dynamicInput ? { dynamicInput: true } : {}),
        });
      }
    }
  }

  return {
    entries,
    unsupported,
    unsupportedRawCount,
    unsupportedSampleLimit: UNSUPPORTED_SCRIPT_ENTRYPOINT_SAMPLE_LIMIT,
  };
}

export function collectScriptEntrypointFiles({ root, repoMode }) {
  return collectScriptEntrypoints({ root, repoMode }).entries;
}

export function indexPublicSurfaceEntries(entries) {
  const byFile = new Map();
  for (const entry of entries) {
    if (!byFile.has(entry.file)) byFile.set(entry.file, []);
    byFile.get(entry.file).push(entry.evidence);
  }
  return byFile;
}
