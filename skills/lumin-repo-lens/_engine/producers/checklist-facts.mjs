#!/usr/bin/env node
// checklist-facts.mjs — pre-compute the automatable half of
// templates/REVIEW_CHECKLIST.md into a single JSON artifact
// (`checklist-facts.json`). When Claude walks the checklist, items
// backed by this file land pre-labeled `[grounded]`; remaining items
// are explicitly enumerated in `_not_computed` so they can't be
// silently skipped.
//
// Reads pipeline artifacts when present (topology.json,
// dead-classify.json, fix-plan.json, barrels.json, triage.json) and
// does a fresh oxc AST pass for items needing function-level
// granularity (A2 function size, E2 silent catch).
//
// Usage: node checklist-facts.mjs --root <repo> --output <dir>
//
// This is NOT a replacement for the checklist walk — it's grounded
// input that makes the walk faster and verifiable. Anything the
// script doesn't cover is still in scope for the LLM, labeled with
// `[확인 불가]` if it can't reason from other evidence.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseCliArgs } from '../lib/cli.mjs';
import { loadIfExists } from '../lib/artifacts.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { JS_FAMILY_LANGS } from '../lib/lang.mjs';
import { relPath } from '../lib/paths.mjs';
import { parseOxcOrThrow } from '../lib/parse-oxc.mjs';
import { computeLineStarts, lineOf } from '../lib/line-offset.mjs';
import { classifyFileRole } from '../lib/test-paths.mjs';

const cli = parseCliArgs();
const { root: ROOT, output: OUT, verbose } = cli;

// Pipeline artifacts (optional — we degrade per-item with `available:
// false` when an input is missing, never crash).
const topology     = loadIfExists(OUT, 'topology.json',     { tag: 'checklist-facts' });
const deadClassify = loadIfExists(OUT, 'dead-classify.json',{ tag: 'checklist-facts' });
const fixPlan      = loadIfExists(OUT, 'fix-plan.json',     { tag: 'checklist-facts' });
const barrels      = loadIfExists(OUT, 'barrels.json',      { tag: 'checklist-facts' });
const triage       = loadIfExists(OUT, 'triage.json',       { tag: 'checklist-facts' });
const shapeIndex   = loadIfExists(OUT, 'shape-index.json',  { tag: 'checklist-facts' });
const functionClones = loadIfExists(OUT, 'function-clones.json', { tag: 'checklist-facts' });

// Fresh AST pass for function-level items — we need start/end line
// spans per function node, which no existing artifact emits.
const files = collectFiles(ROOT, {
  languages: JS_FAMILY_LANGS,
  includeTests: cli.includeTests,
  exclude: cli.exclude,
});

if (verbose) console.error(`[checklist-facts] scanning ${files.length} files`);

// ─── A2: function size distribution ──────────────────────────
//
// Gate bands match templates/REVIEW_CHECKLIST.md A2:
//   >150 LOC in one function   → ❌ fix
//   100-150 LOC                → ⚠ watch
//   <100 LOC                   → ✅ healthy
//
// "Anonymous" names are resolved through the enclosing
// VariableDeclarator / Property / MethodDefinition when possible —
// a report that only lists `<anonymous>` would be un-actionable.

function isFunctionNode(n) {
  return n.type === 'FunctionDeclaration' ||
         n.type === 'FunctionExpression' ||
         n.type === 'ArrowFunctionExpression';
}

function getFnName(node, parent, _key) {
  if (node.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') {
    return parent.id.name;
  }
  if (parent?.type === 'Property' && parent.key?.name) return parent.key.name;
  if ((parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition' ||
       parent?.type === 'AccessorProperty') && parent.key?.name) {
    return parent.key.name;
  }
  if (parent?.type === 'AssignmentExpression' && parent.left?.type === 'Identifier') {
    return parent.left.name;
  }
  return '<anonymous>';
}

