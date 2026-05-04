// _lib/function-signature-hash.mjs - exact exported function type-signature cues.
//
// This module deliberately normalizes type contracts, not implementation
// bodies. It is review evidence only: same signature does not mean same
// semantics.

import { createHash } from 'node:crypto';

import { parseOxcOrThrow } from './parse-oxc.mjs';
import { normalizeTypeText } from './shape-hash.mjs';

export const FUNCTION_SIGNATURE_NORMALIZED_VERSION = 'function-signature.normalized.v1';

function sourceSlice(src, node) {
  if (!node || typeof node.start !== 'number' || typeof node.end !== 'number') return '';
  return src.slice(node.start, node.end);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
  return out;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function hashNormalizedSignature(normalizedSignature) {
  return 'sha256:' + createHash('sha256').update(stableJson(normalizedSignature)).digest('hex');
}

function regexEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function typeParameterNames(typeParameters) {
  return (typeParameters?.params ?? [])
    .map((param) => param?.name?.name)
    .filter((name) => typeof name === 'string' && name.length > 0);
}

function typeParamMap(typeParameters) {
  const out = new Map();
  for (const [index, name] of typeParameterNames(typeParameters).entries()) {
    out.set(name, `$T${index}`);
  }
  return out;
}

function normalizeTypeParamNames(text, map) {
  let out = text;
  for (const [name, replacement] of map) {
    out = out.replace(
      new RegExp(`(^|[^A-Za-z0-9_$])${regexEscape(name)}(?=$|[^A-Za-z0-9_$])`, 'g'),
      `$1${replacement}`
    );
  }
  return out;
}

function stripFunctionTypeParamNames(text) {
  return text.replace(/([,(])\s*(?:\.\.\.)?[A-Za-z_$][\w$]*\??\s*:/g, '$1');
}

function normalizeTypeNode(typeNode, src, map) {
  if (!typeNode) return null;
  const raw = sourceSlice(src, typeNode);
  if (!raw) return null;
  return stripFunctionTypeParamNames(
    normalizeTypeParamNames(normalizeTypeText(raw), map)
  );
}

function normalizeTypeParameters(typeParameters, src, map) {
  return (typeParameters?.params ?? []).map((param, index) => ({
    name: `$T${index}`,
    constraint: normalizeTypeNode(param.constraint, src, map),
    default: normalizeTypeNode(param.default, src, map),
  }));
}

function unwrapParam(param) {
  if (param?.type === 'RestElement') return { node: param.argument, rest: true };
  return { node: param, rest: false };
}

function paramTypeNode(param) {
  return param?.typeAnnotation?.typeAnnotation ?? null;
}

function normalizeParam(param, src, map) {
  const { node, rest } = unwrapParam(param);
  const type = normalizeTypeNode(paramTypeNode(node), src, map);
  return {
    rest,
    optional: node?.optional === true,
    type,
  };
}

function hasSignatureEvidence(params, returnType) {
  return typeof returnType === 'string' &&
    params.every((param) => typeof param.type === 'string' && param.type.length > 0);
}

function signatureText(normalizedSignature) {
  const typeParams = normalizedSignature.typeParameters?.length
    ? `<${normalizedSignature.typeParameters.map((param) => {
        const suffix = [
          param.constraint ? ` extends ${param.constraint}` : '',
          param.default ? ` = ${param.default}` : '',
        ].join('');
        return `${param.name}${suffix}`;
      }).join(',')}>`
    : '';
  const params = (normalizedSignature.params ?? []).map((param) => {
    const rest = param.rest ? '...' : '';
    const optional = param.optional ? '?' : '';
    return `${rest}${optional}${param.type ?? 'unknown'}`;
  }).join(',');
  return `${typeParams}(${params}):${normalizedSignature.returnType ?? 'unknown'}`;
}

function buildSignature({ typeParameters, params, returnType, src }) {
  const map = typeParamMap(typeParameters);
  const normalizedTypeParameters = normalizeTypeParameters(typeParameters, src, map);
  const normalizedParams = (params ?? []).map((param) => normalizeParam(param, src, map));
  const normalizedReturnType = normalizeTypeNode(returnType?.typeAnnotation, src, map);

  if (!hasSignatureEvidence(normalizedParams, normalizedReturnType)) {
    return { ok: false, reason: 'no-explicit-function-signature' };
  }

  const normalizedSignature = {
    schemaVersion: FUNCTION_SIGNATURE_NORMALIZED_VERSION,
    typeParameters: normalizedTypeParameters,
    params: normalizedParams,
    returnType: normalizedReturnType,
  };
  return {
    ok: true,
    hash: hashNormalizedSignature(normalizedSignature),
    signature: signatureText(normalizedSignature),
    normalizedSignature,
  };
}

export function functionSignatureFromFunctionNode(fn, src) {
  if (!fn || typeof fn !== 'object') return { ok: false, reason: 'missing-function-node' };
  return buildSignature({
    typeParameters: fn.typeParameters,
    params: fn.params ?? [],
    returnType: fn.returnType,
    src,
  });
}

function functionTypeAliasAnnotation(program) {
  for (const stmt of program?.body ?? []) {
    const declaration = stmt?.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (declaration?.type !== 'TSTypeAliasDeclaration') continue;
    const annotation = declaration.typeAnnotation;
    if (annotation?.type === 'TSFunctionType') return annotation;
    return null;
  }
  return null;
}

export function functionSignatureFromTypeLiteral(typeLiteral) {
  const literal = String(typeLiteral ?? '').trim().replace(/;+$/, '');
  if (!literal) return { ok: false, reason: 'empty-function-signature-literal' };
  let parsed;
  try {
    parsed = parseOxcOrThrow('__intent_function_signature.ts', `export type __IntentFunction = ${literal};\n`);
  } catch (e) {
    return { ok: false, reason: 'function-signature-parse-error', message: e.message };
  }
  const annotation = functionTypeAliasAnnotation(parsed.program);
  if (!annotation) {
    return { ok: false, reason: 'unsupported-function-signature-literal' };
  }
  return buildSignature({
    typeParameters: annotation.typeParameters,
    params: annotation.params ?? [],
    returnType: annotation.returnType,
    src: `export type __IntentFunction = ${literal};\n`,
  });
}
