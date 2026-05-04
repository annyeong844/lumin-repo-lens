// Shape-candidate lookup for the pre-write gate (P1-2/P4-3).
//
// This function may consult P4's shape-index.json, but ONLY by exact
// shape-hash. The hash can be supplied directly (`shape.hash`) or derived
// from `shape.typeLiteral` using the same P4 normalizer. Legacy
// `{ fields: [...] }` intent entries are still UNAVAILABLE because field
// names alone are not structural equality.
//
// No symbol-index enumeration, no field-overlap comparison, no heuristic
// grep. Shape-match claims must come from the shape-hash producer, not from
// ad hoc matching.

import { extractShapeHashFactsFromSource } from './shape-hash.mjs';
import { SHAPE_HASH_RE, parseShapeIndexArtifact } from './shape-index-schema.mjs';
import { functionSignatureFromTypeLiteral } from './function-signature-hash.mjs';

const UNAVAILABLE_CITATION =
  '[확인 불가, shape-index.json absent; run build-shape-index.mjs to enable P4 shape-hash lookup]';
const FUNCTION_SIGNATURE_UNAVAILABLE_CITATION =
  '[확인 불가, function-clones.json absent; run build-function-clone-index.mjs to enable function signature lookup]';

function unavailable(shape, citation, extra = {}) {
  return {
    kind: 'shape',
    shape,
    result: 'UNAVAILABLE',
    citations: Array.isArray(citation) ? citation : [citation],
    ...extra,
  };
}

function normalizeIntentTypeLiteral(typeLiteral) {
  const literal = String(typeLiteral ?? '').trim().replace(/;+$/, '');
  if (!literal) {
    return {
      ok: false,
      citation: '[확인 불가, shape.typeLiteral is empty; cannot compute exact shape hash]',
    };
  }
  const src = `export type __IntentShape = ${literal};\n`;
  const result = extractShapeHashFactsFromSource(src, '__intent_shape.ts', {
    observedAt: 'intent',
  });
  if (result.facts.length !== 1) {
    const reason = result.diagnostics?.[0]?.code ?? 'unsupported-intent-shape';
    return {
      ok: false,
      citation: `[확인 불가, shape.typeLiteral could not be normalized to a supported shape; reason: ${reason}]`,
    };
  }
  const fact = result.facts[0];
  const shapeKind = fact.shapeKind ?? 'object';
  const evidenceCount = shapeKind === 'literal-union'
    ? `${fact.literals?.length ?? 0} literals`
    : `${fact.fields?.length ?? 0} fields`;
  return {
    ok: true,
    hash: fact.hash,
    citation: `[grounded, shape.typeLiteral normalized as ${shapeKind} with ${evidenceCount} via shape-hash.normalized.v1]`,
  };
}

function normalizeIntentFunctionSignature(typeLiteral) {
  const normalized = functionSignatureFromTypeLiteral(typeLiteral);
  if (!normalized.ok) return normalized;
  return {
    ok: true,
    hash: normalized.hash,
    signature: normalized.signature,
    citation: `[grounded, shape.typeLiteral normalized as function signature via function-signature.normalized.v1]`,
  };
}

function resolveShapeHash(shape) {
  const hasHash = shape?.hash !== undefined;
  const hasTypeLiteral = shape?.typeLiteral !== undefined;

  let literalHash = null;
  let literalCitation = null;
  let literalSignature = null;
  let literalKind = 'shape';
  if (hasTypeLiteral) {
    const functionSignature = normalizeIntentFunctionSignature(shape.typeLiteral);
    const normalized = functionSignature.ok
      ? functionSignature
      : normalizeIntentTypeLiteral(shape.typeLiteral);
    if (!normalized.ok) return normalized;
    literalHash = normalized.hash;
    literalCitation = normalized.citation;
    literalSignature = normalized.signature ?? null;
    literalKind = functionSignature.ok ? 'function-signature' : 'shape';
  }

  if (hasHash) {
    if (typeof shape.hash !== 'string' || !SHAPE_HASH_RE.test(shape.hash)) {
      return {
        ok: false,
        citation: `[확인 불가, invalid shape hash ${JSON.stringify(shape.hash)}; expected sha256:<64 lowercase hex>]`,
      };
    }
    if (literalHash && literalHash !== shape.hash) {
      return {
        ok: false,
        citation: [
          literalCitation,
          `[확인 불가, shape.hash does not match shape.typeLiteral normalized hash; hash=${shape.hash}, typeLiteralHash=${literalHash}]`,
        ],
      };
    }
    return {
      ok: true,
      hash: shape.hash,
      citations: literalCitation ? [literalCitation] : [],
      source: literalCitation ? `hash+typeLiteral:${literalKind}` : 'hash',
      kind: literalKind,
      ...(literalSignature ? { signature: literalSignature } : {}),
    };
  }

  if (literalHash) {
    return {
      ok: true,
      hash: literalHash,
      citations: [literalCitation],
      source: literalKind === 'function-signature' ? 'functionSignature' : 'typeLiteral',
      kind: literalKind,
      ...(literalSignature ? { signature: literalSignature } : {}),
    };
  }

  return {
    ok: false,
    citation: '[확인 불가, shape intent lacks exact sha256 shape hash or typeLiteral; field names alone are not structural equality evidence for P4 shape-hash lookup]',
  };
}