function a2FunctionSize() {
  const oversized = [];
  const watch = [];
  const buckets = { big: 0, medium: 0, small: 0 };
  const roleBuckets = {
    production: { big: 0, medium: 0, small: 0, total: 0 },
    test: { big: 0, medium: 0, small: 0, total: 0 },
    script: { big: 0, medium: 0, small: 0, total: 0 },
  };
  const allLoc = [];
  let parseErrors = 0;

  for (const file of files) {
    let src, result;
    try {
      src = readFileSync(file, 'utf8');
      result = parseOxcOrThrow(file, src);
    } catch {
      parseErrors++;
      continue;
    }
    const lineStarts = computeLineStarts(src);

    function walk(node, parent, parentKey) {
      if (!node || typeof node !== 'object') return;
      if (isFunctionNode(node)) {
        const startLine = lineOf(lineStarts, node.start ?? 0);
        const endLine = lineOf(lineStarts, node.end ?? 0);
        const loc = Math.max(1, endLine - startLine + 1);
        allLoc.push(loc);
        const relativeFile = relPath(ROOT, file);
        const fileRole = classifyFileRole(relativeFile);
        const entry = {
          file: relativeFile,
          line: startLine,
          name: getFnName(node, parent, parentKey),
          loc,
          fileRole,
        };
        roleBuckets[fileRole].total++;
        if (loc > 150) {
          buckets.big++;
          roleBuckets[fileRole].big++;
          oversized.push(entry);
        } else if (loc > 100) {
          buckets.medium++;
          roleBuckets[fileRole].medium++;
          watch.push(entry);
        } else {
          buckets.small++;
          roleBuckets[fileRole].small++;
        }
      }
      for (const k of Object.keys(node)) {
        if (k === 'type' || k === 'start' || k === 'end' ||
            k === 'loc' || k === 'range' || k === 'parent') continue;
        const v = node[k];
        if (Array.isArray(v)) {
          for (const c of v) {
            if (c && typeof c === 'object' && typeof c.type === 'string') walk(c, node, k);
          }
        } else if (v && typeof v === 'object' && typeof v.type === 'string') {
          walk(v, node, k);
        }
      }
    }
    walk(result.program, null, null);
  }

  allLoc.sort((a, b) => a - b);
  const p95 = allLoc.length > 0 ? allLoc[Math.floor(allLoc.length * 0.95)] : 0;
  const gate = buckets.big >= 3 ? 'fix' : buckets.big >= 1 ? 'watch' : 'ok';
  const sortByLoc = (items) => items.sort((a, b) => b.loc - a.loc);
  const sortedOversized = sortByLoc(oversized);
  const sortedWatch = sortByLoc(watch);
  const byRole = (items) => ({
    production: items.filter((x) => x.fileRole === 'production').slice(0, 10),
    test: items.filter((x) => x.fileRole === 'test').slice(0, 10),
    script: items.filter((x) => x.fileRole === 'script').slice(0, 10),
  });

  return {
    gate,
    buckets,
    roleBuckets,
    p95Loc: p95,
    total: allLoc.length,
    parseErrors,
    oversized: sortedOversized.slice(0, 20),
    watch: sortedWatch.slice(0, 20),
    oversizedByRole: byRole(sortedOversized),
    watchByRole: byRole(sortedWatch),
  };
}

// ─── A5: decoupling ratio (cross-submodule edges / total) ────
//
// Prefer the full structured edge list when the topology producer emits it.
// `crossSubmoduleTop` is a display fallback only. A high ratio can be healthy
// in a layered tool repo (root CLIs/tests/scripts → _lib engine), so those
// intentionally layered edges are separated before applying the gate.

function normalizeCrossSubmoduleEdges(topologyArtifact) {
  if (Array.isArray(topologyArtifact.crossSubmoduleEdges)) {
    return {
      source: 'full-list',
      edges: topologyArtifact.crossSubmoduleEdges
        .filter((e) => typeof e.from === 'string' && typeof e.to === 'string')
        .map((e) => ({ from: e.from, to: e.to, count: Number(e.count) || 0 })),
    };
  }
  if (Array.isArray(topologyArtifact.crossSubmoduleTop)) {
    return {
      source: 'top-30',
      edges: topologyArtifact.crossSubmoduleTop
        .map((e) => {
          const edge = typeof e.edge === 'string' ? e.edge : '';
          const arrow = edge.indexOf(' → ');
          if (arrow < 0) return null;
          return {
            from: edge.slice(0, arrow),
            to: edge.slice(arrow + 3),
            count: Number(e.count) || 0,
          };
        })
        .filter(Boolean),
    };
  }
  return { source: 'absent', edges: [] };
}

function isHealthyLayeredCrossEdge(edge) {
  if (edge.to === '_lib' && ['root', 'scripts', 'tests'].includes(edge.from)) return true;
  return edge.from === 'tests' && edge.to !== 'tests' && edge.to !== 'root';
}

