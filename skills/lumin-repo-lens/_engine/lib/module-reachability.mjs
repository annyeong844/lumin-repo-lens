// PCEF P2 module reachability artifact.
//
// This is a file-level confidence booster. It does not mark exports dead by
// itself; it only records which files are reachable from known entry surfaces
// through resolved internal edges.

import { producerMetaBase } from './artifacts.mjs';

const DEFAULT_MAX_FILES_VISITED = 200000;
const DEFAULT_MAX_EDGES_VISITED = 400000;

function normalizeRel(file) {
  return String(file ?? '').replace(/\\/g, '/');
}

function sortedSet(set) {
  return [...set].sort((a, b) => a.localeCompare(b));
}

function collectKnownFiles({ symbolsData, entrySurface }) {
  const files = new Set();

  for (const file of Object.keys(symbolsData?.defIndex ?? {})) files.add(normalizeRel(file));
  for (const file of Object.keys(symbolsData?.reExportsByFile ?? {})) files.add(normalizeRel(file));
  for (const file of entrySurface?.entryFiles ?? []) files.add(normalizeRel(file));
  for (const edge of symbolsData?.resolvedInternalEdges ?? []) {
    if (edge?.from) files.add(normalizeRel(edge.from));
    if (edge?.to) files.add(normalizeRel(edge.to));
  }

  return files;
}

function buildAdjacency(edges, { includeTypeOnly }) {
  const adjacency = new Map();
  for (const edge of edges ?? []) {
    const from = normalizeRel(edge?.from);
    const to = normalizeRel(edge?.to);
    if (!from || !to) continue;
    if (!includeTypeOnly && edge?.typeOnly === true) continue;
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push(to);
  }
  for (const [from, targets] of adjacency) {
    adjacency.set(from, [...new Set(targets)].sort((a, b) => a.localeCompare(b)));
  }
  return adjacency;
}

function bfsReachable({ seeds, adjacency, maxFilesVisited, maxEdgesVisited }) {
  const visited = new Set();
  const queue = [];
  let edgesVisited = 0;
  let boundedOutReason = null;

  for (const seed of seeds) {
    const rel = normalizeRel(seed);
    if (!rel || visited.has(rel)) continue;
    if (visited.size >= maxFilesVisited) {
      boundedOutReason = 'max-files-visited';
      break;
    }
    visited.add(rel);
    queue.push(rel);
  }

  while (queue.length && !boundedOutReason) {
    const current = queue.shift();
    for (const next of adjacency.get(current) ?? []) {
      edgesVisited++;
      if (edgesVisited > maxEdgesVisited) {
        boundedOutReason = 'max-edges-visited';
        break;
      }
      if (visited.has(next)) continue;
      if (visited.size >= maxFilesVisited) {
        boundedOutReason = 'max-files-visited';
        break;
      }
      visited.add(next);
      queue.push(next);
    }
  }

  return { visited, boundedOutReason };
}

export function buildModuleReachabilityArtifact({
  root,
  symbolsData,
  entrySurface,
  maxFilesVisited = DEFAULT_MAX_FILES_VISITED,
  maxEdgesVisited = DEFAULT_MAX_EDGES_VISITED,
}) {
  const knownFiles = collectKnownFiles({ symbolsData, entrySurface });
  const entryFiles = new Set((entrySurface?.entryFiles ?? []).map(normalizeRel));
  const edges = symbolsData?.resolvedInternalEdges ?? [];

  const runtimeGraph = buildAdjacency(edges, { includeTypeOnly: false });
  const allGraph = buildAdjacency(edges, { includeTypeOnly: true });
  const runtime = bfsReachable({
    seeds: entryFiles,
    adjacency: runtimeGraph,
    maxFilesVisited,
    maxEdgesVisited,
  });
  const type = bfsReachable({
    seeds: entryFiles,
    adjacency: allGraph,
    maxFilesVisited,
    maxEdgesVisited,
  });

  const boundedOutReason = runtime.boundedOutReason ?? type.boundedOutReason;
  const runtimeReachableFiles = runtime.visited;
  const typeReachableFiles = type.visited;
  const reachableFiles = new Set([...runtimeReachableFiles, ...typeReachableFiles]);
  const boundedOutFiles = new Set();
  const unreachableFiles = new Set();

  for (const file of knownFiles) {
    if (reachableFiles.has(file)) continue;
    if (boundedOutReason) boundedOutFiles.add(file);
    else unreachableFiles.add(file);
  }

  return {
    meta: {
      ...producerMetaBase({ tool: 'build-module-reachability.mjs', root }),
      schemaVersion: 'module-reachability.v1',
      mode: 'full-bfs',
      entrySurfaceFile: 'entry-surface.json',
      globalCompleteness: entrySurface?.globalCompleteness ?? 'low',
      completenessBySubmodule: entrySurface?.completenessBySubmodule ?? {},
      maxFilesVisited,
      maxEdgesVisited,
      boundedOutReason,
      supports: {
        runtimeReachableFiles: true,
        typeReachableFiles: true,
        boundedOutFiles: true,
      },
    },
    runtimeReachableFiles: sortedSet(runtimeReachableFiles),
    typeReachableFiles: sortedSet(typeReachableFiles),
    reachableFiles: sortedSet(reachableFiles),
    boundedOutFiles: sortedSet(boundedOutFiles),
    unreachableFiles: sortedSet(unreachableFiles),
    summary: {
      runtimeReachable: runtimeReachableFiles.size,
      typeReachable: typeReachableFiles.size,
      reachable: reachableFiles.size,
      boundedOut: boundedOutFiles.size,
      unreachable: unreachableFiles.size,
      knownFiles: knownFiles.size,
    },
  };
}
