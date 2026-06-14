// _lib/block-clone-artifact.mjs - repeated normalized token-region evidence.
//
// This artifact is deliberately review-only. It detects repeated regions with a
// suffix-array/LCP pipeline, but it does not claim semantic equivalence and does
// not feed function-clone, SAFE, fix-plan, or pre-write cue lanes.

import { createHash } from "node:crypto";
import path from "node:path";

import { collectFiles } from "./collect-files.mjs";
import { JS_FAMILY_LANGS } from "./lang.mjs";
import { computeLineStarts, lineOf } from "./line-offset.mjs";
import { parseOxcOrThrow } from "./parse-oxc.mjs";
import { detectGeneratedFileEvidence } from "./shape-hash.mjs";

export const BLOCK_CLONE_SCHEMA_VERSION = "block-clones.v1";
export const BLOCK_CLONE_POLICY_VERSION = "block-clone-review-policy-v1";
export const BLOCK_CLONE_NORMALIZATION_POLICY_ID =
  "block-clone-normalization-v1";
export const BLOCK_CLONE_THRESHOLD_POLICY_ID =
  "block-clone-threshold-policy-v2";
export const BLOCK_CLONE_NOISE_POLICY_ID = "block-clone-noise-policy-v1";

export const DEFAULT_BLOCK_CLONE_THRESHOLDS = Object.freeze({
  minTokens: 50,
  minLines: 5,
  minOccurrences: 2,
  maxInstancesPerGroup: 20,
  maxCandidateGroups: 1000,
  maxReviewGroups: 100,
  maxMutedGroups: 100,
  maxTokensPerFile: 200000,
});

const SKIP_KEYS = new Set([
  "start",
  "end",
  "loc",
  "range",
  "parent",
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "declare",
  "accessibility",
  "optional",
]);

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const BUNDLED_PATH_RE =
  /(?:^|\/)(?:public\/vendor|.*(?:\.bundle|\.min)\.(?:js|jsx|mjs|cjs))$/;

function slashPath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function sortCountObject(map) {
  return Object.fromEntries(
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function optionalNonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
}

function normalizeBlockCloneThresholds(thresholds = {}) {
  const input = thresholds && typeof thresholds === "object" ? thresholds : {};
  const normalized = {
    minTokens: nonNegativeInteger(
      input.minTokens,
      DEFAULT_BLOCK_CLONE_THRESHOLDS.minTokens,
    ),
    minLines: nonNegativeInteger(
      input.minLines,
      DEFAULT_BLOCK_CLONE_THRESHOLDS.minLines,
    ),
    minOccurrences: nonNegativeInteger(
      input.minOccurrences,
      DEFAULT_BLOCK_CLONE_THRESHOLDS.minOccurrences,
    ),
    maxInstancesPerGroup: nonNegativeInteger(
      input.maxInstancesPerGroup,
      DEFAULT_BLOCK_CLONE_THRESHOLDS.maxInstancesPerGroup,
    ),
    maxCandidateGroups: nonNegativeInteger(
      input.maxCandidateGroups,
      DEFAULT_BLOCK_CLONE_THRESHOLDS.maxCandidateGroups,
    ),
    maxReviewGroups: nonNegativeInteger(
      input.maxReviewGroups,
      DEFAULT_BLOCK_CLONE_THRESHOLDS.maxReviewGroups,
    ),
    maxMutedGroups: nonNegativeInteger(
      input.maxMutedGroups,
      DEFAULT_BLOCK_CLONE_THRESHOLDS.maxMutedGroups,
    ),
    maxTokensPerFile: nonNegativeInteger(
      input.maxTokensPerFile,
      DEFAULT_BLOCK_CLONE_THRESHOLDS.maxTokensPerFile,
    ),
  };
  const legacyMaxGroups = optionalNonNegativeInteger(input.maxGroups);
  if (legacyMaxGroups !== null) normalized.maxGroups = legacyMaxGroups;
  return normalized;
}

function blockCloneGroupRank(a, b) {
  return (
    (b.tokenCount ?? 0) - (a.tokenCount ?? 0) ||
    (b.occurrenceCount ?? 0) - (a.occurrenceCount ?? 0) ||
    String(a.id ?? "").localeCompare(String(b.id ?? ""))
  );
}

function relPath(root, filePath) {
  return slashPath(path.relative(root, filePath));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort())
    out[key] = stableValue(value[key]);
  return out;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha(value) {
  return (
    "sha256:" + createHash("sha256").update(stableJson(value)).digest("hex")
  );
}

function compressionRanks(values) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const rankByValue = new Map(sorted.map((value, index) => [value, index]));
  return values.map((value) => rankByValue.get(value));
}