function a5DecouplingRatio() {
  if (!topology?.summary) return { gate: 'unknown', available: false,
    reason: 'topology.json missing — run measure-topology.mjs first' };
  const total = topology.summary.internalEdges ?? 0;
  const normalized = normalizeCrossSubmoduleEdges(topology);
  const edges = normalized.edges;
  const crossSum = edges.reduce((acc, e) => acc + e.count, 0);
  const layeredSum = edges
    .filter(isHealthyLayeredCrossEdge)
    .reduce((acc, e) => acc + e.count, 0);
  const reviewedSum = crossSum - layeredSum;
  const ratio = total > 0 ? crossSum / total : 0;
  const rawGate = ratio > 0.5 ? 'fix' : ratio > 0.3 ? 'watch' : 'ok';
  const gate = rawGate !== 'ok' && crossSum > 0 && reviewedSum === 0 ? 'ok' : rawGate;
  return {
    gate,
    rawGate,
    crossSubmoduleEdgeSource: normalized.source,
    crossSubmoduleEdgesSum: crossSum,
    crossSubmoduleEdgesTop30Sum: normalized.source === 'top-30' ? crossSum : null,
    healthyLayeredEdgesSum: layeredSum,
    reviewedEdgesSum: reviewedSum,
    totalInternalEdges: total,
    ratioLowerBound: +ratio.toFixed(3),
    topCrossSubmoduleEdges: edges
      .slice()
      .sort((a, b) => (b.count - a.count) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
      .slice(0, 10),
    note: normalized.source === 'full-list'
      ? 'ratio is exact from topology.json.crossSubmoduleEdges. Healthy layered flows (root/scripts/tests → _lib, tests → production) are visible but do not trip the gate by themselves.'
      : 'ratio is a LOWER bound from topology.json.crossSubmoduleTop; the true ratio may be slightly higher.',
  };
}

// ─── A6: circular dependencies ───────────────────────────────

function a6Cycles() {
  if (!topology?.sccs) return { gate: 'unknown', available: false,
    reason: 'topology.json missing' };
  const nontrivial = topology.sccs.filter((s) => (s.size ?? 0) >= 2);
  const gate = nontrivial.length > 0 ? 'fix' : 'ok';
  return {
    gate,
    sccCount: topology.summary?.sccCount ?? nontrivial.length,
    maxSccSize: topology.summary?.maxSccSize ?? 0,
    lens: topology.summary?.lens ?? 'unknown',
    topSccs: nontrivial.slice(0, 5),
  };
}

// ─── B3: dead-code count ─────────────────────────────────────

function b3DeadCode() {
  if (!fixPlan?.summary) return { gate: 'unknown', available: false,
    reason: 'fix-plan.json missing — run rank-fixes.mjs after classify-dead-exports.mjs' };
  const s = fixPlan.summary;
  const gate = s.SAFE_FIX >= 10 ? 'fix' : s.SAFE_FIX > 0 ? 'watch' : 'ok';
  return {
    gate,
    safeFix: s.SAFE_FIX,
    reviewFix: s.REVIEW_FIX,
    degraded: s.DEGRADED,
    muted: s.MUTED,
    total: s.total,
  };
}

// ─── B1/B2: exact exported type-shape drift ─────────────────
//
// This is deliberately an observation, not a verdict. shape-index.json
// supports exact exported interface/object-type shape matches only; it
// cannot prove broader duplicate implementation or "almost same" domain
// drift. Therefore the strongest gate here is `watch`.

function summarizeShapeGroup(hash, identities, factsByIdentity) {
  const members = identities
    .map((identity) => factsByIdentity.get(identity))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.ownerFile !== b.ownerFile) return a.ownerFile < b.ownerFile ? -1 : 1;
      return a.exportedName < b.exportedName ? -1 : (a.exportedName > b.exportedName ? 1 : 0);
    });
  const ownerFiles = [...new Set(members.map((m) => m.ownerFile))].sort();
  const exportedNames = [...new Set(members.map((m) => m.exportedName))].sort();
  const generatedMembers = members.filter((m) => m.generatedFile).length;
  const fields = Array.isArray(members[0]?.fields)
    ? members[0].fields.map((f) => f.name).filter(Boolean)
    : [];
  return {
    hash,
    size: members.length,
    ownerFiles,
    exportedNames,
    generatedMembers,
    generatedOnly: generatedMembers === members.length,
    fieldNames: fields,
    identities: members.map((m) => m.identity),
  };
}

const SHAPE_NAME_STOP_TOKENS = new Set([
  'type', 'types', 'interface', 'interfaces', 'model', 'models',
  'state', 'view', 'data', 'dto', 'payload', 'props', 'options',
  'config', 'request', 'response', 'result', 'event', 'item',
]);

function shapeFieldNames(fact) {
  return Array.isArray(fact?.fields)
    ? [...new Set(fact.fields.map((f) => f?.name).filter(Boolean))].sort()
    : [];
}

function tokenizeShapeName(name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !SHAPE_NAME_STOP_TOKENS.has(token));
}

function ownerDir(file) {
  const dir = path.posix.dirname(String(file ?? '').replace(/\\/g, '/'));
  return dir === '.' ? '' : dir;
}

function setIntersection(a, b) {
  const bs = new Set(b);
  return a.filter((item) => bs.has(item));
}

function setDiff(a, b) {
  const bs = new Set(b);
  return a.filter((item) => !bs.has(item));
}

function jaccard(a, b) {
  const as = new Set(a);
  const bs = new Set(b);
  const union = new Set([...as, ...bs]);
  if (union.size === 0) return 0;
  let inter = 0;
  for (const item of as) if (bs.has(item)) inter++;
  return inter / union.size;
}

