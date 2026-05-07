import { isSafeId } from './hook-id-safety.mjs';
import { markAcknowledged } from './hook-event-store.mjs';

const ACK_RE = /^AUDIT_ACK\s+([A-Za-z0-9_-]{1,128})\s+(intentional|fixed|noted)$/;

function fenceMarker(line) {
  const match = /^\s*(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  return {
    char: match[1][0],
    length: match[1].length,
  };
}

function closesFence(line, fence) {
  const match = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  return Boolean(
    match &&
    match[1][0] === fence.char &&
    match[1].length >= fence.length
  );
}

function isIndentedCode(line) {
  return /^(?: {4}|\t)/.test(line);
}

function isBlockquote(line) {
  return /^\s*>/.test(line);
}

function isInlineCodeAck(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('`') && trimmed.endsWith('`');
}

export function parseAuditAckLines(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  const results = [];
  let fence = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }

    const openingFence = fenceMarker(line);
    if (openingFence) {
      fence = openingFence;
      continue;
    }

    if (isIndentedCode(line) || isBlockquote(line) || isInlineCodeAck(line)) {
      continue;
    }

    const match = ACK_RE.exec(line.trim());
    if (!match) continue;
    const eventId = match[1];
    if (!isSafeId(eventId)) continue;
    results.push({
      eventId,
      ackSource: match[2],
      line: i + 1,
    });
  }

  return results;
}

function textFromPayload(payload, opts) {
  if (typeof payload?.last_assistant_message === 'string') {
    return payload.last_assistant_message;
  }
  if (typeof opts?.transcriptText === 'string') {
    return opts.transcriptText;
  }
  return '';
}

export function observeStopAcknowledgements(auditRoot, sid, payload = {}, opts = {}) {
  const acknowledgements = parseAuditAckLines(textFromPayload(payload, opts));
  const eventIds = [];
  let acknowledged = 0;

  for (const ack of acknowledgements) {
    const ok = markAcknowledged(auditRoot, sid, ack.eventId, ack.ackSource, opts);
    if (!ok) continue;
    acknowledged++;
    eventIds.push(ack.eventId);
  }

  return {
    observed: acknowledgements.length,
    acknowledged,
    ignored: acknowledgements.length - acknowledged,
    eventIds,
  };
}