export function buildSuffixArray(values) {
  const n = values.length;
  let sa = Array.from({ length: n }, (_, index) => index);
  let rank = compressionRanks(values);
  let nextRank = new Array(n);

  for (let width = 1; width < n; width *= 2) {
    sa.sort(
      (a, b) =>
        rank[a] - rank[b] ||
        (rank[a + width] ?? -1) - (rank[b + width] ?? -1) ||
        a - b,
    );

    nextRank[sa[0]] = 0;
    for (let i = 1; i < n; i++) {
      const prev = sa[i - 1];
      const curr = sa[i];
      const same =
        rank[prev] === rank[curr] &&
        (rank[prev + width] ?? -1) === (rank[curr + width] ?? -1);
      nextRank[curr] = same ? nextRank[prev] : nextRank[prev] + 1;
    }
    rank = nextRank.slice();
    if (rank[sa[n - 1]] === n - 1) break;
  }

  return sa;
}

export function buildLcpArray(values, suffixArray) {
  const n = values.length;
  const rank = new Array(n);
  for (let i = 0; i < n; i++) rank[suffixArray[i]] = i;

  const lcp = new Array(n).fill(0);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const r = rank[i];
    if (r === 0) {
      k = 0;
      continue;
    }
    const j = suffixArray[r - 1];
    while (
      i + k < n &&
      j + k < n &&
      values[i + k] === values[j + k] &&
      values[i + k] > 0
    ) {
      k++;
    }
    lcp[r] = k;
    if (k > 0) k--;
  }
  return lcp;
}

function isGeneratedOrBundled(relFile, src) {
  const generated = detectGeneratedFileEvidence(relFile, src);
  if (generated) return generated;
  if (BUNDLED_PATH_RE.test(slashPath(relFile))) {
    return {
      kind: "bundled-build-artifact",
      source: "path",
      evidence: "path:bundled-build-artifact",
    };
  }
  return null;
}

function literalToken(node) {
  if (!node) return null;
  if (node.type === "StringLiteral" || typeof node.value === "string")
    return "LIT:STRING";
  if (node.type === "NumericLiteral" || typeof node.value === "number")
    return "LIT:NUMBER";
  if (node.type === "BooleanLiteral" || typeof node.value === "boolean")
    return "LIT:BOOLEAN";
  if (node.type === "NullLiteral" || node.value === null) return "LIT:NULL";
  if (node.type === "RegExpLiteral") return "LIT:REGEXP";
  return null;
}

function isFunctionNode(node) {
  return FUNCTION_TYPES.has(node?.type);
}

function functionName(node, parent) {
  if (node?.id?.name) return node.id.name;
  if (
    parent?.type === "VariableDeclarator" &&
    parent.id?.type === "Identifier"
  ) {
    return parent.id.name;
  }
  if (parent?.type === "Property" && parent.key?.type === "Identifier") {
    return parent.key.name;
  }
  return null;
}

function isPropertyNameIdentifier(parent, key) {
  if (!parent) return false;
  if (
    parent.type === "MemberExpression" &&
    key === "property" &&
    parent.computed !== true
  ) {
    return true;
  }
  if (
    (parent.type === "Property" ||
      parent.type === "MethodDefinition" ||
      parent.type === "PropertyDefinition" ||
      parent.type === "AccessorProperty") &&
    key === "key" &&
    parent.computed !== true
  ) {
    return true;
  }
  return false;
}

