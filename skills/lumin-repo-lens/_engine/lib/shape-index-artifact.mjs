// _lib/shape-index-artifact.mjs - P4-2 shape-index artifact builder.

import path from 'node:path';

import {
  SHAPE_HASH_NORMALIZED_VERSION,
  extractShapeHashFactsFromSource,
  groupShapeFactsByHash,
} from './shape-hash.mjs';
import { SHAPE_INDEX_SCHEMA_VERSION } from './shape-index-schema.mjs';

function toRel(root, abs) {
  return path.relative(root, abs).replace(/\\/g, '/');
}

function readErrorDiagnostic(file, message) {
  return {
    kind: 'shape-hash-diagnostic',
    code: 'read-error',
    severity: 'error',
    file,
    message,
  };
}

function isParseErrorDiagnostic(d) {
  return d?.kind === 'shape-hash-diagnostic' && d.code === 'parse-error';
}

export function buildShapeIndexArtifact({
  root,
  files,
  readFile,
  metaBase,
  includeTests,
  exclude,
  scope,
  observedAt,
}) {
  const facts = [];
  const diagnostics = [];
  const filesWithParseErrors = [];
  const filesWithReadErrors = [];

  for (const abs of files) {
    const relFile = toRel(root, abs);
    let src;
    try {
      src = readFile(abs, 'utf8');
    } catch (e) {
      filesWithReadErrors.push({ file: relFile, message: e.message });
      diagnostics.push(readErrorDiagnostic(relFile, `read failed: ${e.message}`));
      continue;
    }

    const result = extractShapeHashFactsFromSource(src, relFile, {
      source: 'fresh-ast-pass',
      scope,
      observedAt,
    });
    facts.push(...result.facts);
    diagnostics.push(...result.diagnostics);

    for (const d of result.diagnostics) {
      if (isParseErrorDiagnostic(d)) {
        filesWithParseErrors.push({
          file: d.file ?? relFile,
          message: d.message,
        });
      }
    }
  }

  facts.sort((a, b) => {
    if (a.ownerFile !== b.ownerFile) return a.ownerFile < b.ownerFile ? -1 : 1;
    if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0);
    return a.exportedName < b.exportedName ? -1 : (a.exportedName > b.exportedName ? 1 : 0);
  });
  diagnostics.sort((a, b) => {
    const af = a.file ?? a.ownerFile ?? '';
    const bf = b.file ?? b.ownerFile ?? '';
    if (af !== bf) return af < bf ? -1 : 1;
    if ((a.exportedName ?? '') !== (b.exportedName ?? '')) {
      return (a.exportedName ?? '') < (b.exportedName ?? '') ? -1 : 1;
    }
    return (a.code ?? '') < (b.code ?? '') ? -1 : ((a.code ?? '') > (b.code ?? '') ? 1 : 0);
  });

  const groupsByHash = groupShapeFactsByHash(facts);
  const generatedFileFactCount = facts.filter((fact) => fact.generatedFile).length;

  return {
    schemaVersion: SHAPE_INDEX_SCHEMA_VERSION,
    meta: {
      ...metaBase,
      source: 'fresh-ast-pass',
      scope,
      observedAt,
      complete: filesWithReadErrors.length === 0 && filesWithParseErrors.length === 0,
      includeTests: includeTests === true,
      exclude: exclude ?? [],
      fileCount: files.length,
      factCount: facts.length,
      generatedFileFactCount,
      hashGroupCount: Object.keys(groupsByHash).length,
      diagnosticCount: diagnostics.length,
      filesWithParseErrors,
      filesWithReadErrors,
      supports: {
        shapeHash: true,
        normalizedVersion: SHAPE_HASH_NORMALIZED_VERSION,
        exportedInterfaces: true,
        exportedObjectTypeAliases: true,
        exportedUnionLiteralTypeAliases: true,
        unsupportedShapesAsDiagnostics: true,
        generatedFileEvidence: true,
      },
    },
    facts,
    groupsByHash,
    diagnostics,
  };
}
