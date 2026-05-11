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

function buildReverseAdjacency(nodes, adjacency) {
  const nodeSet = new Set(nodes);
  const reverse = new Map(nodes.map((node) => [node, []]));
  for (const from of nodes) {
    for (const to of adjacency.get(from) ?? []) {
      if (!nodeSet.has(to)) continue;
      reverse.get(to).push(from);
    }
  }
  for (const [node, targets] of reverse) {
    reverse.set(node, [...new Set(targets)].sort((a, b) => a.localeCompare(b)));
  }
  return reverse;
}

function finishOrder(nodes, adjacency) {
  const visited = new Set();
  const order = [];

  for (const start of nodes) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack = [{ node: start, nextIndex: 0 }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const targets = adjacency.get(frame.node) ?? [];
      if (frame.nextIndex >= targets.length) {
        order.push(frame.node);
        stack.pop();
        continue;
      }

      const next = targets[frame.nextIndex];
      frame.nextIndex++;
      if (visited.has(next)) continue;
      visited.add(next);
      stack.push({ node: next, nextIndex: 0 });
    }
  }

  return order;
}

function stronglyConnectedComponents(nodesInput, adjacency) {
  const nodes = sortedSet(nodesInput);
  const nodeSet = new Set(nodes);
  const normalizedAdjacency = new Map();
  for (const node of nodes) {
    normalizedAdjacency.set(
      node,
      (adjacency.get(node) ?? [])
        .filter((target) => nodeSet.has(target))
        .sort((a, b) => a.localeCompare(b))
    );
  }

  const reverse = buildReverseAdjacency(nodes, normalizedAdjacency);
  const order = finishOrder(nodes, normalizedAdjacency);
  const assigned = new Set();
  const components = [];

  for (let i = order.length - 1; i >= 0; i--) {
    const start = order[i];
    if (assigned.has(start)) continue;
    const component = [];
    const stack = [start];
    assigned.add(start);

    while (stack.length > 0) {
      const node = stack.pop();
      component.push(node);
      for (const next of reverse.get(node) ?? []) {
        if (assigned.has(next)) continue;
        assigned.add(next);
        stack.push(next);
      }
    }

    component.sort((a, b) => a.localeCompare(b));
    components.push(component);
  }

  return components.sort((a, b) =>
    b.length - a.length ||
    (a[0] ?? '').localeCompare(b[0] ?? '')
  );
}

function unreachableRuntimeSccs({ knownFiles, runtimeGraph, unreachableFiles, boundedOutReason }) {
  if (boundedOutReason) return [];
  return stronglyConnectedComponents(knownFiles, runtimeGraph)
    .filter((files) => files.length > 1 && files.every((file) => unreachableFiles.has(file)))
    .map((files) => ({
      kind: 'entry-unreachable-scc',
      graph: 'runtime',
      size: files.length,
      files,
      note: 'Files import each other, but none are reachable from the recorded entry surface.',
    }));
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

  const unreachableStronglyConnectedComponents = unreachableRuntimeSccs({
    knownFiles,
    runtimeGraph,
    unreachableFiles,
    boundedOutReason,
  });
  const unreachableStronglyConnectedFiles = unreachableStronglyConnectedComponents
    .reduce((sum, component) => sum + component.size, 0);

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
        unreachableStronglyConnectedComponents: true,
      },
    },
    runtimeReachableFiles: sortedSet(runtimeReachableFiles),
    typeReachableFiles: sortedSet(typeReachableFiles),
    reachableFiles: sortedSet(reachableFiles),
    boundedOutFiles: sortedSet(boundedOutFiles),
    unreachableFiles: sortedSet(unreachableFiles),
    unreachableStronglyConnectedComponents,
    summary: {
      runtimeReachable: runtimeReachableFiles.size,
      typeReachable: typeReachableFiles.size,
      reachable: reachableFiles.size,
      boundedOut: boundedOutFiles.size,
      unreachable: unreachableFiles.size,
      unreachableStronglyConnectedComponents: unreachableStronglyConnectedComponents.length,
      unreachableStronglyConnectedFiles,
      knownFiles: knownFiles.size,
    },
  };
}