function collectBindingIdentifiers(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "Identifier" && node.name) {
    out.push(node);
    return out;
  }
  if (node.type === "AssignmentPattern") {
    collectBindingIdentifiers(node.left, out);
    return out;
  }
  if (node.type === "RestElement") {
    collectBindingIdentifiers(node.argument, out);
    return out;
  }
  if (node.type === "ArrayPattern") {
    for (const element of node.elements ?? []) {
      collectBindingIdentifiers(element, out);
    }
    return out;
  }
  if (node.type === "ObjectPattern") {
    for (const property of node.properties ?? []) {
      if (!property) continue;
      if (property.type === "RestElement") {
        collectBindingIdentifiers(property.argument, out);
      } else if (property.type === "Property") {
        collectBindingIdentifiers(property.value, out);
      }
    }
    return out;
  }
  if (node.type === "TSParameterProperty") {
    collectBindingIdentifiers(node.parameter, out);
  }
  return out;
}

function createScope(parent = null) {
  return {
    parent,
    nextSlot: 0,
    names: new Map(),
  };
}

function declare(scope, name) {
  if (!name) return null;
  if (!scope.names.has(name)) {
    scope.names.set(name, `$${scope.nextSlot++}`);
  }
  return scope.names.get(name);
}

function resolve(scope, name) {
  for (let current = scope; current; current = current.parent) {
    if (current.names.has(name)) return current.names.get(name);
  }
  return null;
}

function statementLineCount(node, lineStarts) {
  if (!node || typeof node.start !== "number" || typeof node.end !== "number")
    return 0;
  return Math.max(
    1,
    lineOf(lineStarts, node.end) - lineOf(lineStarts, node.start) + 1,
  );
}

