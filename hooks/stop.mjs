#!/usr/bin/env node

import {
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
  const { observeStopAcknowledgements } = await importEngineModule('hook-ack-observer.mjs');

  const auditRoot = resolveAuditRoot(cwd);
  if (!auditRoot) return;
  observeStopAcknowledgements(auditRoot, safeSessionId(payload), payload);
});
