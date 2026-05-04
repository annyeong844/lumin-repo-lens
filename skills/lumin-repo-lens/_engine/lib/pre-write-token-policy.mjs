export const TOKENIZER_VERSION = 'camel-snake-kebab-digit-v1';
export const TOKEN_POLICY_VERSION = 'prewrite-token-policy-v1';

export const WEAK_COMMON_TOKENS = Object.freeze([
  'add',
  'build',
  'check',
  'create',
  'delete',
  'get',
  'load',
  'make',
  'parse',
  'read',
  'return',
  'save',
  'set',
  'update',
  'write',
]);

const WEAK_COMMON_TOKEN_SET = new Set(WEAK_COMMON_TOKENS);
const TOKEN_ALIASES = Object.freeze({
  artifacts: 'artifact',
});

export function normalizePreWriteToken(token) {
  const t = String(token ?? '').toLowerCase();
  if (TOKEN_ALIASES[t]) return TOKEN_ALIASES[t];
  if (t === 'rel') return 'relative';
  if (t === 'ctx') return 'context';
  if (t === 'cfg') return 'config';
  if (t === 'config') return 'configuration';
  if (t === 'exists' || t === 'existing' || t === 'existence') return 'exist';
  if (t.length > 4 && t.endsWith('ies') && !['series', 'species'].includes(t)) return `${t.slice(0, -3)}y`;
  // Avoid broad trailing-s stemming. It corrupts class/process/status/analysis.
  return t;
}

export function tokenizePreWrite(value) {
  return String(value ?? '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizePreWriteToken);
}

export function uniquePreWriteTokens(...parts) {
  return [...new Set(parts.flatMap(tokenizePreWrite))];
}

export function isWeakCommonToken(token) {
  return WEAK_COMMON_TOKEN_SET.has(String(token ?? '').toLowerCase());
}

export function tokenPolicyMetadata() {
  return {
    tokenizerVersion: TOKENIZER_VERSION,
    tokenPolicyVersion: TOKEN_POLICY_VERSION,
    weakCommonTokens: [...WEAK_COMMON_TOKENS],
  };
}