export function tokenizeBlockCloneSource({
  root,
  filePath,
  src,
  thresholds = DEFAULT_BLOCK_CLONE_THRESHOLDS,
}) {
  const effectiveThresholds = normalizeBlockCloneThresholds(thresholds);
  const relFile = relPath(root, filePath);
  const skipped = isGeneratedOrBundled(relFile, src);
  if (skipped) {
    return {
      relFile,
      tokens: [],
      skipped: {
        file: relFile,
        reason: skipped.kind,
        evidence: skipped.evidence,
      },
      diagnostics: [],
    };
  }

  let parsed;
  try {
    parsed = parseOxcOrThrow(filePath, src);
  } catch (error) {
    return {
      relFile,
      tokens: [],
      skipped: null,
      diagnostics: [
        {
          file: relFile,
          kind: "parse-error",
          message: error?.message ?? String(error),
        },
      ],
    };
  }

  const lineStarts = computeLineStarts(src);
  const tokens = [];
  let scope = createScope();
  let container = null;
  let skippedTokenCount = 0;

  function emit(value, node) {
    if (
      !value ||
      !node ||
      typeof node.start !== "number" ||
      typeof node.end !== "number"
    )
      return;
    tokens.push({
      value,
      file: relFile,
      start: node.start,
      end: node.end,
      line: lineOf(lineStarts, node.start),
      endLine: lineOf(lineStarts, Math.max(node.start, node.end - 1)),
      container,
    });
  }

  function emitBindingPattern(pattern) {
    if (!pattern || typeof pattern !== "object") return;
    if (pattern.type === "Identifier") {
      emit(`BIND:${declare(scope, pattern.name)}`, pattern);
      return;
    }
    if (pattern.type === "AssignmentPattern") {
      emit(`NODE:${pattern.type}`, pattern);
      emitBindingPattern(pattern.left);
      walk(pattern.right, pattern, "right");
      emit(`END:${pattern.type}`, pattern);
      return;
    }
    if (pattern.type === "RestElement") {
      emit(`NODE:${pattern.type}`, pattern);
      emitBindingPattern(pattern.argument);
      emit(`END:${pattern.type}`, pattern);
      return;
    }
    if (pattern.type === "ArrayPattern") {
      emit(`NODE:${pattern.type}`, pattern);
      for (const element of pattern.elements ?? []) emitBindingPattern(element);
      emit(`END:${pattern.type}`, pattern);
      return;
    }
    if (pattern.type === "ObjectPattern") {
      emit(`NODE:${pattern.type}`, pattern);
      for (const property of pattern.properties ?? []) {
        if (!property) continue;
        if (property.type === "RestElement") {
          emitBindingPattern(property);
          continue;
        }
        if (property.type === "Property") {
          emit(`NODE:${property.type}`, property);
          if (property.computed) {
            walk(property.key, property, "key");
          } else if (property.key?.type === "Identifier") {
            emit(`PROP:${property.key.name}`, property.key);
          } else if (property.key) {
            walk(property.key, property, "key");
          }
          emitBindingPattern(property.value);
          emit(`END:${property.type}`, property);
        }
      }
      emit(`END:${pattern.type}`, pattern);
      return;
    }
    walk(pattern);
  }

  function walk(node, parent = null, key = null) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, parent, key);
      return;
    }
    if (!node.type) return;

    if (node.type === "ImportDeclaration") {
      skippedTokenCount += statementLineCount(node, lineStarts);
      return;
    }

    if (isFunctionNode(node)) {
      emit(`NODE:${node.type}`, node);
      const previousScope = scope;
      const previousContainer = container;
      scope = createScope(previousScope);
      const name = functionName(node, parent);
      container = {
        kind: "function",
        name,
      };
      for (const param of node.params ?? []) {
        for (const binding of collectBindingIdentifiers(param))
          declare(scope, binding.name);
      }
      if (node.body) walk(node.body, node, "body");
      scope = previousScope;
      container = previousContainer;
      emit(`END:${node.type}`, node);
      return;
    }

    if (node.type === "VariableDeclarator") {
      emit(`NODE:${node.type}`, node);
      emitBindingPattern(node.id);
      if (node.init) walk(node.init, node, "init");
      emit(`END:${node.type}`, node);
      return;
    }

    if (node.type === "Identifier") {
      if (isPropertyNameIdentifier(parent, key)) {
        emit(`PROP:${node.name}`, node);
        return;
      }
      if (
        (parent?.type === "VariableDeclarator" && key === "id") ||
        ((parent?.type === "FunctionDeclaration" ||
          parent?.type === "FunctionExpression") &&
          key === "id")
      ) {
        emit(`BIND:${declare(scope, node.name)}`, node);
        return;
      }
      const slot = resolve(scope, node.name);
      emit(slot ? `REF:${slot}` : `GLOBAL:${node.name}`, node);
      return;
    }

    const literal = literalToken(node);
    if (literal) {
      emit(literal, node);
      return;
    }

    emit(`NODE:${node.type}`, node);
    for (const childKey of Object.keys(node)) {
      if (SKIP_KEYS.has(childKey) || childKey === "type") continue;
      walk(node[childKey], node, childKey);
    }
    emit(`END:${node.type}`, node);
  }

  walk(parsed.program);

  return {
    relFile,
    tokens,
    skipped: null,
    diagnostics: [],
    skippedTokenCount,
    tokenLimitExceeded: tokens.length > effectiveThresholds.maxTokensPerFile,
  };
}

function compressTokenValues(files) {
  const ids = new Map();
  let next = 1;
  const values = [];
  const meta = [];
  let sentinel = -1;

  for (const file of files) {
    for (const token of file.tokens) {
      if (!ids.has(token.value)) ids.set(token.value, next++);
      values.push(ids.get(token.value));
      meta.push(token);
    }
    values.push(sentinel--);
    meta.push(null);
  }

  return { values, meta };
}

function spanFor(meta, start, tokenCount) {
  const entries = meta.slice(start, start + tokenCount);
  if (entries.length !== tokenCount || entries.some((entry) => !entry))
    return null;
  const file = entries[0].file;
  if (!entries.every((entry) => entry.file === file)) return null;
  const startEntry = entries[0];
  const endEntry = entries[entries.length - 1];
  return {
    file,
    startLine: startEntry.line,
    endLine: endEntry.endLine,
    startToken: start,
    endToken: start + tokenCount,
    container: startEntry.container ?? null,
  };
}

function overlaps(a, b) {
  return (
    a.file === b.file && a.startToken < b.endToken && b.startToken < a.endToken
  );
}

function containsSpan(outer, inner) {
  return (
    outer.file === inner.file &&
    outer.startToken <= inner.startToken &&
    outer.endToken >= inner.endToken
  );
}

function finiteGroupLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Infinity;
  return Math.max(0, Math.floor(number));
}

function groupContainsInstances(group, instances) {
  const groupInstances = Array.isArray(group?.instances) ? group.instances : [];
  return instances.every((instance) =>
    groupInstances.some((otherInstance) => containsSpan(otherInstance, instance)),
  );
}

function containmentProbe(index, instances) {
  let selected = null;
  for (const instance of instances) {
    const entries = index.get(instance.file) ?? [];
    if (!selected || entries.length < selected.entries.length) {
      selected = { instance, entries };
    }
  }
  return selected;
}

function addGroupToContainmentIndex(index, group) {
  for (const instance of group.instances ?? []) {
    if (!instance?.file) continue;
    const entries = index.get(instance.file) ?? [];
    entries.push({ group, instance });
    index.set(instance.file, entries);
  }
}

export function pruneContainedBlockCloneGroups(groups, { maxGroups } = {}) {
  const limit = finiteGroupLimit(maxGroups);
  if (limit === 0) return [];
  const kept = [];
  const containmentIndex = new Map();

  for (const group of [...(Array.isArray(groups) ? groups : [])].sort(
    blockCloneGroupRank,
  )) {
    const instances = Array.isArray(group?.instances) ? group.instances : [];
    const probe = containmentProbe(containmentIndex, instances);
    const contained =
      probe?.entries.some(
        (entry) =>
          containsSpan(entry.instance, probe.instance) &&
          groupContainsInstances(entry.group, instances),
      ) ?? false;
    if (contained) continue;

    kept.push(group);
    addGroupToContainmentIndex(containmentIndex, group);
    if (kept.length >= limit) break;
  }

  return kept;
}

function filterNonOverlapping(instances, limit) {
  const sorted = [...instances].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.startToken - b.startToken ||
      a.endToken - b.endToken,
  );
  const kept = [];
  for (const instance of sorted) {
    if (kept.some((other) => overlaps(other, instance))) continue;
    kept.push(instance);
    if (kept.length >= limit) break;
  }
  return kept;
}

function extractGroups(values, meta, thresholds) {
  if (values.length === 0) return [];
  const suffixArray = buildSuffixArray(values);
  const lcp = buildLcpArray(values, suffixArray);
  const bySignature = new Map();

  for (let i = 1; i < suffixArray.length; i++) {
    const tokenCount = lcp[i];
    if (tokenCount < thresholds.minTokens) continue;
    const starts = [suffixArray[i - 1], suffixArray[i]];
    const signature = values.slice(starts[0], starts[0] + tokenCount).join(",");
    if (!bySignature.has(signature)) {
      bySignature.set(signature, {
        tokenCount,
        starts: new Set(),
        signature,
      });
    }
    const record = bySignature.get(signature);
    record.tokenCount = Math.max(record.tokenCount, tokenCount);
    for (const start of starts) record.starts.add(start);
  }

  const groups = [];
  for (const record of bySignature.values()) {
    const instances = [];
    for (const start of record.starts) {
      const span = spanFor(meta, start, record.tokenCount);
      if (span) instances.push(span);
    }
    const kept = filterNonOverlapping(
      instances,
      thresholds.maxInstancesPerGroup,
    );
    const lineCount = Math.max(
      0,
      ...kept.map((span) => span.endLine - span.startLine + 1),
    );
    if (kept.length < thresholds.minOccurrences) continue;
    if (lineCount < thresholds.minLines) continue;
    groups.push({
      id:
        "block-clone:" +
        sha({
          policy: BLOCK_CLONE_POLICY_VERSION,
          normalization: BLOCK_CLONE_NORMALIZATION_POLICY_ID,
          thresholds,
          signature: record.signature,
        }).slice("sha256:".length),
      claim: "repeated normalized token region",
      confidence: "heuristic-review",
      tokenCount: record.tokenCount,
      lineCount,
      occurrenceCount: kept.length,
      normalizationMode: "alpha-identifier",
      reasons: ["suffix-array-lcp-repeat", "line-threshold-met"],
      instances: kept,
      reviewOnly: true,
      eligibleForSafeFix: false,
    });
  }

  return pruneContainedBlockCloneGroups(groups, {
    maxGroups: thresholds.maxCandidateGroups + 1,
  });
}

