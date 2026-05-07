import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fileExists, relPath } from './paths.mjs';
import { normalizeGeneratedSpecifierSubpath } from './generated-artifact-evidence.mjs';

export const GENERATED_VIRTUAL_SURFACE_SOURCE = 'generated-virtual';

function stripBlockComments(source) {
  return String(source ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
}

export function schemaUsesPrismaEnumGenerator(source) {
  const src = stripBlockComments(source);
  const generatorRe = /\bgenerator\s+[A-Za-z_][A-Za-z0-9_]*\s*\{([\s\S]*?)\}/g;
  for (const match of src.matchAll(generatorRe)) {
    if (/\bprovider\s*=\s*["']prisma[-_]enum[-_]generator["']/.test(match[1] ?? '')) {
      return true;
    }
  }
  return false;
}

export function parsePrismaEnums(source) {
  const src = stripBlockComments(source);
  const enumRe = /\benum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}/g;
  const enums = [];

  for (const match of src.matchAll(enumRe)) {
    const name = match[1];
    const body = String(match[2] ?? '');
    const values = [];
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine
        .replace(/\/\/.*$/, '')
        .trim();
      if (!line || line.startsWith('@')) continue;
      const value = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line)?.[1];
      if (value) values.push(value);
    }
    enums.push({ name, values });
  }

  return enums.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildPrismaEnumVirtualSurface({ root, pkgDir, pkgName, targetSubpath, generatedArtifact }) {
  if (normalizeGeneratedSpecifierSubpath(targetSubpath) !== 'enums') return null;
  if (generatedArtifact?.generatorFamily !== 'prisma' || generatedArtifact?.confidence !== 'strong') {
    return null;
  }

  const schemaPath = path.join(pkgDir, 'schema.prisma');
  if (!fileExists(schemaPath)) return null;

  let source;
  try {
    source = readFileSync(schemaPath, 'utf8');
  } catch {
    return null;
  }

  if (!schemaUsesPrismaEnumGenerator(source)) return null;
  const enums = parsePrismaEnums(source);
  if (enums.length === 0) return null;

  const normalizedSubpath = normalizeGeneratedSpecifierSubpath(targetSubpath);
  return {
    id: `generated-virtual:prisma-enums:${pkgName}:${normalizedSubpath}`,
    source: GENERATED_VIRTUAL_SURFACE_SOURCE,
    mode: 'virtual',
    virtual: true,
    runtimeEquivalence: false,
    generatorFamily: 'prisma',
    surfaceConfidence: 'declared',
    surfaceCompleteness: 'partial',
    matchedPackage: pkgName,
    targetSubpath: normalizedSubpath,
    derivedFrom: [relPath(root, schemaPath)],
    generatedArtifact,
    exports: enums.map((item) => ({
      name: item.name,
      kind: 'prisma-enum',
      spaces: ['value', 'type'],
      values: item.values,
    })),
  };
}

export function generatedVirtualSurfaceForSubpath(entry, subpath) {
  const normalized = normalizeGeneratedSpecifierSubpath(subpath);
  return (entry?.generatedVirtualSurfaces ?? []).find((surface) =>
    normalizeGeneratedSpecifierSubpath(surface?.targetSubpath) === normalized) ?? null;
}

export function isGeneratedVirtualResolution(value) {
  return value && typeof value === 'object' && value.source === GENERATED_VIRTUAL_SURFACE_SOURCE;
}
