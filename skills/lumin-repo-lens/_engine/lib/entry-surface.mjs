// PCEF P2 entry surface collector.
//
// This artifact separates "known entry files" from later reachability math.
// It is evidence for module BFS and ranking confidence, not a direct fix
// recommendation.

import path from 'node:path';

import { producerMetaBase } from './artifacts.mjs';
import { buildAliasMap } from './alias-map.mjs';
import { collectFiles } from './collect-files.mjs';
import {
  collectHtmlModuleEntrypoints,
  collectPackagePublicSurfaceFiles,
  collectScriptEntrypoints,
  indexPublicSurfaceEntries,
} from './public-surface.mjs';
import { makeResolver } from './resolver-core.mjs';
import { isResolvedFile } from './resolver-core.mjs';
import { buildSubmoduleResolver } from './paths.mjs';
import {
  ACTION_MUTE,
  classifyFrameworkPolicy,
  createFrameworkPolicyContextForRepo,
  isConfigFile,
} from './classify-policies.mjs';
import { JS_FAMILY_LANGS } from './lang.mjs';

function normalizeRel(relPath) {
  return String(relPath ?? '').replace(/\\/g, '/');
}

function sortedSet(set) {
  return [...set].sort((a, b) => a.localeCompare(b));
}

function sortedEvidenceObject(evidenceByFile) {
  const out = {};
  for (const file of [...evidenceByFile.keys()].sort((a, b) => a.localeCompare(b))) {
    out[file] = [...evidenceByFile.get(file)];
  }
  return out;
}

function sortedRecords(records) {
  return [...(records ?? [])].sort((a, b) =>
    String(a.packageDir ?? a.htmlFile ?? '').localeCompare(String(b.packageDir ?? b.htmlFile ?? '')) ||
    String(a.scriptName ?? '').localeCompare(String(b.scriptName ?? '')) ||
    String(a.reason ?? '').localeCompare(String(b.reason ?? '')) ||
    String(a.src ?? '').localeCompare(String(b.src ?? '')) ||
    String(a.resolvedFile ?? '').localeCompare(String(b.resolvedFile ?? '')));
}

function addEvidenceFile(targetSet, evidenceMap, relPath, evidence) {
  const rel = normalizeRel(relPath);
  targetSet.add(rel);
  if (evidence !== undefined) {
    if (!evidenceMap.has(rel)) evidenceMap.set(rel, []);
    evidenceMap.get(rel).push(evidence);
  }
}

function addFileVariants(targetSet, evidenceMap, relPath, evidence) {
  const rel = normalizeRel(relPath);
  const variants = new Set([rel]);
  if (/\.tsx$/.test(rel)) variants.add(rel.replace(/\.tsx$/, '.jsx'));
  else if (/\.jsx$/.test(rel)) variants.add(rel.replace(/\.jsx$/, '.tsx'));
  else if (/\.ts$/.test(rel) && !/\.d\.[cm]?ts$/.test(rel)) {
    variants.add(rel.replace(/\.ts$/, '.js'));
  } else if (/\.js$/.test(rel)) {
    variants.add(rel.replace(/\.js$/, '.ts'));
  }
  for (const variant of variants) addEvidenceFile(targetSet, evidenceMap, variant, evidence);
}

function collectKnownFiles({ root, symbolsData, includeTests, exclude }) {
  const files = new Set();
  try {
    for (const file of collectFiles(root, {
      includeTests,
      exclude,
      languages: JS_FAMILY_LANGS,
    })) {
      files.add(path.relative(root, file).replace(/\\/g, '/'));
    }
  } catch {
    // Entry surface is advisory evidence. If walking fails, keep going with
    // files already visible in symbols.json.
  }

  for (const file of Object.keys(symbolsData?.defIndex ?? {})) files.add(normalizeRel(file));
  for (const file of Object.keys(symbolsData?.reExportsByFile ?? {})) files.add(normalizeRel(file));
  for (const edge of symbolsData?.resolvedInternalEdges ?? []) {
    if (edge?.from) files.add(normalizeRel(edge.from));
    if (edge?.to) files.add(normalizeRel(edge.to));
  }

  return [...files].sort((a, b) => a.localeCompare(b));
}

function addIndexedEntries(indexedEntries, targetSet, evidenceByFile) {
  for (const [rel, evidence] of indexedEntries) {
    for (const item of evidence) addFileVariants(targetSet, evidenceByFile, rel, item);
  }
}

