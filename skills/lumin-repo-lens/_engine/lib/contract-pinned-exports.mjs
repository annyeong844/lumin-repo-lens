// Detect exports that are pinned by test-side contract imports.
//
// Production scans intentionally exclude tests, but tests often import
// internal helpers directly to pin phase contracts and schema mirrors. If
// those test-only consumers are ignored, the cleanup recommender reports
// contract helpers as removable. This module collects exact test imports so
// classify-dead-exports can mute those candidates instead of surfacing them as
// review-visible cleanup work.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { collectFiles } from './collect-files.mjs';
import { parseOxcOrThrow } from './parse-oxc.mjs';
import { isResolvedFile } from './resolver-core.mjs';
import { isTestLikePath } from './test-paths.mjs';

function toRel(root, abs) {
  return path.relative(root, abs).replace(/\\/g, '/');
}

function sourceValue(node) {
  const v = node?.source?.value;
  return typeof v === 'string' ? v : null;
}

function importExpressionSource(node) {
  const unwrapped = node?.type === 'AwaitExpression' ? node.argument : node;
  const v = unwrapped?.type === 'ImportExpression'
    ? unwrapped.source?.value
    : null;
  return typeof v === 'string' ? v : null;
}

function importedName(spec) {
  if (spec?.type === 'ImportDefaultSpecifier') return 'default';
  if (spec?.type !== 'ImportSpecifier') return null;
  const imported = spec.imported;
  if (typeof imported?.name === 'string') return imported.name;
  if (typeof imported?.value === 'string') return imported.value;
  return null;
}

function localName(spec) {
  return spec?.local?.name ?? null;
}

function pinKey(file, symbol) {
  return `${file}::${symbol}`;
}

function addSymbolPin(symbolPins, importedFile, name, evidence) {
  if (!name) return;
  const key = pinKey(importedFile, name);
  if (!symbolPins.has(key)) symbolPins.set(key, { ...evidence, importedName: name });
}

function collectObjectPatternNames(pattern) {
  const out = [];
  if (pattern?.type !== 'ObjectPattern') return out;
  for (const prop of pattern.properties ?? []) {
    if (prop?.type !== 'Property' || prop.computed) continue;
    if (typeof prop.key?.name === 'string') out.push(prop.key.name);
    else if (typeof prop.key?.value === 'string') out.push(prop.key.value);
  }
  return out;
}

function literalKey(node) {
  if (!node) return null;
  if (typeof node.value === 'string') return node.value;
  if (typeof node.name === 'string') return node.name;
  return null;
}

function literalStringArray(node) {
  if (node?.type !== 'ArrayExpression') return null;
  const out = [];
  for (const el of node.elements ?? []) {
    if (typeof el?.value !== 'string' || el.value.length === 0) return null;
    out.push(el.value);
  }
  return out;
}

function looksLikeModuleFileKey(key) {
  return typeof key === 'string' &&
    /\.(mjs|cjs|js|jsx|mts|cts|ts|tsx)$/.test(key.replace(/\\/g, '/'));
}

function collectExportManifestPins(node, onPin) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectExportManifestPins(item, onPin);
    return;
  }

  if (node.type !== 'VariableDeclarator') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc') continue;
      if (value && typeof value === 'object') collectExportManifestPins(value, onPin);
    }
    return;
  }

  const name = node.id?.name;
  if (typeof name !== 'string' || !/exports/i.test(name)) return;
  if (node.init?.type !== 'ObjectExpression') return;

  for (const prop of node.init.properties ?? []) {
    if (prop?.type !== 'Property' || prop.computed) continue;
    const fileKey = literalKey(prop.key);
    if (!looksLikeModuleFileKey(fileKey)) continue;
    const symbols = literalStringArray(prop.value);
    if (!symbols || symbols.length === 0) continue;

    const importedFile = fileKey.replace(/\\/g, '/').replace(/^\.\//, '');
    for (const symbol of symbols) {
      onPin({
        importedFile,
        symbol,
        evidence: {
          source: fileKey,
          localName: symbol,
          importKind: 'test-export-manifest',
        },
      });
    }
  }
}

function walkDynamicImportDestructures(node, onMatch) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkDynamicImportDestructures(item, onMatch);
    return;
  }

  if (node.type === 'VariableDeclarator') {
    const specifier = importExpressionSource(node.init);
    if (specifier) onMatch({ specifier, names: collectObjectPatternNames(node.id) });
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc') continue;
    if (value && typeof value === 'object') walkDynamicImportDestructures(value, onMatch);
  }
}

export function collectTestPinnedExports({
  root,
  resolve,
  exclude = [],
} = {}) {
  const symbolPins = new Map();
  const namespacePins = new Map();
  const diagnostics = [];

  if (typeof root !== 'string' || typeof resolve !== 'function') {
    return { symbolPins, namespacePins, diagnostics };
  }

  const testFiles = collectFiles(root, { includeTests: true, exclude })
    .filter((abs) => isTestLikePath(toRel(root, abs)));

  for (const abs of testFiles) {
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch (e) {
      diagnostics.push({ kind: 'test-contract-pin-read-error', file: toRel(root, abs), message: e.message });
      continue;
    }

    let parsed;
    try {
      parsed = parseOxcOrThrow(abs, src);
    } catch (e) {
      diagnostics.push({ kind: 'test-contract-pin-parse-error', file: toRel(root, abs), message: e.message });
      continue;
    }

    const testFile = toRel(root, abs);
    for (const stmt of parsed.program?.body ?? []) {
      if (stmt?.type === 'ImportDeclaration') {
        const specifier = sourceValue(stmt);
        if (!specifier) continue;
        const resolved = resolve(abs, specifier);
        if (!isResolvedFile(resolved)) continue;
        const importedFile = toRel(root, resolved);

        for (const spec of stmt.specifiers ?? []) {
          if (spec?.type === 'ImportNamespaceSpecifier') {
            if (!namespacePins.has(importedFile)) {
              namespacePins.set(importedFile, { testFile, source: specifier, importKind: 'namespace' });
            }
            continue;
          }

          addSymbolPin(symbolPins, importedFile, importedName(spec), {
            testFile,
            source: specifier,
            localName: localName(spec),
            importKind: spec.type === 'ImportDefaultSpecifier' ? 'default' : 'named',
          });
        }
        continue;
      }

      walkDynamicImportDestructures(stmt, ({ specifier, names }) => {
        const resolved = resolve(abs, specifier);
        if (!isResolvedFile(resolved)) return;
        const importedFile = toRel(root, resolved);
        for (const name of names) {
          addSymbolPin(symbolPins, importedFile, name, {
            testFile,
            source: specifier,
            localName: name,
            importKind: 'dynamic-named',
          });
        }
      });

      collectExportManifestPins(stmt, ({ importedFile, symbol, evidence }) => {
        addSymbolPin(symbolPins, importedFile, symbol, {
          testFile,
          ...evidence,
        });
      });
    }
  }

  return { symbolPins, namespacePins, diagnostics };
}

export function findTestPinnedExport(testPins, finding) {
  const file = String(finding?.file ?? '').replace(/\\/g, '/');
  const symbol = finding?.symbol;
  if (!file || !symbol) return null;
  return testPins?.symbolPins?.get(pinKey(file, symbol)) ??
    testPins?.namespacePins?.get(file) ??
    null;
}
