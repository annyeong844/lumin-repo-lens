// Post-write delta artifact writer (P2-1 step 3).
//
// Dual-write:
//   <outputDir>/post-write-delta.latest.json
//   <outputDir>/post-write-delta.<preWriteInvocationId>.<deltaInvocationId>.json
//
// Atomic temp+rename — a crash mid-write leaves no partial file at either path.
// Re-running post-write with a fresh deltaInvocationId produces a new specific
// file (never overwrites a prior specific) while latest.json tracks the newest.

import path from 'node:path';
import { atomicWrite } from './atomic-write.mjs';

export { generateInvocationId as generateDeltaInvocationId } from './pre-write-artifact.mjs';

/**
 * Write a DeltaResult to `<outputDir>`. Returns `{latestPath, specificPath}`.
 *
 * @param {string} outputDir
 * @param {object} delta  DeltaResult from computeDelta; MUST carry
 *                        non-empty string `preWriteInvocationId` and
 *                        `deltaInvocationId`.
 */
export function writeDelta(outputDir, delta) {
  if (!delta || typeof delta.preWriteInvocationId !== 'string' || delta.preWriteInvocationId.length === 0) {
    throw new Error('writeDelta: delta.preWriteInvocationId is required (non-empty string)');
  }
  if (typeof delta.deltaInvocationId !== 'string' || delta.deltaInvocationId.length === 0) {
    throw new Error('writeDelta: delta.deltaInvocationId is required (non-empty string)');
  }

  const content = JSON.stringify(delta, null, 2) + '\n';
  const latestPath = path.join(outputDir, 'post-write-delta.latest.json');
  const specificPath = path.join(
    outputDir,
    `post-write-delta.${delta.preWriteInvocationId}.${delta.deltaInvocationId}.json`,
  );

  atomicWrite(specificPath, content);
  atomicWrite(latestPath, content);
  return { latestPath, specificPath };
}