function isTestFile(file) {
  const rel = slashPath(file).toLowerCase();
  const base = path.posix.basename(rel);
  return (
    rel.startsWith("tests/") ||
    rel.includes("/tests/") ||
    base.startsWith("test-") ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base)
  );
}

function testMirrorEntry(file) {
  const rel = slashPath(file).toLowerCase();
  if (!isTestFile(rel)) return null;
  const base = path.posix.basename(rel);
  const dir = path.posix.dirname(rel);
  if (base.startsWith("test-")) {
    return {
      key: `${dir}/${base.replace(/^test-/, "").replace(/\.[cm]?[jt]sx?$/, "")}`,
      kind: "node",
    };
  }
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base)) {
    return {
      key: `${dir}/${base.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/, "")}`,
      kind: "vitest",
    };
  }
  return null;
}

function hasNodeVitestMirrorPair(files) {
  const kindsByKey = new Map();
  for (const file of files) {
    const entry = testMirrorEntry(file);
    if (!entry?.key) continue;
    if (!kindsByKey.has(entry.key)) kindsByKey.set(entry.key, new Set());
    kindsByKey.get(entry.key).add(entry.kind);
  }
  return [...kindsByKey.values()].some(
    (kinds) => kinds.has("node") && kinds.has("vitest"),
  );
}

function classifyBlockCloneGroupNoise(group) {
  const files = [
    ...new Set(
      (group?.instances ?? [])
        .map((instance) => instance?.file)
        .filter((file) => typeof file === "string" && file.length > 0)
        .map(slashPath),
    ),
  ];
  if (files.length === 0) return { visibility: "review" };
  const allTest = files.every(isTestFile);
  if (allTest && hasNodeVitestMirrorPair(files)) {
    return { visibility: "muted", muteReason: "node-vitest-mirror-pair" };
  }
  if (files.length === 1) {
    return { visibility: "muted", muteReason: "same-file-repeat" };
  }
  if (allTest) {
    return { visibility: "muted", muteReason: "test-scaffold-repeat" };
  }
  return { visibility: "review" };
}

export function applyBlockCloneNoisePolicy(groups, { thresholds = {} } = {}) {
  const effectiveThresholds = normalizeBlockCloneThresholds(thresholds);
  const rankedCandidates = [...(Array.isArray(groups) ? groups : [])].sort(
    blockCloneGroupRank,
  );
  const candidateGroups = rankedCandidates.slice(
    0,
    effectiveThresholds.maxCandidateGroups,
  );
  const candidateCapSaturated =
    rankedCandidates.length > candidateGroups.length;
  const classifiedGroups = candidateGroups.map((group) => {
    const classification = classifyBlockCloneGroupNoise(group);
    if (classification.visibility !== "muted") {
      return {
        ...group,
        visibility: "review",
      };
    }
    const reason = classification.muteReason;
    return {
      ...group,
      visibility: "muted",
      muteReason: reason,
    };
  });
  const reviewCandidates = classifiedGroups
    .filter((group) => group.visibility !== "muted")
    .sort(blockCloneGroupRank);
  const mutedCandidates = classifiedGroups
    .filter((group) => group.visibility === "muted")
    .sort(blockCloneGroupRank);

  let reviewGroups = reviewCandidates.slice(
    0,
    effectiveThresholds.maxReviewGroups,
  );
  let mutedGroups = mutedCandidates.slice(0, effectiveThresholds.maxMutedGroups);

  if (typeof effectiveThresholds.maxGroups === "number") {
    reviewGroups = reviewGroups.slice(0, effectiveThresholds.maxGroups);
    const remainingSlots = Math.max(
      0,
      effectiveThresholds.maxGroups - reviewGroups.length,
    );
    mutedGroups = mutedGroups.slice(0, remainingSlots);
  }

  const emittedMutedByReason = new Map();
  for (const group of mutedGroups) {
    emittedMutedByReason.set(
      group.muteReason,
      (emittedMutedByReason.get(group.muteReason) ?? 0) + 1,
    );
  }

  const reviewCapSaturated = reviewCandidates.length > reviewGroups.length;
  const mutedCapSaturated = mutedCandidates.length > mutedGroups.length;
  return {
    groups: [...reviewGroups, ...mutedGroups],
    noisePolicy: {
      policyId: BLOCK_CLONE_NOISE_POLICY_ID,
      reviewGroupCount: reviewGroups.length,
      mutedGroupCount: mutedGroups.length,
      mutedByReason: sortCountObject(emittedMutedByReason),
      candidateCapSaturated,
      reviewCapSaturated,
      mutedCapSaturated,
    },
  };
}

