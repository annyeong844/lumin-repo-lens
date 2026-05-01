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

const UNAVAILABLE_CITATION =
  '[확인 불가, shape-index.json absent; run build-shape-index.mjs to enable P4 shape-hash lookup]';

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

function resolveShapeHash(shape) {
  const hasHash = shape?.hash !== undefined;
  const hasTypeLiteral = shape?.typeLiteral !== undefined;

  let literalHash = null;
  let literalCitation = null;
  if (hasTypeLiteral) {
    const normalized = normalizeIntentTypeLiteral(shape.typeLiteral);
    if (!normalized.ok) return normalized;
    literalHash = normalized.hash;
    literalCitation = normalized.citation;
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
      source: literalCitation ? 'hash+typeLiteral' : 'hash',
    };
  }

  if (literalHash) {
    return {
      ok: true,
      hash: literalHash,
      citations: [literalCitation],
      source: 'typeLiteral',
    };
  }

  return {
    ok: false,
    citation: '[확인 불가, shape intent lacks exact sha256 shape hash or typeLiteral; field names alone are not structural equality evidence for P4 shape-hash lookup]',
  };
}

export function lookupShape(shape, ctx = {}) {
  const shapeIndex = ctx.shapeIndex ?? null;
  const resolved = resolveShapeHash(shape);
  if (!resolved.ok) {
    return unavailable(shape, resolved.citation);
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
