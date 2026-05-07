import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  claimDueDeliveriesAndAdvanceCursor,
  eventStoreDir,
  markDelivered,
} from './hook-event-store.mjs';
import { renderEventReminderContext } from './hook-event-renderer.mjs';

const DEFAULT_HOOK_EVENT_NAME = 'UserPromptSubmit';

function emptyDrain() {
  return {
    emitted: false,
    output: null,
    eventIds: [],
    omittedCount: 0,
  };
}

function ledgerPath(auditRoot, sid) {
  return path.join(eventStoreDir(auditRoot, sid), 'ledger.json');
}

export function drainDueEventReminders(auditRoot, sid, opts = {}) {
  let ledger;
  try {
    ledger = ledgerPath(auditRoot, sid);
  } catch {
    return emptyDrain();
  }

  if (!existsSync(ledger)) {
    return emptyDrain();
  }

  const {
    hookEventName = DEFAULT_HOOK_EVENT_NAME,
    limit = 5,
    maxChars = 2048,
    now = new Date(),
    redeliverAfterMs,
  } = opts;

  const claim = claimDueDeliveriesAndAdvanceCursor(auditRoot, sid, {
    ...opts,
    limit,
    now,
  });
  const rendered = renderEventReminderContext(claim.snapshots, { maxChars });
  if (rendered.text.length === 0 || rendered.eventIds.length === 0) {
    return {
      ...emptyDrain(),
      omittedCount: rendered.omittedCount,
    };
  }

  for (const eventId of rendered.eventIds) {
    markDelivered(auditRoot, sid, eventId, {
      ...opts,
      now,
      redeliverAfterMs,
    });
  }

  return {
    emitted: true,
    output: {
      hookSpecificOutput: {
        hookEventName,
        additionalContext: rendered.text,
      },
    },
    eventIds: rendered.eventIds,
    omittedCount: rendered.omittedCount,
  };
}