function lookupFunctionSignature(shape, resolved, functionClones) {
  const signatureHash = resolved.hash;
  if (!functionClones) {
    return unavailable(shape, FUNCTION_SIGNATURE_UNAVAILABLE_CITATION, {
      shapeHash: signatureHash,
      shapeHashSource: resolved.source,
      signature: resolved.signature,
    });
  }

  const facts = Array.isArray(functionClones.facts) ? functionClones.facts : [];
  const matchingFacts = facts
    .filter((fact) => fact.normalizedSignatureHash === signatureHash)
    .sort((a, b) => a.identity.localeCompare(b.identity));
  const matches = matchingFacts.map((fact) => ({
    identity: fact.identity,
    ownerFile: fact.ownerFile ?? fact.identity.split('::')[0],
    exportedName: fact.exportedName ?? fact.identity.split('::').pop(),
    hash: signatureHash,
    signature: fact.signature ?? resolved.signature,
    confidence: fact.confidence ?? 'medium',
  }));

  if (matches.length > 0) {
    const citations = [
      ...(resolved.citations ?? []),
      `[grounded, function-clones.json facts[] matched ${matches.length} identities for function signature ${signatureHash}]`,
    ];
    if (functionClones.meta?.complete !== true) {
      citations.push('[degraded, function-clones.json is incomplete; positive signature match is grounded but absence claims are unavailable]');
    }
    return {
      kind: 'shape',
      shape,
      shapeHash: signatureHash,
      shapeHashSource: resolved.source,
      signature: resolved.signature,
      result: 'SIGNATURE_MATCH',
      matches,
      citations,
    };
  }

  if (functionClones.meta?.complete !== true) {
    return unavailable(
      shape,
      [
        ...(resolved.citations ?? []),
        `[확인 불가, function-clones.json is incomplete; function signature ${signatureHash} was not observed but absence is not grounded]`,
      ],
      { shapeHash: signatureHash, shapeHashSource: resolved.source, signature: resolved.signature }
    );
  }

  return {
    kind: 'shape',
    shape,
    shapeHash: signatureHash,
    shapeHashSource: resolved.source,
    signature: resolved.signature,
    result: 'NOT_OBSERVED',
    matches: [],
    citations: [
      ...(resolved.citations ?? []),
      `[grounded, complete function-clones.json has no normalizedSignatureHash '${signatureHash}' entry]`,
    ],
  };
}

export function lookupShape(shape, ctx = {}) {
  const shapeIndex = ctx.shapeIndex ?? null;
  const functionClones = ctx.functionClones ?? null;
  const resolved = resolveShapeHash(shape);
  if (!resolved.ok) {
    return unavailable(shape, resolved.citation);
  }

  if (resolved.kind === 'function-signature') {
    return lookupFunctionSignature(shape, resolved, functionClones);
  }

  if (!shapeIndex) {
    return unavailable(shape, UNAVAILABLE_CITATION);
  }

  const parsedIndex = parseShapeIndexArtifact(shapeIndex);
  if (!parsedIndex.ok) {
    return unavailable(
      shape,
      `[확인 불가, malformed shape-index.json; ${parsedIndex.reason}: ${parsedIndex.detail}]`
    );
  }

  const shapeHash = resolved.hash;
  const matchingFacts = [...(parsedIndex.factsByHash.get(shapeHash) ?? [])]
    .sort((a, b) => a.identity.localeCompare(b.identity));
  const matches = matchingFacts.map((fact) => {
    const identity = fact.identity;
    return {
      identity,
      ownerFile: fact.ownerFile ?? identity.split('::')[0],
      exportedName: fact.exportedName ?? identity.split('::').pop(),
      hash: shapeHash,
      shapeKind: fact.shapeKind ?? 'object',
      fields: fact.fields ?? [],
      ...(fact.literals ? { literals: fact.literals } : {}),
      confidence: fact.confidence ?? 'medium',
    };
  });

  if (matches.length > 0) {
    const citations = [
      ...(resolved.citations ?? []),
      `[grounded, shape-index.json facts[] matched ${matches.length} identities for ${shapeHash}]`,
    ];
    if (parsedIndex.complete !== true) {
      citations.push('[degraded, shape-index.json is incomplete; positive match is grounded but absence claims are unavailable]');
    }
    return {
      kind: 'shape',
      shape,
      shapeHash,
      shapeHashSource: resolved.source,
      result: 'SHAPE_MATCH',
      matches,
      citations,
    };
  }

  if (parsedIndex.complete !== true) {
    return unavailable(
      shape,
      [
        ...(resolved.citations ?? []),
        `[확인 불가, shape-index.json is incomplete; hash ${shapeHash} was not observed but absence is not grounded]`,
      ],
      { shapeHash, shapeHashSource: resolved.source }
    );
  }

  return {
    kind: 'shape',
    shape,
    shapeHash,
    shapeHashSource: resolved.source,
    result: 'NOT_OBSERVED',
    matches: [],
    citations: [
      ...(resolved.citations ?? []),
      `[grounded, complete shape-index.json has no groupsByHash['${shapeHash}'] entry]`,
    ],
  };
}
