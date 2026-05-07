import { createHash } from 'node:crypto';

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CONTENT_FIELDS = new Set(['content', 'old_string', 'new_string']);

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function normalizeForId(value) {
  if (Array.isArray(value)) return value.map(normalizeForId);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (CONTENT_FIELDS.has(key) && typeof child === 'string') {
      out[key] = {
        sha256: sha256Hex(child),
        byteLength: byteLength(child),
      };
      continue;
    }
    out[key] = normalizeForId(child);
  }
  return out;
}

export function isSafeId(raw) {
  return typeof raw === 'string' && SAFE_ID_RE.test(raw);
}

export function safeSessionId(payload = {}) {
  if (isSafeId(payload.session_id)) return payload.session_id;
  if (typeof payload.transcript_path === 'string' && payload.transcript_path.length > 0) {
    return `sid_${sha256Hex(payload.transcript_path).slice(0, 16)}`;
  }
  return 'default-session';
}

export function safeToolUseId(payload = {}) {
  if (isSafeId(payload.tool_use_id)) return payload.tool_use_id;
  const material = {
    tool_name: payload.tool_name ?? null,
    tool_input: normalizeForId(payload.tool_input ?? {}),
  };
  return `tool_${sha256Hex(JSON.stringify(material)).slice(0, 16)}`;
}
