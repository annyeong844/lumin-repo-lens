import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseOxcOrThrow } from './parse-oxc.mjs';

const HONO_ROUTE_METHODS = new Set([
  'all',
  'delete',
  'get',
  'mount',
  'options',
  'patch',
  'post',
  'put',
  'route',
  'use',
]);

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function normalizeRelPath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
}

function isNode(value) {
  return value && typeof value === 'object' && typeof value.type === 'string';
}

function walk(node, visit) {
  if (!isNode(node)) return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

function stringValue(node) {
  if (!node) return null;
  return typeof node.value === 'string' ? node.value : null;
}

function identifierName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  return null;
}

function calleeName(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  const objectName = identifierName(node.object);
  const propertyName = identifierName(node.property);
  if (!objectName || !propertyName || !HONO_ROUTE_METHODS.has(propertyName)) return null;
  return `${objectName}.${propertyName}`;
}

function localImportTarget(importerFile, specifier, fileSet) {
  if (!specifier.startsWith('.')) return null;
  const importerDir = path.posix.dirname(normalizeRelPath(importerFile));
  const raw = normalizeRelPath(path.posix.normalize(path.posix.join(importerDir, specifier)));
  const candidates = [];
  for (const ext of SOURCE_EXTENSIONS) candidates.push(`${raw}${ext}`);
  for (const ext of SOURCE_EXTENSIONS.filter(Boolean)) candidates.push(`${raw}/index${ext}`);
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function collectImports(ast, file, fileSet) {
  const imports = new Map();
  for (const node of ast.program?.body ?? []) {
    if (node.type !== 'ImportDeclaration') continue;
    const targetFile = localImportTarget(file, stringValue(node.source) ?? '', fileSet);
    if (!targetFile) continue;

    for (const specifier of node.specifiers ?? []) {
      if (specifier.type === 'ImportSpecifier') {
        const localName = identifierName(specifier.local);
        const importedName = identifierName(specifier.imported) ?? stringValue(specifier.imported);
        if (localName && importedName) {
          imports.set(localName, { file: targetFile, exportName: importedName });
        }
      } else if (specifier.type === 'ImportDefaultSpecifier') {
        const localName = identifierName(specifier.local);
        if (localName) imports.set(localName, { file: targetFile, exportName: 'default' });
      }
    }
  }
  return imports;
}

function collectExports(ast, file) {
  const exports = new Map();
  for (const node of ast.program?.body ?? []) {
    if (node.type !== 'ExportNamedDeclaration') continue;

    const declaration = node.declaration;
    if (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') {
      const name = identifierName(declaration.id);
      if (name) exports.set(name, { file, exportName: name });
    }
    if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations ?? []) {
        const name = identifierName(declarator.id);
        if (name) exports.set(name, { file, exportName: name });
      }
    }

    for (const specifier of node.specifiers ?? []) {
      if (specifier.type !== 'ExportSpecifier') continue;
      const localName = identifierName(specifier.local);
      const exportedName = identifierName(specifier.exported) ?? stringValue(specifier.exported);
      if (localName && exportedName) exports.set(localName, { file, exportName: exportedName });
    }
  }
  return exports;
}

function routeArgs(args) {
  const route = stringValue(args?.[0]);
  if (!route) return { route: null, handlerArgs: [] };
  return { route, handlerArgs: args.slice(1) };
}

export function collectHonoRouteRegistrations({ root, files = [] }) {
  const normalizedFiles = files.map(normalizeRelPath);
  const fileSet = new Set(normalizedFiles);
  const facts = [];

  for (const file of normalizedFiles) {
    const abs = path.join(root, file);
    const src = readFileSync(abs, 'utf8');
    const ast = parseOxcOrThrow(file, src);
    const refsByLocalName = new Map([
      ...collectImports(ast, file, fileSet),
      ...collectExports(ast, file),
    ]);

    walk(ast.program, (node) => {
      if (node.type !== 'CallExpression') return;
      const namedCallee = calleeName(node.callee);
      if (!namedCallee) return;

      const { route, handlerArgs } = routeArgs(node.arguments ?? []);
      if (!route) return;

      const handlerRefs = [];
      for (const arg of handlerArgs) {
        const name = identifierName(arg);
        const ref = name ? refsByLocalName.get(name) : null;
        if (ref) handlerRefs.push(ref);
      }
      if (handlerRefs.length === 0) return;

      facts.push({
        file,
        callee: namedCallee,
        route,
        handlerRefs,
      });
    });
  }

  return facts;
}
