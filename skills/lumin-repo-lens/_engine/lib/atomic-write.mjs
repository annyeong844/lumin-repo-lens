// Atomic file write — temp + rename.
//
// Writes `content` to a sibling `.tmp.<6-hex>` file and renames into place.
// A crash mid-write leaves no partial file at `targetPath`.
//
// Shared by P1 (`writeAdvisory`) and P2 (`writeDelta`). Before v1.10.4 each
// artifact writer rolled its own 4-line copy — byte-for-byte duplicates.
// Atomicity bugs are hard to catch in tests; a single source avoids one
// writer silently skipping Windows rename retry behavior while the other
// doesn't.

import { writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
}

function renameWithRetry(tmpPath, targetPath, { attempts = 8, delayMs = 25 } = {}) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      renameSync(tmpPath, targetPath);
      return;
    } catch (e) {
      lastError = e;
      if (!RETRYABLE_RENAME_CODES.has(e?.code) || i === attempts - 1) break;
      sleepSync(delayMs * (i + 1));
    }
  }
  throw lastError;
}

export function atomicWrite(targetPath, content) {
  const tmpPath = `${targetPath}.tmp.${randomBytes(3).toString('hex')}`;
  writeFileSync(tmpPath, content);
  try {
    renameWithRetry(tmpPath, targetPath);
  } catch (e) {
    rmSync(tmpPath, { force: true });
    throw e;
  }
}