function sameHashPair(a, b) {
  return typeof a?.hash === 'string' && a.hash === b?.hash;
}

function summarizeNearShapeCandidate(a, b) {
  const aFields = shapeFieldNames(a);
  const bFields = shapeFieldNames(b);
  const sharedFields = setIntersection(aFields, bFields);
  if (sameHashPair(a, b) || sharedFields.length < 2) return null;

  const fieldJaccard = jaccard(aFields, bFields);
  const aNameTokens = tokenizeShapeName(a.exportedName);
  const bNameTokens = tokenizeShapeName(b.exportedName);
  const sharedNameTokens = setIntersection(aNameTokens, bNameTokens);
  const nameTokenJaccard = jaccard(aNameTokens, bNameTokens);
  const sameDirectory = ownerDir(a.ownerFile) === ownerDir(b.ownerFile);
  const domainCue = sameDirectory || sharedNameTokens.length > 0;
  if (!domainCue) return null;

  const nearlySameFields = fieldJaccard >= 0.5 && sharedFields.length >= 2;
  const sameNamedConcept = sharedNameTokens.length >= 1 && fieldJaccard >= 0.4;
  if (!nearlySameFields && !sameNamedConcept) return null;

  const score = Number((
    (fieldJaccard * 0.75) +
    (nameTokenJaccard * 0.2) +
    (sameDirectory ? 0.05 : 0)
  ).toFixed(3));

  return {
    score,
    fieldJaccard: Number(fieldJaccard.toFixed(3)),
    nameTokenJaccard: Number(nameTokenJaccard.toFixed(3)),
    sameDirectory,
    identities: [a.identity, b.identity],
    ownerFiles: [a.ownerFile, b.ownerFile],
    exportedNames: [a.exportedName, b.exportedName],
    sharedFieldNames: sharedFields,
    leftOnlyFieldNames: setDiff(aFields, bFields),
    rightOnlyFieldNames: setDiff(bFields, aFields),
    sharedNameTokens,
    reason: 'near exported type-shape review cue only; field/name overlap is not proof of duplication',
  };
}

function collectNearShapeCandidates(facts) {
  const usable = facts
    .filter((f) =>
      typeof f?.identity === 'string' &&
      !f.generatedFile &&
      shapeFieldNames(f).length >= 2)
    .sort((a, b) => a.identity.localeCompare(b.identity));
  const candidates = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const candidate = summarizeNearShapeCandidate(usable[i], usable[j]);
      if (candidate) candidates.push(candidate);
    }
  }
  candidates.sort((a, b) =>
    b.score - a.score ||
    b.fieldJaccard - a.fieldJaccard ||
    a.identities.join('|').localeCompare(b.identities.join('|')));
  return candidates.slice(0, 20);
}

function b1b2ShapeDrift() {
  if (!shapeIndex) {
    return {
      gate: 'unknown',
      available: false,
      reason: 'shape-index.json missing — run full profile or build-shape-index.mjs first',
    };
  }

  const facts = Array.isArray(shapeIndex.facts) ? shapeIndex.facts : [];
  const factsByIdentity = new Map(
    facts
      .filter((f) => typeof f?.identity === 'string')
      .map((f) => [f.identity, f])
  );

  const groups = [];
  for (const [hash, identities] of Object.entries(shapeIndex.groupsByHash ?? {})) {
    if (!Array.isArray(identities) || identities.length < 2) continue;
    const group = summarizeShapeGroup(hash, identities, factsByIdentity);
    if (group.size >= 2) groups.push(group);
  }

  groups.sort((a, b) =>
    (b.generatedOnly ? 0 : 1) - (a.generatedOnly ? 0 : 1) ||
    b.size - a.size ||
    a.hash.localeCompare(b.hash));

  const nonGeneratedGroups = groups.filter((g) => !g.generatedOnly);
  const nearShapeCandidates = collectNearShapeCandidates(facts);
  const gate = nonGeneratedGroups.length > 0 || nearShapeCandidates.length > 0 ? 'watch' : 'ok';
  return {
    gate,
    available: true,
    exactDuplicateGroups: nonGeneratedGroups.length,
    nearShapeCandidateCount: nearShapeCandidates.length,
    generatedOnlyGroups: groups.length - nonGeneratedGroups.length,
    duplicateIdentityCount: nonGeneratedGroups.reduce((acc, g) => acc + g.size, 0),
    totalShapeFacts: facts.length,
    shapeIndexComplete: shapeIndex.meta?.complete !== false,
    topGroups: nonGeneratedGroups.slice(0, 10),
    nearShapeCandidates: nearShapeCandidates.slice(0, 10),
    generatedOnlySummary: groups
      .filter((g) => g.generatedOnly)
      .slice(0, 5)
      .map((g) => ({ hash: g.hash, size: g.size, ownerFiles: g.ownerFiles })),
    note: 'Exact and near exported type-shape matches only. Treat as review cues, not proof of duplicated implementation or an automatic refactor.',
  };
}

