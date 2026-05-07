const DEFAULT_MAX_CHARS = 2048;

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function oneLine(value, limit) {
  return stripAnsi(String(value ?? ''))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/`/g, '')
    .trim()
    .slice(0, limit);
}

function sortEvents(events) {
  return [...events].sort((a, b) =>
    String(a?.created_at ?? '').localeCompare(String(b?.created_at ?? '')) ||
    String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
  );
}

function locationFor(data = {}) {
  const file = oneLine(data.file, 160) || 'unknown';
  return typeof data.line === 'number' && Number.isFinite(data.line)
    ? `${file}:${data.line}`
    : file;
}

function eventBlock(entry) {
  const data = entry?.data ?? {};
  const id = oneLine(entry?.id, 80) || 'unknown-event';
  const kind = oneLine(entry?.kind, 64) || 'event';
  const escapeKind = oneLine(data.escape_kind, 64) || 'escape';
  const snippet = oneLine(data.snippet, 160) || oneLine(data.matched_line_text, 160) || 'source omitted';
  const symbol = oneLine(data.enclosing_symbol, 64) || 'unknown';
  const occurrenceCount = Number.isFinite(entry?.occurrence_count)
    ? Math.max(1, entry.occurrence_count)
    : 1;

  const summary = occurrenceCount > 1
    ? `${locationFor({ ...data, line: null })} — ${occurrenceCount} matching escapes near \`${symbol}\`; example ${escapeKind}: ${snippet}`
    : `${locationFor(data)} — ${kind} ${escapeKind} near \`${symbol}\`: ${snippet}`;

  return `${summary}\nEvent id ${id}.`;
}

function assembleText(blocks, omittedCount) {
  const lines = [
    '[audit · observed in this/previous tool batch]',
    '',
    ...blocks,
  ];

  if (omittedCount > 0) {
    lines.push('', `${omittedCount} more audit event(s) omitted by context budget.`);
  }

  lines.push(
    '',
    'If this event was already acknowledged, ignore this transcript context.',
    'The live ledger controls future reminders.',
    '',
    'To acknowledge, place a single line in your reply by itself (NOT inside a code fence):',
    'AUDIT_ACK <event id> <intentional|fixed|noted>'
  );

  return `${lines.join('\n')}\n`;
}

export function renderEventReminderContext(events, opts = {}) {
  const maxChars = Number.isFinite(opts.maxChars) ? Math.max(0, opts.maxChars) : DEFAULT_MAX_CHARS;
  const sorted = sortEvents(Array.isArray(events) ? events : []);
  if (sorted.length === 0) {
    return { text: '', eventIds: [], omittedCount: 0 };
  }

  const blocks = [];
  const eventIds = [];
  for (const entry of sorted) {
    const nextBlocks = [...blocks, eventBlock(entry)];
    const omittedCount = sorted.length - nextBlocks.length;
    const candidate = assembleText(nextBlocks, omittedCount);
    if (candidate.length > maxChars) break;
    blocks.push(nextBlocks[nextBlocks.length - 1]);
    eventIds.push(entry.id);
  }

  if (blocks.length === 0) {
    return { text: '', eventIds: [], omittedCount: sorted.length };
  }

  const omittedCount = sorted.length - blocks.length;
  return {
    text: assembleText(blocks, omittedCount),
    eventIds,
    omittedCount,
  };
}
