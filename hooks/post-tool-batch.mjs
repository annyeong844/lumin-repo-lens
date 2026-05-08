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

  const { processPostWriteLite } = await importEngineModule('hook-post-write-lite.mjs');
  const result = processPostWriteLite(payload);
  emitHookOutput(result.output);
});
