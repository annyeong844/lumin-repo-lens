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

export function extractShapeIndexFilePayload({
  src,
  relFile,
  scope,
  observedAt,
}) {
  const result = extractShapeHashFactsFromSource(src, relFile, {
    source: 'fresh-ast-pass',
    scope,
    observedAt,
  });

  const filesWithParseErrors = [];
  for (const d of result.diagnostics) {
    if (isParseErrorDiagnostic(d)) {
      filesWithParseErrors.push({
        file: d.file ?? relFile,
        message: d.message,
      });
    }
  }

  return {
    facts: result.facts,
    diagnostics: result.diagnostics,
    filesWithParseErrors,
    filesWithReadErrors: [],
  };
}

export function shapeIndexReadErrorPayload(relFile, message) {
  return {
    facts: [],
    diagnostics: [readErrorDiagnostic(relFile, `read failed: ${message}`)],
    filesWithParseErrors: [],
    filesWithReadErrors: [{ file: relFile, message }],
  };
}

function sortFacts(facts) {
  return [...facts].sort((a, b) => {
    if (a.ownerFile !== b.ownerFile) return a.ownerFile < b.ownerFile ? -1 : 1;
    if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0);
    return a.exportedName < b.exportedName ? -1 : (a.exportedName > b.exportedName ? 1 : 0);
  });
}

function sortDiagnostics(diagnostics) {
  return [...diagnostics].sort((a, b) => {
    const af = a.file ?? a.ownerFile ?? '';
    const bf = b.file ?? b.ownerFile ?? '';
    if (af !== bf) return af < bf ? -1 : 1;
    if ((a.exportedName ?? '') !== (b.exportedName ?? '')) {
      return (a.exportedName ?? '') < (b.exportedName ?? '') ? -1 : 1;
    }
    return (a.code ?? '') < (b.code ?? '') ? -1 : ((a.code ?? '') > (b.code ?? '') ? 1 : 0);
  });
}

function sortFileErrors(errors) {
  return [...errors].sort((a, b) =>
    String(a.file ?? '').localeCompare(String(b.file ?? '')) ||
    String(a.message ?? '').localeCompare(String(b.message ?? '')));
}

function appendPayload(target, payload) {
  target.facts.push(...(payload.facts ?? []));
  target.diagnostics.push(...(payload.diagnostics ?? []));
  target.filesWithParseErrors.push(...(payload.filesWithParseErrors ?? []));
  target.filesWithReadErrors.push(...(payload.filesWithReadErrors ?? []));
}

export function assembleShapeIndexArtifact({
  metaBase,
  includeTests,
  exclude,
  scope,
  observedAt,
  fileCount,
  facts,
  diagnostics,
  filesWithParseErrors,
  filesWithReadErrors,
  incremental = null,
}) {
  const stampedFacts = facts.map((fact) => ({
    ...fact,
    observedAt,
  }));
  const sortedFacts = sortFacts(stampedFacts);
  const sortedDiagnostics = sortDiagnostics(diagnostics);
  const sortedParseErrors = sortFileErrors(filesWithParseErrors);
  const sortedReadErrors = sortFileErrors(filesWithReadErrors);
  const groupsByHash = groupShapeFactsByHash(sortedFacts);
  const generatedFileFactCount = sortedFacts.filter((fact) => fact.generatedFile).length;

  return {
    schemaVersion: SHAPE_INDEX_SCHEMA_VERSION,
    meta: {
      ...metaBase,
      source: 'fresh-ast-pass',
      scope,
      observedAt,
      complete: sortedReadErrors.length === 0 && sortedParseErrors.length === 0,
      includeTests: includeTests === true,
      exclude: exclude ?? [],
      fileCount,
      factCount: sortedFacts.length,
      generatedFileFactCount,
      hashGroupCount: Object.keys(groupsByHash).length,
      diagnosticCount: sortedDiagnostics.length,
      filesWithParseErrors: sortedParseErrors,
      filesWithReadErrors: sortedReadErrors,
      ...(incremental ? { incremental } : {}),
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
    facts: sortedFacts,
    groupsByHash,
    diagnostics: sortedDiagnostics,
  };
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
  const aggregate = {
    facts: [],
    diagnostics: [],
    filesWithParseErrors: [],
    filesWithReadErrors: [],
  };

  for (const abs of files) {
    const relFile = toRel(root, abs);
    let src;
    try {
      src = readFile(abs, 'utf8');
    } catch (e) {
      appendPayload(aggregate, shapeIndexReadErrorPayload(relFile, e.message));
      continue;
    }

    appendPayload(aggregate, extractShapeIndexFilePayload({
      src,
      relFile,
      scope,
      observedAt,
    }));
  }

  return assembleShapeIndexArtifact({
    metaBase,
    includeTests,
    exclude,
    scope,
    observedAt,
    fileCount: files.length,
    ...aggregate,
  });
}