// ─── B1: duplicate helper/function implementation cues ─────
//
// This is a deterministic candidate lane, not semantic equivalence. The
// producer compares normalized exported top-level function bodies so the
// reviewer can inspect likely clone pairs without scanning every helper.

function b1DuplicateImplementation() {
  if (!functionClones) {
    return {
      gate: 'unknown',
      available: false,
      reason: 'function-clones.json missing — run full profile or build-function-clone-index.mjs first',
    };
  }

  const exactGroups = (functionClones.exactBodyGroups ?? []).filter((g) => !g.generatedOnly);
  const structureGroups = (functionClones.structureGroups ?? []).filter((g) => !g.generatedOnly);
  const nearFunctionCandidates =
    (functionClones.nearFunctionCandidates ?? []).filter((g) => !g.generatedOnly);
  const generatedOnlyExactGroups =
    (functionClones.exactBodyGroups ?? []).filter((g) => g.generatedOnly).length;
  const generatedOnlyStructureGroups =
    (functionClones.structureGroups ?? []).filter((g) => g.generatedOnly).length;
  const generatedOnlyNearFunctionCandidates =
    (functionClones.nearFunctionCandidates ?? []).filter((g) => g.generatedOnly).length;
  const gate =
    exactGroups.length > 0 || structureGroups.length > 0 || nearFunctionCandidates.length > 0
      ? 'watch'
      : 'ok';

  return {
    gate,
    available: true,
    exactBodyGroups: exactGroups.length,
    structureGroupCandidates: structureGroups.length,
    nearFunctionCandidates: nearFunctionCandidates.length,
    generatedOnlyExactGroups,
    generatedOnlyStructureGroups,
    generatedOnlyNearFunctionCandidates,
    candidateIdentityCount: structureGroups
      .reduce((acc, group) => acc + (Array.isArray(group.identities) ? group.identities.length : 0), 0) +
      nearFunctionCandidates
        .reduce((acc, group) => acc + (Array.isArray(group.identities) ? group.identities.length : 0), 0),
    totalFunctionFacts: Array.isArray(functionClones.facts) ? functionClones.facts.length : 0,
    functionCloneIndexComplete: functionClones.meta?.complete !== false,
    topExactGroups: exactGroups.slice(0, 10),
    topStructureGroups: structureGroups.slice(0, 10),
    topNearFunctionCandidates: nearFunctionCandidates.slice(0, 10),
    note: 'Exact, same-structure, and near exported function-body cues only. Treat as review cues, not proof of semantic equivalence or an automatic merge.',
  };
}

// ─── C5: lint-enforced module boundaries ────────────────────

function c5LintEnforcement() {
  if (!triage?.boundaries) return { gate: 'unknown', available: false,
    reason: 'triage.json missing — run triage-repo.mjs first' };
  const rules = triage.boundaries;
  const hasBoundaryRule = rules.some((b) =>
    b.rule === 'no-restricted-imports' ||
    b.rule === 'no-restricted-paths' ||
    b.rule === 'eslint-plugin-boundaries');
  const gate = hasBoundaryRule ? 'ok' : 'watch';
  return {
    gate,
    rulesDetected: rules.length,
    boundaryRulePresent: hasBoundaryRule,
    rules,
  };
}

// ─── C7: barrel amplification ────────────────────────────────

function c7BarrelAmplification() {
  if (!barrels) return { gate: 'unknown', available: false,
    reason: 'barrels.json missing — run check-barrel-discipline.mjs first' };
  if (barrels.mode === 'single-package') return { gate: 'ok',
    reason: 'single-package repo — no workspace barrels to discipline' };

  const byPackage = [];
  let worstCompliance = 1;

  for (const [pkg, data] of Object.entries(barrels.byPackage ?? {})) {
    // policyCompliance is a string like "30.5%" or "n/a (no imports)".
    const m = (data.policyCompliance ?? '').match(/^([\d.]+)%/);
    const pct = m ? parseFloat(m[1]) / 100 : null;
    byPackage.push({
      pkg,
      rootImports: data.rootImports,
      subpathImports: data.subpathImports,
      total: data.total,
      compliance: data.policyCompliance,
      complianceNum: pct,
    });
    if (pct !== null && pct < worstCompliance) worstCompliance = pct;
  }
  const gate = worstCompliance < 0.5 ? 'fix' :
               worstCompliance < 0.8 ? 'watch' : 'ok';
  return { gate, worstCompliance: +worstCompliance.toFixed(3), byPackage };
}

// ─── E2: silent catch sites ──────────────────────────────────
//
// AST-backed catch handling signals. An undocumented empty catch contributes
// to the E2 silent-catch gate. Commented empty catches are visible in
// `documentedSites`, but do not contribute to the gate. Non-empty anonymous
// catches and bound-but-unused catch parameters are reported as watch evidence:
// they are not empty silent catches, but they can still discard the original
// error identity.