export function assembleBlockCloneArtifact({
  root,
  files,
  includeTests = true,
  exclude = [],
  generated = new Date().toISOString(),
  thresholds = DEFAULT_BLOCK_CLONE_THRESHOLDS,
}) {
  const effectiveThresholds = normalizeBlockCloneThresholds(thresholds);
  const tokenizedFiles = [];
  const skipped = [];
  const diagnostics = [];
  let unavailableFileCount = 0;

  for (const file of files) {
    if (file.skipped) {
      skipped.push(file.skipped);
      continue;
    }
    if (file.tokenLimitExceeded) {
      skipped.push({
        file: file.relFile,
        reason: "max-tokens-per-file",
        evidence: "threshold:maxTokensPerFile",
      });
      continue;
    }
    if (file.diagnostics?.length) {
      diagnostics.push(...file.diagnostics);
      unavailableFileCount++;
      continue;
    }
    tokenizedFiles.push(file);
  }

  const { values, meta } = compressTokenValues(tokenizedFiles);
  const extractedGroups = extractGroups(values, meta, effectiveThresholds);
  const { groups, noisePolicy } = applyBlockCloneNoisePolicy(extractedGroups, {
    thresholds: effectiveThresholds,
  });
  const status =
    diagnostics.length > 0 || skipped.length > 0
      ? "confidence-limited"
      : "complete";
  const artifactThresholds = {
    policyId: BLOCK_CLONE_THRESHOLD_POLICY_ID,
    minTokens: effectiveThresholds.minTokens,
    minLines: effectiveThresholds.minLines,
    minOccurrences: effectiveThresholds.minOccurrences,
    maxInstancesPerGroup: effectiveThresholds.maxInstancesPerGroup,
    maxCandidateGroups: effectiveThresholds.maxCandidateGroups,
    maxReviewGroups: effectiveThresholds.maxReviewGroups,
    maxMutedGroups: effectiveThresholds.maxMutedGroups,
    maxTokensPerFile: effectiveThresholds.maxTokensPerFile,
  };
  if (typeof effectiveThresholds.maxGroups === "number") {
    artifactThresholds.maxGroups = effectiveThresholds.maxGroups;
  }

  return {
    schemaVersion: BLOCK_CLONE_SCHEMA_VERSION,
    policyVersion: BLOCK_CLONE_POLICY_VERSION,
    status,
    generated,
    root,
    scanRange: {
      includeTests,
      exclude,
    },
    normalization: {
      policyId: BLOCK_CLONE_NORMALIZATION_POLICY_ID,
      mode: "alpha-identifier",
      preservePropertyNames: true,
      preserveImportSpecifiers: true,
      literalPolicy: "classify",
      importDeclarationPolicy: "skip",
    },
    thresholds: artifactThresholds,
    summary: {
      fileCount: tokenizedFiles.length,
      tokenCount: tokenizedFiles.reduce(
        (sum, file) => sum + file.tokens.length,
        0,
      ),
      groupCount: groups.length,
      instanceCount: groups.reduce(
        (sum, group) => sum + group.instances.length,
        0,
      ),
      skippedFileCount: skipped.length,
      unavailableFileCount,
      reviewGroupCount: noisePolicy.reviewGroupCount,
      mutedGroupCount: noisePolicy.mutedGroupCount,
    },
    noisePolicy,
    groups,
    skipped,
    diagnostics,
  };
}

export function collectBlockCloneFiles(root, options = {}) {
  return collectFiles(root, {
    includeTests: options.includeTests,
    exclude: options.exclude,
    languages: JS_FAMILY_LANGS,
  });
}
