// _lib/symbol-graph-artifact.mjs
//
// Pure builders for symbols.json. The producer still owns scanning and graph
// construction; this module keeps the artifact-shape contract in one place.

import path from "node:path";

import { producerMetaBase } from "./artifacts.mjs";
import { relPath } from "./paths.mjs";

function buildReExportsByFile({ root, fileData }) {
  const reExportsByFile = {};
  for (const [absFile, info] of fileData) {
    if (!info.reExports || info.reExports.length === 0) continue;
    const rel = relPath(root, absFile);
    reExportsByFile[rel] = info.reExports.map((r) => ({
      source: r.source,
      line: r.line,
      ...(r.namespace ? { namespace: r.namespace } : {}),
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

function sortNamespaceReExportDiagnostics(items) {
  return [...(items ?? [])].sort((a, b) =>
    `${a.consumerFile ?? ""}|${a.exportedName ?? ""}|${a.targetFile ?? ""}|${a.kind ?? ""}|${a.line ?? ""}`.localeCompare(
      `${b.consumerFile ?? ""}|${b.exportedName ?? ""}|${b.targetFile ?? ""}|${b.kind ?? ""}|${b.line ?? ""}`,
    ),
  );
}

function sortSfcStyleAssetReferences(items) {
  return [...(items ?? [])].sort((a, b) =>
    `${a.consumerFile ?? ""}|${a.fromSpec ?? ""}|${a.source ?? ""}|${a.status ?? ""}`.localeCompare(
      `${b.consumerFile ?? ""}|${b.fromSpec ?? ""}|${b.source ?? ""}|${b.status ?? ""}`,
    ),
  );
}

function sortSfcTemplateComponentRefs(items) {
  return [...(items ?? [])].sort((a, b) =>
    `${a.consumerFile ?? ""}|${a.tagName ?? ""}|${a.bindingName ?? ""}|${a.status ?? ""}|${a.reason ?? ""}`.localeCompare(
      `${b.consumerFile ?? ""}|${b.tagName ?? ""}|${b.bindingName ?? ""}|${b.status ?? ""}|${b.reason ?? ""}`,
    ),
  );
}

function sortSfcGlobalComponentRegistrations(items) {
  return [...(items ?? [])].sort((a, b) =>
    `${a.registrationFile ?? ""}|${a.componentName ?? ""}|${a.bindingName ?? ""}|${a.status ?? ""}|${a.reason ?? ""}`.localeCompare(
      `${b.registrationFile ?? ""}|${b.componentName ?? ""}|${b.bindingName ?? ""}|${b.status ?? ""}|${b.reason ?? ""}`,
    ),
  );
}

function sortSfcGeneratedComponentManifests(items) {
  return [...(items ?? [])].sort((a, b) =>
    `${a.manifestFile ?? ""}|${a.componentName ?? ""}|${a.fromSpec ?? ""}|${a.status ?? ""}|${a.reason ?? ""}`.localeCompare(
      `${b.manifestFile ?? ""}|${b.componentName ?? ""}|${b.fromSpec ?? ""}|${b.status ?? ""}|${b.reason ?? ""}`,
    ),
  );
}

function sortSfcFrameworkConventionComponents(items) {
  return [...(items ?? [])].sort((a, b) =>
    `${a.framework ?? ""}|${a.conventionKind ?? ""}|${a.consumerFile ?? ""}|${a.sourceFile ?? ""}|${a.configFile ?? ""}|${a.componentName ?? ""}|${a.tagName ?? ""}|${a.directiveName ?? ""}|${a.actionName ?? ""}|${a.subscriptionName ?? ""}|${a.storeName ?? ""}|${a.macroName ?? ""}|${a.fromSpec ?? ""}`.localeCompare(
      `${b.framework ?? ""}|${b.conventionKind ?? ""}|${b.consumerFile ?? ""}|${b.sourceFile ?? ""}|${b.configFile ?? ""}|${b.componentName ?? ""}|${b.tagName ?? ""}|${b.directiveName ?? ""}|${b.actionName ?? ""}|${b.subscriptionName ?? ""}|${b.storeName ?? ""}|${b.macroName ?? ""}|${b.fromSpec ?? ""}`,
    ),
  );
}

function buildTopUnresolvedSpecifiers({
  unresolvedInternalByPrefix,
  prefixExamples,
}) {
  return [...unresolvedInternalByPrefix.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([specifierPrefix, count]) => {
      const example = prefixExamples.get(specifierPrefix) ?? specifierPrefix;
      let likelyCause = null;
      if (
        /^(@|~|#)\//.test(specifierPrefix) ||
        /^@[^/]+\//.test(specifierPrefix)
      ) {
        likelyCause =
          "possible unresolved tsconfig paths alias. Check per-app " +
          "tsconfig.json for a compilerOptions.paths entry matching this prefix. " +
          "See FP-36 in references/false-positive-index.md.";
      }
      return {
        specifierPrefix,
        count,
        example,
        ...(likelyCause ? { likelyCause } : {}),
      };
    });
}

function compactUnresolvedExample(record = {}) {
  return {
    specifier: record.specifier,
    consumerFile: record.consumerFile,
    kind: record.kind,
    ...(typeof record.typeOnly === "boolean"
      ? { typeOnly: record.typeOnly }
      : {}),
    ...(record.resolverStage ? { resolverStage: record.resolverStage } : {}),
    ...(record.matchedPattern ? { matchedPattern: record.matchedPattern } : {}),
    ...(record.hint ? { hint: record.hint } : {}),
    ...(Array.isArray(record.targetCandidates) && record.targetCandidates.length
      ? { targetCandidates: record.targetCandidates.slice(0, 3) }
      : {}),
  };
}

function unresolvedSpace(record = {}) {
  if (record.typeOnly === true) return "type";
  if (record.typeOnly === false) return "value";
  return "unknown";
}

function sortedCounterObject(counter) {
  return Object.fromEntries(
    [...counter.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function buildUnresolvedInternalSummaryByReason(records) {
  const groups = new Map();

  for (const rawRecord of records ?? []) {
    const record = rawRecord && typeof rawRecord === "object" ? rawRecord : {};
    const reason = record?.reason ?? "unknown-internal-resolution";
    if (!groups.has(reason)) {
      groups.set(reason, {
        count: 0,
        spaces: {
          type: 0,
          value: 0,
          unknown: 0,
        },
        resolverStages: new Map(),
        hints: new Map(),
        examples: [],
      });
    }

    const group = groups.get(reason);
    group.count++;
    group.spaces[unresolvedSpace(record)]++;
    if (record?.resolverStage) {
      group.resolverStages.set(
        record.resolverStage,
        (group.resolverStages.get(record.resolverStage) ?? 0) + 1,
      );
    }
    if (record?.hint) {
      group.hints.set(record.hint, (group.hints.get(record.hint) ?? 0) + 1);
    }
    group.examples.push(compactUnresolvedExample(record));
  }

  return Object.fromEntries(
    [...groups.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .map(([reason, group]) => [
        reason,
        {
          count: group.count,
          spaces: group.spaces,
          ...(group.resolverStages.size
            ? { resolverStages: sortedCounterObject(group.resolverStages) }
            : {}),
          ...(group.hints.size
            ? { hints: sortedCounterObject(group.hints) }
            : {}),
          examples: group.examples
            .sort((a, b) =>
              `${a.consumerFile ?? ""}|${a.specifier ?? ""}|${a.kind ?? ""}`.localeCompare(
                `${b.consumerFile ?? ""}|${b.specifier ?? ""}|${b.kind ?? ""}`,
              ),
            )
            .slice(0, 5),
        },
      ]),
  );
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
        rec.targetDir = relPath(root, targetDirAbs).replace(/\/?$/, "/");
      }
      dynamicImportOpacity.push(rec);
    }
  }
  return dynamicImportOpacity.sort((a, b) =>
    `${a.consumerFile}|${String(a.line).padStart(6, "0")}|${a.prefix ?? ""}`.localeCompare(
      `${b.consumerFile}|${String(b.line).padStart(6, "0")}|${b.prefix ?? ""}`,
    ),
  );
}

function sortCjsSurfaceList(entries = []) {
  return [...entries].sort((a, b) =>
    `${a.name ?? ""}|${a.kind ?? ""}|${String(a.line ?? "").padStart(6, "0")}`.localeCompare(
      `${b.name ?? ""}|${b.kind ?? ""}|${String(b.line ?? "").padStart(6, "0")}`,
    ),
  );
}

function buildCjsExportSurfaceByFile({ root, fileData }) {
  const out = {};
  for (const [absFile, info] of fileData) {
    const surface = info.cjsExportSurface;
    if (!surface || (!surface.exact?.length && !surface.opaque?.length))
      continue;
    out[relPath(root, absFile)] = {
      exact: sortCjsSurfaceList(surface.exact),
      opaque: sortCjsSurfaceList(surface.opaque),
    };
  }
  return out;
}

function buildCjsRequireOpacity({ root, fileData }) {
  const cjsRequireOpacity = [];
  for (const [absFile, info] of fileData) {
    for (const item of info.cjsRequireOpacity ?? []) {
      cjsRequireOpacity.push({
        consumerFile: relPath(root, absFile),
        line: item.line,
        kind: item.kind,
      });
    }
  }
  return cjsRequireOpacity.sort((a, b) =>
    `${a.consumerFile}|${String(a.line).padStart(6, "0")}|${a.kind ?? ""}`.localeCompare(
      `${b.consumerFile}|${String(b.line).padStart(6, "0")}|${b.kind ?? ""}`,
    ),
  );
}

function buildPlainDefIndex({ root, defIndex }) {
  const out = {};
  for (const [defFile, m] of defIndex) {
    out[relPath(root, defFile)] = Object.fromEntries(m);
  }
  return out;
}

function sortClassMethodRecords(records = []) {
  return [...records].sort((a, b) =>
    `${a.className ?? ""}|${a.name ?? ""}|${String(a.line ?? "").padStart(6, "0")}|${a.identity ?? ""}`.localeCompare(
      `${b.className ?? ""}|${b.name ?? ""}|${String(b.line ?? "").padStart(6, "0")}|${b.identity ?? ""}`,
    ),
  );
}

function buildClassMethodIndex({ root, fileData }) {
  const out = Object.create(null);
  for (const [absFile, info] of fileData) {
    const methods = info.classMethods ?? [];
    if (methods.length === 0) continue;
    const rel = relPath(root, absFile);
    const byName = Object.create(null);
    for (const method of sortClassMethodRecords(methods)) {
      const name = method.name ?? method.methodName;
      if (!name) continue;
      if (!byName[name]) byName[name] = [];
      byName[name].push({
        identity: method.identity ?? `${rel}::${method.className}#${name}`,
        ownerFile: method.ownerFile ?? rel,
        className: method.className,
        name,
        methodName: method.methodName ?? name,
        kind: method.kind ?? "ClassMethod",
        memberKind: method.memberKind ?? "method",
        visibility: method.visibility ?? "public",
        static: method.static === true,
        computed: method.computed === true,
        line: method.line,
        ...(method.endLine ? { endLine: method.endLine } : {}),
      });
    }
    if (Object.keys(byName).length > 0) out[rel] = byName;
  }
  return out;
}

function sortPreWriteLocalOperationRecords(records = []) {
  return [...records].sort((a, b) =>
    `${a.containerName ?? ""}|${a.name ?? ""}|${String(a.line ?? "").padStart(6, "0")}|${a.identity ?? ""}`.localeCompare(
      `${b.containerName ?? ""}|${b.name ?? ""}|${String(b.line ?? "").padStart(6, "0")}|${b.identity ?? ""}`,
    ),
  );
}

function buildPreWriteLocalOperationIndex({ root, fileData }) {
  const byOwnerFile = Object.create(null);
  let operationCount = 0;

  for (const [absFile, info] of fileData) {
    const operations = sortPreWriteLocalOperationRecords(
      info.localOperations ?? [],
    );
    if (operations.length === 0) continue;
    const rel = relPath(root, absFile);
    byOwnerFile[rel] = operations.map((operation) => ({
      identity: operation.identity,
      name: operation.name,
      ownerFile: operation.ownerFile ?? rel,
      containerName: operation.containerName,
      containerKind: operation.containerKind,
      scopeKind: operation.scopeKind ?? "nested-function",
      matchedField: operation.matchedField ?? "preWriteLocalOperationIndex",
      line: operation.line,
      operationFamily: operation.operationFamily,
      domainTokens: [...(operation.domainTokens ?? [])].sort(),
      visibility: operation.visibility ?? "local-only",
      eligibleForDeadExportRanking: false,
      eligibleForSafeFix: false,
    }));
    operationCount += operations.length;
  }

  return {
    schemaVersion: "pre-write-local-operations.v1",
    status: "complete",
    meta: {
      supports: {
        nestedLocalOperationIndex: true,
      },
    },
    byOwnerFile,
    summary: {
      ownerFileCount: Object.keys(byOwnerFile).length,
      operationCount,
    },
  };
}

function sortResolvedInternalEdges(edges) {
  return [...(edges ?? [])].sort((a, b) =>
    `${a.from ?? ""}|${a.to ?? ""}|${a.kind ?? ""}|${a.source ?? ""}|${a.typeOnly ? "1" : "0"}`.localeCompare(
      `${b.from ?? ""}|${b.to ?? ""}|${b.kind ?? ""}|${b.source ?? ""}|${b.typeOnly ? "1" : "0"}`,
    ),
  );
}

function sortGeneratedVirtualSurfaces(surfaces) {
  return [...(surfaces ?? [])]
    .map((surface) => ({
      ...surface,
      exports: [...(surface.exports ?? [])].sort((a, b) =>
        `${a.name ?? ""}|${a.kind ?? ""}`.localeCompare(
          `${b.name ?? ""}|${b.kind ?? ""}`,
        ),
      ),
    }))
    .sort((a, b) => `${a.id ?? ""}`.localeCompare(`${b.id ?? ""}`));
}

function sortGeneratedVirtualImportConsumers(consumers) {
  return [...(consumers ?? [])].sort((a, b) =>
    `${a.consumerFile ?? ""}|${a.specifier ?? ""}|${a.name ?? ""}|${a.kind ?? ""}|${a.surfaceId ?? ""}`.localeCompare(
      `${b.consumerFile ?? ""}|${b.specifier ?? ""}|${b.name ?? ""}|${b.kind ?? ""}|${b.surfaceId ?? ""}`,
    ),
  );
}

function sortGeneratedConsumerBlindZones(zones) {
  return [...(zones ?? [])].sort((a, b) =>
    `${a.scopePackageRoot ?? ""}|${a.candidatePath ?? ""}|${a.specifier ?? ""}|${a.consumerFile ?? ""}`.localeCompare(
      `${b.scopePackageRoot ?? ""}|${b.candidatePath ?? ""}|${b.specifier ?? ""}|${b.consumerFile ?? ""}`,
    ),
  );
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
  resolvedGeneratedVirtualUses = 0,
  nonSourceAssetUses = 0,
  externalUses,
  dependencyImportConsumers,
  resolvedInternalEdges,
  generatedConsumerBlindZones,
  generatedVirtualSurfaces,
  generatedVirtualImportConsumers,
  unresolvedInternalUses,
  mdxConsumerUses,
  sfcScriptConsumerUses = 0,
  sfcScriptSrcReachabilityUses = 0,
  sfcStyleAssetReferenceUses = 0,
  sfcTemplateComponentRefUses = 0,
  sfcGlobalComponentRegistrationUses = 0,
  sfcGeneratedComponentManifestUses = 0,
  sfcFrameworkConventionComponentUses = 0,
  sfcStyleAssetReferences = [],
  sfcTemplateComponentRefs = [],
  sfcGlobalComponentRegistrations = [],
  sfcGeneratedComponentManifests = [],
  sfcFrameworkConventionComponents = [],
  dead,
  trulyDead,
  deadInProd,
  deadInTest,
  symbolFanIn,
  fanInByIdentity,
  fanInByIdentitySpace,
  namespaceReExportDiagnostics = [],
  anyContaminationFacts,
  incremental = null,
}) {
  const artifactWarnings = [...(warnings ?? [])];
  if (parseErrors > 0) {
    artifactWarnings.push({
      code: "parse-errors",
      count: parseErrors,
      message: `${parseErrors} file(s) failed to parse; their defs/uses are missing from the graph`,
    });
  }

  return {
    meta: {
      ...producerMetaBase({ tool: "build-symbol-graph.mjs", root }),
      schemaVersion: 3,
      supports: {
        anyContamination: true,
        identityFanIn: true,
        identityFanInSpace: true,
        reExportRecords: "file-level",
        mdxImportConsumers: true,
        sfcScriptImportConsumers: true,
        sfcScriptSrcReachability: true,
        sfcStyleAssetReferences: true,
        sfcTemplateComponentRefs: true,
        sfcGlobalComponentRegistrations: true,
        sfcGeneratedComponentManifests: true,
        sfcFrameworkConventionComponents: true,
        dependencyImportConsumers: true,
        resolvedInternalEdges: true,
        definitionIds: true,
        unresolvedInternalSummaryByReason: true,
        cjsExportSurface: true,
        cjsRequireOpacity: true,
        generatedConsumerBlindZones: true,
        generatedVirtualSurfaces: true,
        nonSourceAssetImports: true,
        namespaceReExportDiagnostics: true,
        classMethodIndex: true,
        nestedLocalOperationIndex: true,
      },
      languageSupport,
      warnings: artifactWarnings,
      ...(incremental ? { incremental } : {}),
    },
    files: files.length,
    totalDefs: [...defIndex.values()].reduce((a, m) => a + m.size, 0),
    totalClassMethods: [...fileData.values()].reduce(
      (a, info) => a + (info.classMethods?.length ?? 0),
      0,
    ),
    totalPreWriteLocalOperations: [...fileData.values()].reduce(
      (a, info) => a + (info.localOperations?.length ?? 0),
      0,
    ),
    totalUsesResolved: totalUses,
    unresolvedUses,
    uses: {
      resolvedInternal: resolvedInternalUses,
      resolvedGeneratedVirtual: resolvedGeneratedVirtualUses,
      nonSourceAsset: nonSourceAssetUses,
      external: externalUses,
      unresolvedInternal: unresolvedInternalUses,
      mdxConsumers: mdxConsumerUses,
      sfcScriptConsumers: sfcScriptConsumerUses,
      sfcScriptSrcReachability: sfcScriptSrcReachabilityUses,
      sfcStyleAssetReferences: sfcStyleAssetReferenceUses,
      sfcTemplateComponentRefs: sfcTemplateComponentRefUses,
      sfcGlobalComponentRegistrations: sfcGlobalComponentRegistrationUses,
      sfcGeneratedComponentManifests: sfcGeneratedComponentManifestUses,
      sfcFrameworkConventionComponents: sfcFrameworkConventionComponentUses,
      unresolvedInternalRatio:
        resolvedInternalUses + unresolvedInternalUses > 0
          ? +(
              unresolvedInternalUses /
              (resolvedInternalUses + unresolvedInternalUses)
            ).toFixed(4)
          : 0,
    },
    dependencyImportConsumers: [...(dependencyImportConsumers ?? [])].sort(
      (a, b) =>
        `${a.depRoot ?? ""}|${a.fromSpec ?? ""}|${a.file ?? ""}|${a.kind ?? ""}`.localeCompare(
          `${b.depRoot ?? ""}|${b.fromSpec ?? ""}|${b.file ?? ""}|${b.kind ?? ""}`,
        ),
    ),
    resolvedInternalEdges: sortResolvedInternalEdges(resolvedInternalEdges),
    sfcStyleAssetReferences: sortSfcStyleAssetReferences(
      sfcStyleAssetReferences,
    ),
    sfcTemplateComponentRefs: sortSfcTemplateComponentRefs(
      sfcTemplateComponentRefs,
    ),
    sfcGlobalComponentRegistrations: sortSfcGlobalComponentRegistrations(
      sfcGlobalComponentRegistrations,
    ),
    sfcGeneratedComponentManifests: sortSfcGeneratedComponentManifests(
      sfcGeneratedComponentManifests,
    ),
    sfcFrameworkConventionComponents: sortSfcFrameworkConventionComponents(
      sfcFrameworkConventionComponents,
    ),
    generatedConsumerBlindZones: sortGeneratedConsumerBlindZones(
      generatedConsumerBlindZones,
    ),
    generatedVirtualSurfaces: sortGeneratedVirtualSurfaces(
      generatedVirtualSurfaces,
    ),
    generatedVirtualImportConsumers: sortGeneratedVirtualImportConsumers(
      generatedVirtualImportConsumers,
    ),
    topUnresolvedSpecifiers: buildTopUnresolvedSpecifiers({
      unresolvedInternalByPrefix,
      prefixExamples,
    }),
    dynamicImportOpacity: buildDynamicImportOpacity({ root, fileData }),
    cjsExportSurfaceByFile: buildCjsExportSurfaceByFile({ root, fileData }),
    cjsRequireOpacity: buildCjsRequireOpacity({ root, fileData }),
    unresolvedInternalSpecifiers: [...unresolvedInternalSpecifiers].sort(),
    unresolvedInternalSpecifierRecords: [
      ...(unresolvedInternalSpecifierRecords ?? []),
    ].sort((a, b) =>
      `${a.consumerFile ?? ""}|${a.specifier ?? ""}|${a.kind ?? ""}`.localeCompare(
        `${b.consumerFile ?? ""}|${b.specifier ?? ""}|${b.kind ?? ""}`,
      ),
    ),
    unresolvedInternalSummaryByReason: buildUnresolvedInternalSummaryByReason(
      unresolvedInternalSpecifierRecords,
    ),
    filesWithParseErrors: buildFilesWithParseErrors({
      root,
      entries: nextCache.entries,
    }),
    deadTotal: dead.length,
    trulyDead: trulyDead.length,
    deadInProd: deadInProd.length,
    deadInTest: deadInTest.length,
    topSymbolFanIn: symbolFanIn.slice(0, 50),
    fanInByIdentity,
    fanInByIdentitySpace: fanInByIdentitySpace ?? {},
    namespaceReExportDiagnostics: sortNamespaceReExportDiagnostics(
      namespaceReExportDiagnostics,
    ),
    helperOwnersByIdentity: anyContaminationFacts?.helperOwnersByIdentity ?? {},
    typeOwnersByIdentity: anyContaminationFacts?.typeOwnersByIdentity ?? {},
    defIndex: buildPlainDefIndex({ root, defIndex }),
    classMethodIndex: buildClassMethodIndex({ root, fileData }),
    preWriteLocalOperationIndex: buildPreWriteLocalOperationIndex({
      root,
      fileData,
    }),
    deadProdList: deadInProd,
    reExportsByFile: buildReExportsByFile({ root, fileData }),
  };
}