function addConcreteIndexedEntries(indexedEntries, targetSet, evidenceByFile) {
  for (const [rel, evidence] of indexedEntries) {
    for (const item of evidence) addEvidenceFile(targetSet, evidenceByFile, rel, item);
  }
}

function collectPublicApi({ root, repoMode, symbolsData, aliasMap, resolve }) {
  const files = new Set();
  const evidenceByFile = new Map();
  const addPublicApiVariants = (relPath, evidence) =>
    addFileVariants(files, evidenceByFile, relPath, evidence);

  addIndexedEntries(
    indexPublicSurfaceEntries(collectPackagePublicSurfaceFiles({ root, repoMode })),
    files,
    evidenceByFile,
  );

  for (const [spec, entry] of aliasMap) {
    if (typeof spec === 'string' && spec.startsWith('#')) continue;
    if (entry.source === 'imports') continue;
    if (entry.type === 'exact' && entry.path) {
      const rel = path.relative(root, entry.path).replace(/\\/g, '/');
      addPublicApiVariants(rel, {
        source: 'alias-map.exact',
        aliasSource: entry.source ?? null,
        resolvedFile: rel,
      });
    }
  }

  let transitiveAdded = 0;
  const reExportsByFile = symbolsData?.reExportsByFile ?? {};
  if (files.size > 0 && Object.keys(reExportsByFile).length > 0) {
    const visited = new Set();
    const queue = [...files].filter((p) => reExportsByFile[p] !== undefined || files.has(p));
    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      const reExports = reExportsByFile[current];
      if (!reExports) continue;
      for (const r of reExports) {
        if (!r.source) continue;
        const resolved = resolve(path.join(root, current), r.source);
        if (!isResolvedFile(resolved)) continue;
        const rel = path.relative(root, resolved).replace(/\\/g, '/');
        if (!files.has(rel)) {
          addPublicApiVariants(rel, {
            source: 'public-reexport',
            fromFile: current,
            specifier: r.source,
            resolvedFile: rel,
          });
          transitiveAdded++;
        }
        if (!visited.has(rel)) queue.push(rel);
      }
    }
  }

  return { files, evidenceByFile, transitiveAdded };
}

function collectScriptEntries({ root, repoMode }) {
  const files = new Set();
  const evidenceByFile = new Map();
  const script = collectScriptEntrypoints({ root, repoMode });
  addIndexedEntries(
    indexPublicSurfaceEntries(script.entries),
    files,
    evidenceByFile,
  );
  return {
    files,
    evidenceByFile,
    unsupported: script.unsupported,
    unsupportedRawCount: script.unsupportedRawCount,
    unsupportedSampleLimit: script.unsupportedSampleLimit,
  };
}

function collectHtmlEntries({ root, repoMode, includeTests, exclude }) {
  const files = new Set();
  const evidenceByFile = new Map();
  const html = collectHtmlModuleEntrypoints({ root, repoMode, includeTests, exclude });
  addConcreteIndexedEntries(
    indexPublicSurfaceEntries(html.entries),
    files,
    evidenceByFile,
  );
  return { files, evidenceByFile, unresolved: html.unresolved };
}

function collectConfigEntries({ knownFiles }) {
  const files = new Set();
  const evidenceByFile = new Map();
  for (const file of knownFiles) {
    if (!isConfigFile(file)) continue;
    addEvidenceFile(files, evidenceByFile, file, { source: 'config-file-convention' });
  }
  return { files, evidenceByFile };
}

function collectFrameworkEntries({ root, repoMode, symbolsData, includeTests, exclude, knownFiles }) {
  const files = new Set();
  const evidenceByFile = new Map();
  const context = createFrameworkPolicyContextForRepo({
    root,
    repoMode,
    symbolsData,
    deadList: [],
    includeTests,
    exclude,
  });

  for (const file of knownFiles) {
    const defs = symbolsData?.defIndex?.[file] ?? {};
    const exportNames = Object.keys(defs);
    const candidates = exportNames.length > 0 ? exportNames : ['default'];
    for (const exportName of candidates) {
      const decision = classifyFrameworkPolicy(context, { file, exportName });
      if (decision.action !== ACTION_MUTE) continue;
      addEvidenceFile(files, evidenceByFile, file, {
        source: 'framework-policy',
        framework: decision.framework,
        ruleId: decision.ruleId,
        reason: decision.reason,
        evidence: decision.evidence ?? null,
      });
      break;
    }
  }

  return { files, evidenceByFile };
}

