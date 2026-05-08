#!/usr/bin/env node

import {
  emitHookOutput,
  importEngineModule,
  readJsonFromStdin,
  runHookMain,
} from './_runner-utils.mjs';

await runHookMain(async () => {
  const payload = readJsonFromStdin();
  if (!payload) return;

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const { resolveAuditRoot } = await importEngineModule('hook-path-safety.mjs');
  const { safeSessionId } = await importEngineModule('hook-id-safety.mjs');
  const { drainDueEventReminders } = await importEngineModule('hook-event-drain.mjs');

  const auditRoot = resolveAuditRoot(cwd);
  if (!auditRoot) return;
  const drain = drainDueEventReminders(auditRoot, safeSessionId(payload), {
    hookEventName: 'UserPromptSubmit',
  });
  emitHookOutput(drain.output);
});