function catchBodyHasComment(node, comments) {
  const bodyStart = node.body?.start;
  const bodyEnd = node.body?.end;
  if (typeof bodyStart !== 'number' || typeof bodyEnd !== 'number') return false;
  return comments.some((comment) =>
    typeof comment.start === 'number' &&
    typeof comment.end === 'number' &&
    comment.start > bodyStart &&
    comment.end < bodyEnd &&
    String(comment.value ?? '').trim().length > 0);
}

function catchParamName(node) {
  return node?.param?.type === 'Identifier' ? node.param.name : null;
}

function isIdentifierReference(node, parent, key) {
  if (!node || node.type !== 'Identifier') return false;
  if (!parent) return true;

  if ((parent.type === 'VariableDeclarator' ||
       parent.type === 'FunctionDeclaration' ||
       parent.type === 'FunctionExpression' ||
       parent.type === 'ClassDeclaration' ||
       parent.type === 'ClassExpression') &&
      key === 'id') return false;
  if ((parent.type === 'FunctionDeclaration' ||
       parent.type === 'FunctionExpression' ||
       parent.type === 'ArrowFunctionExpression') &&
      key === 'params') return false;
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition' ||
       parent.type === 'PropertyDefinition' || parent.type === 'AccessorProperty') &&
      key === 'key' && parent.computed !== true) return false;
  if (parent.type === 'MemberExpression' && key === 'property' &&
      parent.computed !== true) return false;
  if (parent.type === 'LabeledStatement' && key === 'label') return false;
  if (parent.type === 'BreakStatement' && key === 'label') return false;
  if (parent.type === 'ContinueStatement' && key === 'label') return false;
  if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' ||
      parent.type === 'ImportNamespaceSpecifier' || parent.type === 'ExportSpecifier') return false;

  return true;
}

function catchBodyReferencesParam(body, name) {
  if (!body || !name) return false;
  let found = false;

  function walk(node, parent = null, key = null) {
    if (found || !node || typeof node !== 'object') return;
    if (node.type === 'Identifier' && node.name === name &&
        isIdentifierReference(node, parent, key)) {
      found = true;
      return;
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end' ||
          k === 'loc' || k === 'range' || k === 'parent') continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (const c of v) {
          if (c && typeof c === 'object' && typeof c.type === 'string') walk(c, node, k);
        }
      } else if (v && typeof v === 'object' && typeof v.type === 'string') {
        walk(v, node, k);
      }
    }
  }

  walk(body);
  return found;
}

function e2SilentCatch() {
  const sites = [];
  const documentedSites = [];
  const anonymousSites = [];
  const nonEmptyAnonymousSites = [];
  const unusedParamSites = [];
  let parseErrors = 0;

  for (const file of files) {
    let src, result;
    try {
      src = readFileSync(file, 'utf8');
      result = parseOxcOrThrow(file, src);
    } catch {
      parseErrors++;
      continue;
    }
    const lineStarts = computeLineStarts(src);
    const comments = result.comments ?? [];

    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CatchClause' &&
          node.body && Array.isArray(node.body.body)) {
        const site = {
          file: relPath(ROOT, file),
          line: lineOf(lineStarts, node.start ?? 0),
          fileRole: classifyFileRole(file),
          bodyStatementCount: node.body.body.length,
        };
        const hasParam = Boolean(node.param);
        const paramName = catchParamName(node);
        if (!hasParam) anonymousSites.push(site);
        if (node.body.body.length === 0) {
          if (catchBodyHasComment(node, comments)) documentedSites.push(site);
          else sites.push(site);
        } else if (!hasParam) {
          nonEmptyAnonymousSites.push(site);
        } else if (paramName && !catchBodyReferencesParam(node.body, paramName)) {
          unusedParamSites.push({ ...site, paramName });
        }
      }
      for (const k of Object.keys(node)) {
        if (k === 'type' || k === 'start' || k === 'end' ||
            k === 'loc' || k === 'range' || k === 'parent') continue;
        const v = node[k];
        if (Array.isArray(v)) {
          for (const c of v) {
            if (c && typeof c === 'object' && typeof c.type === 'string') walk(c);
          }
        } else if (v && typeof v === 'object' && typeof v.type === 'string') {
          walk(v);
        }
      }
    }
    walk(result.program);
  }

  const watchCount = nonEmptyAnonymousSites.length + unusedParamSites.length;
  const gate = sites.length > 3 ? 'fix' :
               sites.length > 0 || watchCount > 0 ? 'watch' : 'ok';
  return {
    gate,
    analysis: 'oxc-ast-catch-clause',
    count: sites.length,
    emptyUndocumentedCount: sites.length,
    parseErrors,
    sites,
    documentedCount: documentedSites.length,
    emptyDocumentedCount: documentedSites.length,
    documentedSites,
    anonymousCount: anonymousSites.length,
    anonymousSites,
    nonEmptyAnonymousCount: nonEmptyAnonymousSites.length,
    nonEmptyAnonymousSites,
    unusedParamCount: unusedParamSites.length,
    unusedParamSites,
  };
}