function mergeEvidenceMaps(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [file, evidence] of map) {
      if (!merged.has(file)) merged.set(file, []);
      merged.get(file).push(...evidence);
    }
  }
  return merged;
}

function completenessLabels({ entryFiles, knownFiles, symbolsData, submoduleOf, limitations = [] }) {
  const parseErrors = (symbolsData?.meta?.warnings ?? [])
    .filter((w) => w?.code === 'parse-errors' || w?.kind === 'parse-errors' || w?.type === 'parse-errors')
    .reduce((sum, w) => sum + (Number(w?.count) || 0), 0);
  const globalCompleteness = parseErrors > 0 || limitations.length > 0 ? 'medium' : 'high';
  const submodules = new Set([
    ...knownFiles.map(submoduleOf),
    ...entryFiles.map(submoduleOf),
  ]);
  const completenessBySubmodule = {};
  for (const submodule of [...submodules].sort((a, b) => a.localeCompare(b))) {
    completenessBySubmodule[submodule] = globalCompleteness;
  }
  return { globalCompleteness, completenessBySubmodule };
}

export function buildEntrySurfaceArtifact({
  root,
  repoMode,
  symbolsData,
  includeTests = true,
  exclude = [],
}) {
  const aliasMap = buildAliasMap(root, repoMode, { exclude });
  const resolve = makeResolver(root, aliasMap);
  const submoduleOf = buildSubmoduleResolver(root, repoMode);
  const knownFiles = collectKnownFiles({ root, symbolsData, includeTests, exclude });

  const publicApi = collectPublicApi({ root, repoMode, symbolsData, aliasMap, resolve });
  const script = collectScriptEntries({ root, repoMode });
  const html = collectHtmlEntries({ root, repoMode, includeTests, exclude });
  const framework = collectFrameworkEntries({ root, repoMode, symbolsData, includeTests, exclude, knownFiles });
  const config = collectConfigEntries({ knownFiles });

  const entryFiles = sortedSet(new Set([
    ...publicApi.files,
    ...script.files,
    ...html.files,
    ...framework.files,
    ...config.files,
  ]));
  const evidenceByFile = mergeEvidenceMaps(
    publicApi.evidenceByFile,
    script.evidenceByFile,
    html.evidenceByFile,
    framework.evidenceByFile,
    config.evidenceByFile,
  );
  const unresolvedHtmlEntrypoints = sortedRecords(html.unresolved);
  const unsupportedScriptEntrypoints = sortedRecords(script.unsupported);
  const { globalCompleteness, completenessBySubmodule } =
    completenessLabels({
      entryFiles,
      knownFiles,
      symbolsData,
      submoduleOf,
      limitations: unresolvedHtmlEntrypoints,
    });

  return {
    meta: {
      ...producerMetaBase({ tool: 'build-entry-surface.mjs', root }),
      schemaVersion: 'entry-surface.v1',
      supports: {
        publicApiFiles: true,
        scriptEntrypointFiles: true,
        unsupportedScriptEntrypoints: true,
        htmlEntrypointFiles: true,
        unresolvedHtmlEntrypoints: true,
        frameworkEntrypointFiles: true,
        configEntrypointFiles: true,
        submoduleCompleteness: true,
      },
      includeTests,
      transitivePublicReexports: publicApi.transitiveAdded,
      knownFileCount: knownFiles.length,
    },
    publicApiFiles: sortedSet(publicApi.files),
    scriptEntrypointFiles: sortedSet(script.files),
    unsupportedScriptEntrypointCount: script.unsupportedRawCount,
    unsupportedScriptEntrypointSampleLimit: script.unsupportedSampleLimit,
    unsupportedScriptEntrypoints,
    htmlEntrypointFiles: sortedSet(html.files),
    unresolvedHtmlEntrypoints,
    frameworkEntrypointFiles: sortedSet(framework.files),
    configEntrypointFiles: sortedSet(config.files),
    entryFiles,
    evidenceByFile: sortedEvidenceObject(evidenceByFile),
    globalCompleteness,
    completenessBySubmodule,
  };
}
