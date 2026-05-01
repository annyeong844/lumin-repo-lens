#!/usr/bin/env node
// post-write.mjs — P2-1 CLI entry for the post-write delta.
//
// Flags per maintainer history notes v3 §4.6:
//   --root <path>                repository root (required)
//   --output <dir>               artifact dir (source of after-inventory)
//   --pre-write-advisory <file>  advisory JSON (required)
//   --delta-out <dir>            where delta artifact lands (defaults to --output)
//   --no-fresh-audit             skip cold-cache spawn of any-inventory.mjs
//   --include-tests / --no-include-tests / --production / --exclude
//                                forwarded to any-inventory.mjs
//
// Exit codes:
//   0 — delta computed (may contain silent-new; acknowledgment is a caller concern)
//   1 — fatal error (missing flag, unreadable advisory, malformed JSON)
//
// CLI generates deltaInvocationId locally and injects into computeDelta —
// keeps computeDelta pure (maintainer history notes v3 §4.1 purity contract).

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from '../lib/cli.mjs';
import { loadIfExists } from '../lib/artifacts.mjs';
import { computeDelta } from '../lib/post-write-delta.mjs';
import { computeFileDelta, repoRelativeFileList } from '../lib/post-write-file-delta.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { renderMarkdown } from '../lib/post-write-render.mjs';
import { writeDelta, generateDeltaInvocationId } from '../lib/post-write-artifact.mjs';

const SKILL_ROOT = path.dirname(fileURLToPath(import.meta.url));

function die(msg, code = 1) {
  process.stderr.write(`[post-write] ${msg}\n`);
  process.exit(code);
}

// ── Parse args ───────────────────────────────────────────────

const args = parseCliArgs({
  'pre-write-advisory': { type: 'string' },
  'delta-out': { type: 'string' },
  'no-fresh-audit': { type: 'boolean', default: false },
});

const advisoryFlag = args.raw?.['pre-write-advisory'];
if (!advisoryFlag) die('--pre-write-advisory <file> is required');

const ROOT = args.root;
const OUTPUT = args.output;
const DELTA_OUT = args.raw?.['delta-out']
  ? path.resolve(args.raw['delta-out'])
  : OUTPUT;
if (DELTA_OUT !== OUTPUT) mkdirSync(DELTA_OUT, { recursive: true });

const noFreshAudit = args.raw?.['no-fresh-audit'] === true;

// ── Load advisory ───────────────────────────────────────────

const advisoryPath = path.resolve(advisoryFlag);
if (!existsSync(advisoryPath)) die(`advisory file not found: ${advisoryPath}`);

let preWriteAdvisory;
try { preWriteAdvisory = JSON.parse(readFileSync(advisoryPath, 'utf8')); }
catch (e) { die(`advisory parse failed: ${e.message}`); }

// ── Cold-cache spawn of any-inventory.mjs for after-snapshot ─

if (!noFreshAudit) {
  const inventoryCli = path.join(SKILL_ROOT, 'any-inventory.mjs');
  const hookArgs = [inventoryCli, '--root', ROOT, '--output', OUTPUT];
  // Match pre-write hook convention: includeTests===false → --production flag.
  if (args.includeTests === false) hookArgs.push('--production');
  for (const exc of (args.exclude ?? [])) hookArgs.push('--exclude', exc);

  process.stderr.write(`[post-write] running any-inventory.mjs for after-snapshot\n`);
  try {
    execFileSync(process.execPath, hookArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (e) {
    // Non-fatal — computeDelta will report capabilityParity: 'missing' with a failure entry.
    process.stderr.write(`[post-write] any-inventory.mjs failed: ${e?.message?.slice(0, 200) ?? 'unknown'}\n`);
  }
}

// ── Load after-inventory ────────────────────────────────────

const afterInventory = loadIfExists(OUTPUT, 'any-inventory.json', { tag: 'post-write' });

// ── Load before-inventory via advisory.preWrite.anyInventoryPath ─

function uniqueTruthy(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(String(value));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

let beforeInventory = null;
const beforeRelPath = preWriteAdvisory?.preWrite?.anyInventoryPath;
if (beforeRelPath) {
  const beforeDirs = uniqueTruthy([
    path.dirname(advisoryPath),
    preWriteAdvisory?.scanRange?.output,
    OUTPUT,
  ]);
  for (const dir of beforeDirs) {
    beforeInventory = loadIfExists(dir, beforeRelPath, { tag: 'post-write' });
    if (beforeInventory) break;
  }
}

// ── Compute delta ───────────────────────────────────────────
//
// deltaInvocationId is generated HERE (CLI-level) and injected into
// computeDelta, which keeps computeDelta pure per §4.1.

const deltaInvocationId = generateDeltaInvocationId();
let afterFiles = null;
let afterFileScanFailure = null;
try {
  afterFiles = repoRelativeFileList(ROOT, collectFiles(ROOT, {
    includeTests: args.includeTests,
    exclude: args.exclude,
  }));
} catch (e) {
  afterFileScanFailure = e?.message?.slice(0, 400) ?? 'unknown';
}

const fileDelta = computeFileDelta({
  root: ROOT,
  plannedFiles: preWriteAdvisory?.intent?.files ?? [],
  beforeFiles: preWriteAdvisory?.preWrite?.fileInventory?.status === 'available'
    ? preWriteAdvisory.preWrite.fileInventory.files
    : null,
  afterFiles,
  afterScanFailure: afterFileScanFailure,
});

const delta = {
  ...computeDelta({
  preWriteAdvisory,
  beforeInventory,
  afterInventory,
  deltaInvocationId,
  }),
  fileDelta,
};

// ── Write artifact + emit Markdown ──────────────────────────

writeDelta(DELTA_OUT, delta);
const md = renderMarkdown(delta);
process.stdout.write(md);

process.exit(0);