// ─── Assemble artifact ───────────────────────────────────────

const A2 = a2FunctionSize();
const A5 = a5DecouplingRatio();
const A6 = a6Cycles();
const B1 = b1DuplicateImplementation();
const B3 = b3DeadCode();
const B1B2 = b1b2ShapeDrift();
const C5 = c5LintEnforcement();
const C7 = c7BarrelAmplification();
const E2 = e2SilentCatch();

// v1.10.3 — annotate each pre-computed item with:
//   _citation_hint      — the label format a reviewer should produce,
//                         already filled with this run's value so it's
//                         immediately usable (Rule 1 of REVIEW_CHECKLIST).
//   _context_check_required — true iff the gate is threshold-based and
//                         could legitimately be overridden by repo
//                         context (Rule 6 / SKILL.md contract 8).
//
// Items where the gate is structural (e.g., A6: ANY cycle is always a
// cycle, no context override) set `_context_check_required: false`.
// Items where the threshold is heuristic (A2/A5/C5/C7/E2) set true.
function annotate(sectionKey, result, { contextCheck }) {
  return {
    ...result,
    _citation_hint: citationFor(sectionKey, result),
    _context_check_required: contextCheck,
  };
}
function citationFor(sectionKey, r) {
  if (r.available === false) {
    return `[확인 불가, scan range: ${sectionKey} input artifact missing — ${r.reason ?? 'run pipeline prerequisites'}]`;
  }
  switch (sectionKey) {
    case 'A2_function_size':
      return `[grounded, checklist-facts.json.A2_function_size.buckets = ${JSON.stringify(r.buckets)}, roleBuckets = ${JSON.stringify(r.roleBuckets ?? {})}]`;
    case 'A5_decoupling_ratio':
      return `[grounded, checklist-facts.json.A5_decoupling_ratio.ratioLowerBound = ${r.ratioLowerBound}]`;
    case 'A6_circular_deps':
      return `[grounded, checklist-facts.json.A6_circular_deps.sccCount = ${r.sccCount}, lens = ${r.lens}]`;
    case 'B3_dead_code':
      return `[grounded, checklist-facts.json.B3_dead_code = {safeFix: ${r.safeFix}, reviewFix: ${r.reviewFix}, degraded: ${r.degraded}, muted: ${r.muted}, total: ${r.total}}]`;
    case 'B1B2_shape_drift':
      return `[grounded, checklist-facts.json.B1B2_shape_drift.exactDuplicateGroups = ${r.exactDuplicateGroups ?? 'unknown'}, nearShapeCandidateCount = ${r.nearShapeCandidateCount ?? 'unknown'}, duplicateIdentityCount = ${r.duplicateIdentityCount ?? 'unknown'}]`;
    case 'B1_duplicate_implementation':
      return `[grounded, checklist-facts.json.B1_duplicate_implementation.exactBodyGroups = ${r.exactBodyGroups ?? 'unknown'}, structureGroupCandidates = ${r.structureGroupCandidates ?? 'unknown'}, nearFunctionCandidates = ${r.nearFunctionCandidates ?? 'unknown'}]`;
    case 'C5_lint_enforcement':
      return `[grounded, checklist-facts.json.C5_lint_enforcement.boundaryRulePresent = ${r.boundaryRulePresent}, rulesDetected = ${r.rulesDetected}]`;
    case 'C7_barrel_amplification':
      return `[grounded, checklist-facts.json.C7_barrel_amplification.worstCompliance = ${r.worstCompliance ?? 'n/a'}]`;
    case 'E2_silent_catch':
      return `[grounded, checklist-facts.json.E2_silent_catch.count = ${r.count}, nonEmptyAnonymousCount = ${r.nonEmptyAnonymousCount ?? 0}, unusedParamCount = ${r.unusedParamCount ?? 0}, analysis = ${r.analysis ?? 'unknown'}]`;
    default:
      return `[grounded, checklist-facts.json.${sectionKey}]`;
  }
}

