// _lib/symbol-graph-artifact.mjs
//
// Pure builders for symbols.json. The producer still owns scanning and graph
// construction; this module keeps the artifact-shape contract in one place.

import path from 'node:path';

import { producerMetaBase } from './artifacts.mjs';
import { relPath } from './paths.mjs';

function buildReExportsByFile({ root, fileData }) {
  const reExportsByFile = {};
  for (const [absFile, info] of fileData) {
    if (!info.reExports || info.reExports.length === 0) continue;
    const rel = relPath(root, absFile);
    reExportsByFile[rel] = info.reExports.map((r) => ({
      source: r.source,
      line: r.line,
    }));
  }
  return reExportsByFile;
}

function buildFilesWithParseErrors({ root, entries }) {
  const filesWithParseErrors = [];
  for (const [f, entry] of Object.entries(entries ?? {})) {
    if (entry.parseError) filesWithParseErrors.push(relPath(root, f));
  }
  return filesWithParseErrors.sort();
}

function buildTopUnresolvedSpecifiers({ unresolvedInternalByPrefix, prefixExamples }) {
  return [...unresolvedInternalByPrefix.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([specifierPrefix, count]) => {
      const example = prefixExamples.get(specifierPrefix) ?? specifierPrefix;
      let likelyCause = null;
      if (/^(@|~|#)\//.test(specifierPrefix) || /^@[^/]+\//.test(specifierPrefix)) {
        likelyCause =
          'possible unresolved tsconfig paths alias. Check per-app ' +
          'tsconfig.json for a compilerOptions.paths entry matching this prefix. ' +
          'See FP-36 in references/false-positive-index.md.';
      }
      return { specifierPrefix, count, example, ...(likelyCause ? { likelyCause } : {}) };
    });
}

function buildDynamicImportOpacity({ root, fileData }) {
  const dynamicImportOpacity = [];
  for (const [absFile, info] of fileData) {
    for (const item of info.dynamicImportOpacity ?? []) {
      const relConsumer = relPath(root, absFile);
      const rec = {
        consumerFile: relConsumer,
        line: item.line,
        kind: item.kind,
      };
      if (item.prefix) {
        const targetDirAbs = path.resolve(path.dirname(absFile), item.prefix);
        rec.prefix = item.prefix;
        rec.targetDir = relPath(root, targetDirAbs).replace(/\/?$/, '/');
      }
      dynamicImportOpacity.push(rec);
    }
  }
  return dynamicImportOpacity.sort((a, b) =>
    `${a.consumerFile}|${String(a.line).padStart(6, '0')}|${a.prefix ?? ''}`
      .localeCompare(`${b.consumerFile}|${String(b.line).padStart(6, '0')}|${b.prefix ?? ''}`));
}

function buildPlainDefIndex({ root, defIndex }) {
  const out = {};
  for (const [defFile, m] of defIndex) {
    out[relPath(root, defFile)] = Object.fromEntries(m);
  }
  return out;
}

export function buildSymbolsArtifact({
  root,
  files,
  defIndex,
  fileData,
  parseErrors,
  warnings,
  nextCache,
  unresolvedInternalByPrefix,
  prefixExamples,
  unresolvedInternalSpecifiers,
  unresolvedInternalSpecifierRecords,
  languageSupport,
  totalUses,
  unresolvedUses,
  resolvedInternalUses,
  externalUses,
  dependencyImportConsumers,
  unresolvedInternalUses,
  mdxConsumerUses,
  dead,
  trulyDead,
  deadInProd,
  deadInTest,
  symbolFanIn,
  fanInByIdentity,
  anyContaminationFacts,
}) {
  const artifactWarnings = [...(warnings ?? [])];
  if (parseErrors > 0) {
    artifactWarnings.push({
      code: 'parse-errors',
      count: parseErrors,
      message: `${parseErrors} file(s) failed to parse; their defs/uses are missing from the graph`,
    });
  }

  return {
    meta: {
      ...producerMetaBase({ tool: 'build-symbol-graph.mjs', root }),
      schemaVersion: 3,
      supports: {
        anyContamination: true,
        identityFanIn: true,
        reExportRecords: 'file-level',
        mdxImportConsumers: true,
        dependencyImportConsumers: true,
      },
      languageSupport,
      warnings: artifactWarnings,
    },
    files: files.length,
    totalDefs: [...defIndex.values()].reduce((a, m) => a + m.size, 0),
    totalUsesResolved: totalUses,
    unresolvedUses,
    uses: {
      resolvedInternal: resolvedInternalUses,
      external: externalUses,
      unresolvedInternal: unresolvedInternalUses,
      mdxConsumers: mdxConsumerUses,
      unresolvedInternalRatio:
        (resolvedInternalUses + unresolvedInternalUses) > 0
          ? +(unresolvedInternalUses / (resolvedInternalUses + unresolvedInternalUses)).toFixed(4)
          : 0,
    },
    dependencyImportConsumers: [...(dependencyImportConsumers ?? [])].sort((a, b) =>
      `${a.depRoot ?? ''}|${a.fromSpec ?? ''}|${a.file ?? ''}|${a.kind ?? ''}`
        .localeCompare(`${b.depRoot ?? ''}|${b.fromSpec ?? ''}|${b.file ?? ''}|${b.kind ?? ''}`)),
    topUnresolvedSpecifiers: buildTopUnresolvedSpecifiers({
      unresolvedInternalByPrefix,
      prefixExamples,
    }),
    dynamicImportOpacity: buildDynamicImportOpacity({ root, fileData }),
    unresolvedInternalSpecifiers: [...unresolvedInternalSpecifiers].sort(),
    unresolvedInternalSpecifierRecords: [...(unresolvedInternalSpecifierRecords ?? [])].sort((a, b) =>
      `${a.consumerFile ?? ''}|${a.specifier ?? ''}|${a.kind ?? ''}`
        .localeCompare(`${b.consumerFile ?? ''}|${b.specifier ?? ''}|${b.kind ?? ''}`)),
    filesWithParseErrors: buildFilesWithParseErrors({ root, entries: nextCache.entries }),
    deadTotal: dead.length,
    trulyDead: trulyDead.length,
    deadInProd: deadInProd.length,
    deadInTest: deadInTest.length,
    topSymbolFanIn: symbolFanIn.slice(0, 50),
    fanInByIdentity,
    helperOwnersByIdentity: anyContaminationFacts?.helperOwnersByIdentity ?? {},
    typeOwnersByIdentity: anyContaminationFacts?.typeOwnersByIdentity ?? {},
    defIndex: buildPlainDefIndex({ root, defIndex }),
    deadProdList: deadInProd,
    reExportsByFile: buildReExportsByFile({ root, fileData }),
  };
}
