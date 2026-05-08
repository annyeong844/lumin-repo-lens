#!/usr/bin/env node

import {
  emitHookOutput,
  importEngineModule,
  readJsonFromStdin,
  runHookMain,
} from './_runner-utils.mjs';

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

await runHookMain(async () => {
  const payload = readJsonFromStdin();
  if (!payload) return;

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const {
    getToolTargetPath,
    resolveAuditRoot,
    safeRepoPathForToolInput,
  } = await importEngineModule('hook-path-safety.mjs');
  const {
    safeSessionId,
    safeToolUseId,
  } = await importEngineModule('hook-id-safety.mjs');
  const { capturePreimage } = await importEngineModule('hook-preimage-store.mjs');
  const { drainDueEventReminders } = await importEngineModule('hook-event-drain.mjs');

  const auditRoot = resolveAuditRoot(cwd);
  if (!auditRoot) return;
  const sid = safeSessionId(payload);

  if (MUTATING_TOOLS.has(payload.tool_name)) {
    try {
      const targetPath = getToolTargetPath(payload.tool_name, payload.tool_input ?? {});
      const safe = safeRepoPathForToolInput(cwd, targetPath);
      if (safe.ok) {
        const tid = safeToolUseId({
          tool_use_id: payload.tool_use_id,
          tool_name: payload.tool_name,
          tool_input: payload.tool_input ?? {},
        });
        capturePreimage({ auditRoot, sid, tid, safe });
      }
    } catch {
      // Continue to drain reminders even when preimage capture cannot proceed.
    }
  }

  const drain = drainDueEventReminders(auditRoot, sid, {
    hookEventName: 'PreToolUse',
  });
  emitHookOutput(drain.output);
});
