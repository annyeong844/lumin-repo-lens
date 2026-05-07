import { readFileSync } from 'node:fs';

import { extractTypeEscapes } from './extract-ts-escapes.mjs';
import { appendEventIfNotDeduped } from './hook-event-store.mjs';
import { drainDueEventReminders } from './hook-event-drain.mjs';
import { safeSessionId, safeToolUseId } from './hook-id-safety.mjs';
import {
  getToolTargetPath,
  resolveAuditRoot,
  safeRepoPathForToolInput,
} from './hook-path-safety.mjs';
import {
  cleanupPreimage,
  readPreimage,
} from './hook-preimage-store.mjs';

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

function emptyResult() {
  return {
    processedFiles: 0,
    appendedEventIds: [],
    preimageIncompleteFiles: [],
    output: null,
  };
}

function groupToolCalls(payload, cwd) {
  const groups = new Map();
  const toolCalls = Array.isArray(payload?.tool_calls) ? payload.tool_calls : [];
  for (const call of toolCalls) {
    const toolName = call?.tool_name;
    if (!MUTATING_TOOLS.has(toolName)) continue;
    const toolInput = call?.tool_input ?? {};
    const targetPath = getToolTargetPath(toolName, toolInput);
    const safe = safeRepoPathForToolInput(cwd, targetPath);
    if (!safe.ok) continue;
    const tid = safeToolUseId({
      tool_use_id: call?.tool_use_id,
      tool_name: toolName,
      tool_input: toolInput,
    });
    if (!groups.has(safe.repoRel)) {
      groups.set(safe.repoRel, { safe, calls: [] });
    }
    groups.get(safe.repoRel).calls.push({ tid, call });
  }
  return groups;
}

function countByOccurrenceKey(facts) {
  const counts = new Map();
  for (const fact of facts ?? []) {
    if (typeof fact?.occurrenceKey !== 'string') continue;
    const current = counts.get(fact.occurrenceKey);
    if (current) {
      current.count++;
      continue;
    }
    counts.set(fact.occurrenceKey, { count: 1, fact });
  }
  return counts;
}

function addedOccurrences(beforeFacts, afterFacts) {
  const before = countByOccurrenceKey(beforeFacts);
  const after = countByOccurrenceKey(afterFacts);
  const added = [];
  for (const [key, value] of after) {
    const beforeCount = before.get(key)?.count ?? 0;
    const delta = value.count - beforeCount;
    if (delta <= 0) continue;
    added.push({ key, occurrence_delta: delta, fact: value.fact });
  }
  return added.sort((a, b) =>
    (a.fact.line ?? 0) - (b.fact.line ?? 0) ||
    a.key.localeCompare(b.key)
  );
}

function enclosingSymbol(fact) {
  const identity = fact?.insideExportedIdentity;
  if (typeof identity === 'string' && identity.includes('::')) {
    return identity.slice(identity.lastIndexOf('::') + 2) || 'top-level';
  }
  return 'top-level';
}

function eventForOccurrence(fact, occurrenceDelta) {
  return {
    kind: 'silent-new',
    severity: 'warn',
    ack_required: true,
    delivery_policy: 'until_ack',
    diff_key: fact.occurrenceKey,
    dedupe_key: fact.occurrenceKey,
    occurrence_delta: occurrenceDelta,
    data: {
      file: fact.file,
      line: fact.line,
      escape_kind: fact.escapeKind,
      snippet: fact.codeShape,
      enclosing_symbol: enclosingSymbol(fact),
      matched_line_text: fact.codeShape,
    },
  };
}

function preimageFacts(record) {
  const facts = record?.fingerprint?.typeEscapes;
  return Array.isArray(facts) ? facts : null;
}

function extractPostimageFacts(safe) {
  const src = readFileSync(safe.absolute, 'utf8');
  const result = extractTypeEscapes(src, safe.repoRel);
  if (result.parseError) return null;
  return result.typeEscapes ?? [];
}

export function processPostWriteLite(payload = {}, opts = {}) {
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const auditRoot = opts.auditRoot ?? resolveAuditRoot(cwd);
  if (!auditRoot) return emptyResult();
  const sid = opts.sid ?? safeSessionId(payload);
  const groups = groupToolCalls(payload, cwd);
  if (groups.size === 0) return emptyResult();

  const appendedEventIds = [];
  const preimageIncompleteFiles = [];
  let processedFiles = 0;

  for (const [repoRel, group] of groups) {
    processedFiles++;
    const first = group.calls[0];
    const firstPreimage = readPreimage(auditRoot, sid, first.tid);
    let beforeFacts = [];
    if (firstPreimage?.absent === true) {
      beforeFacts = [];
    } else {
      const facts = preimageFacts(firstPreimage);
      if (facts) {
        beforeFacts = facts;
      } else {
        preimageIncompleteFiles.push(repoRel);
      }
    }

    let afterFacts;
    try {
      afterFacts = extractPostimageFacts(group.safe);
    } catch {
      afterFacts = null;
    }

    if (afterFacts) {
      for (const added of addedOccurrences(beforeFacts, afterFacts)) {
        const append = appendEventIfNotDeduped(
          auditRoot,
          sid,
          eventForOccurrence(added.fact, added.occurrence_delta),
          opts
        );
        if (append.eventId) appendedEventIds.push(append.eventId);
      }
    }

    for (const { tid } of group.calls) {
      cleanupPreimage(auditRoot, sid, tid);
    }
  }

  const drain = drainDueEventReminders(auditRoot, sid, {
    ...opts,
    hookEventName: 'PostToolBatch',
  });

  return {
    processedFiles,
    appendedEventIds,
    preimageIncompleteFiles,
    output: drain.output,
  };
}