const artifact = {
  meta: {
    generated: new Date().toISOString(),
    root: ROOT,
    tool: 'checklist-facts.mjs',
    schemaVersion: 9, // v1.11.x: B1 near function-clone cues from function-clones.json
    filesScanned: files.length,
    inputsPresent: {
      'topology.json':     !!topology,
      'dead-classify.json':!!deadClassify,
      'fix-plan.json':     !!fixPlan,
      'barrels.json':      !!barrels,
      'triage.json':       !!triage,
      'shape-index.json':   !!shapeIndex,
      'function-clones.json': !!functionClones,
    },
  },
  A2_function_size:         annotate('A2_function_size',        A2, { contextCheck: true  }),
  A5_decoupling_ratio:      annotate('A5_decoupling_ratio',     A5, { contextCheck: true  }),
  A6_circular_deps:         annotate('A6_circular_deps',        A6, { contextCheck: false }),
  B1_duplicate_implementation: annotate('B1_duplicate_implementation', B1, { contextCheck: true }),
  B3_dead_code:             annotate('B3_dead_code',            B3, { contextCheck: true  }),
  B1B2_shape_drift:         annotate('B1B2_shape_drift',        B1B2, { contextCheck: true  }),
  C5_lint_enforcement:      annotate('C5_lint_enforcement',     C5, { contextCheck: true  }),
  C7_barrel_amplification:  annotate('C7_barrel_amplification', C7, { contextCheck: true  }),
  E2_silent_catch:          annotate('E2_silent_catch',         E2, { contextCheck: true  }),

  // Items the checklist walker MUST still answer — not pre-computed
  // here either because they need semantic judgment or because the
  // input artifact doesn't emit per-file granularity yet. The
  // reviewer should produce `[grounded]` / `[degraded]` / `[확인 불가]`
  // labels for each.
  _not_computed: [
    { item: 'A1', reason: 'summary of A2-A6 — synthesize after reading sub-items' },
    { item: 'A3', reason: 'helper zoo — needs per-file export fan-in map; symbols.json currently emits only topSymbolFanIn (top 50)' },
    { item: 'A4', reason: 'over-split — needs per-file fanIn/fanOut; topology.json currently emits only top lists' },
    { item: 'B1', reason: 'broader duplicate implementation still requires LLM review; B1_duplicate_implementation covers exported top-level exact, same-structure, and near function-body clone cues only' },
    { item: 'B2', reason: 'broader shared-shape drift still requires domain/vocab judgment; nearShapeCandidates are artifact-backed review cues only' },
    { item: 'B4', reason: 'pipeline duplication — semantic comparison across script entry points' },
    { item: 'C1', reason: 'cohesion / SRP — LLM reads file name vs body alignment' },
    { item: 'C2', reason: 'boundary health — LLM reads cross-submodule direction for inversion patterns' },
    { item: 'C3', reason: 'crosscut concerns — LLM identifies validation / normalization / error patterns' },
    { item: 'C4', reason: 'single state-mutation entry — dataflow analysis' },
    { item: 'C6', reason: 'file hierarchy health — LLM reads triage.topDirs shape' },
    { item: 'D1', reason: 'type tightness — JS has limited static info; discipline.json gives counts' },
    { item: 'D2', reason: 'interface/generic appropriateness — LLM judgment' },
    { item: 'D3', reason: 'naming consistency — LLM scan of sibling exports' },
    { item: 'D4', reason: 'implicit coupling — LLM identifies side-effect-only imports, init-order deps' },
    { item: 'D5', reason: 'discriminated-union candidates — LLM judgment' },
    { item: 'E1', reason: 'defensive-code density — LLM judgment across sites' },
    { item: 'E3', reason: 'fallback hiding bugs — LLM reads catch-then-return-null patterns' },
    { item: 'E4', reason: 'catch re-classification — LLM inspects rethrown error types' },
    { item: 'E5', reason: 'resource cleanup — AST possible but heuristic; not implemented' },
    { item: 'E6', reason: 'fire-and-forget Promise — AST possible but heuristic; not implemented' },
    { item: 'F1', reason: 'abstraction level — LLM judgment' },
    { item: 'F2', reason: 'test coverage of edge/failure cases — merge with c8 report when available' },
    { item: 'F3', reason: 'test-to-contract coupling — LLM reads assertions' },
    { item: 'F4', reason: 'mock boundary depth — LLM judgment' },
  ],
};

const outPath = path.join(OUT, 'checklist-facts.json');
writeFileSync(outPath, JSON.stringify(artifact, null, 2));

// ─── Console report ─────────────────────────────────────────
console.log('\n══════ checklist-facts ══════');
const gateOf = (s) => s?.gate ?? 'unknown';
const gateIcon = (g) => g === 'fix' ? '❌' : g === 'watch' ? '⚠' : g === 'ok' ? '✅' : '·';
for (const [key, val] of Object.entries(artifact)) {
  if (key === 'meta' || key === '_not_computed') continue;
  const g = gateOf(val);
  console.log(`  ${gateIcon(g)}  ${key.padEnd(28)} gate=${g}`);
}
console.log(`\n[checklist-facts] saved → ${outPath}`);
console.log(`[checklist-facts] ${artifact._not_computed.length} items deferred to the checklist walker.`);
