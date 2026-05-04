#!/usr/bin/env node
// pre-write.mjs — P1-1 CLI entry for the pre-write gate.
//
// Per maintainer history notes §4.1 Option A, this CLI is the EXPLICIT dispatch —
// invoking pre-write.mjs IS the decision that the user's request warrants
// pre-write mode. The CLI does NOT call `_lib/mode-dispatch.mjs`.
//
// Flags:
//   --root <path>           repository root (required)
//   --output <dir>          artifact read location (where symbols.json lives)
//   --intent <file|->       intent JSON; use "-" to read from stdin
//   --advisory-out <dir>    where to write the advisory artifacts
//                           (defaults to --output)
//
// Exit codes:
//   0 — normal completion (advisory emitted; may include [확인 불가] rows)
//   1 — malformed intent, missing flags, or unhandled error

import { readFileSync, existsSync, readSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseCliArgs } from '../lib/cli.mjs';
import { loadIfExists } from '../lib/artifacts.mjs';
import { validateIntent } from '../lib/pre-write-intent.mjs';
import { lookupName } from '../lib/pre-write-lookup-name.mjs';
import { lookupFile } from '../lib/pre-write-lookup-file.mjs';
import { lookupDependency } from '../lib/pre-write-lookup-dep.mjs';
import { lookupShape } from '../lib/pre-write-lookup-shape.mjs';
import { classifyPreWriteCues } from '../lib/pre-write-cue-tiers.mjs';
import { parseCanonicalFile } from '../lib/pre-write-canonical-parser.mjs';
import { computeDrift } from '../lib/pre-write-drift.mjs';
import { runColdCachePreflight } from '../lib/pre-write-cold-cache.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { repoRelativeFileList } from '../lib/post-write-file-delta.mjs';
import {
  generateInvocationId,
  hashIntent,
  writeAdvisory,
} from '../lib/pre-write-artifact.mjs';
import { renderMarkdown, renderJson } from '../lib/pre-write-render.mjs';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = path.dirname(fileURLToPath(import.meta.url));

function die(msg, code = 1) {
  process.stderr.write(`[pre-write] ${msg}\n`);
  process.exit(code);
}

function readStdinSync() {
  let buf;
  try {
    // Allocate a buffer large enough for typical intent JSON (intents
    // are small — a few dozen KB max).
    buf = Buffer.alloc(1 << 16);
    let offset = 0;
    while (true) {
      let read = 0;
      try { read = readSync(0, buf, offset, buf.length - offset); }
      catch (e) { if (e.code === 'EAGAIN') continue; throw e; }
      if (read === 0) break;
      offset += read;
      if (offset === buf.length) {
        const bigger = Buffer.alloc(buf.length * 2);
        buf.copy(bigger);
        buf = bigger;
      }
    }
    return buf.slice(0, offset).toString('utf8');
  } catch (e) {
    die(`failed to read stdin: ${e.message}`);
  }
}

// ── Parse args ───────────────────────────────────────────────

const args = parseCliArgs({
  intent: { type: 'string' },
  'advisory-out': { type: 'string' },
  'no-fresh-audit': { type: 'boolean', default: false },
});

const intentFlag = args.raw?.intent;
if (!intentFlag) die('--intent <file|-> is required');

const ROOT = args.root;
const OUTPUT = args.output;
const ADVISORY_OUT = args.raw?.['advisory-out']
  ? path.resolve(args.raw['advisory-out'])
  : OUTPUT;

// ── Load intent ──────────────────────────────────────────────

let intentText;
if (intentFlag === '-') {
  intentText = readStdinSync();
} else {
  const intentPath = path.resolve(intentFlag);
  if (!existsSync(intentPath)) die(`intent file not found: ${intentPath}`);
  try { intentText = readFileSync(intentPath, 'utf8'); }
  catch (e) { die(`failed to read intent: ${e.message}`); }
}

let raw;
try { raw = JSON.parse(intentText); }
catch (e) { die(`intent JSON parse failed: ${e.message}`); }

const validation = validateIntent(raw);
if (!validation.ok) {
  die(`intent schema error at "${validation.errorPath}": ${validation.error}`);
}
const intent = validation.intent;
const intentWarnings = validation.warnings ?? [];

// ── Cold-cache preflight + artifact load ────────────────────

const noFreshAudit = args.raw?.['no-fresh-audit'] === true;
const failures = [];
const needsSymbols =
  intent.names.length > 0 ||
  intent.files.length > 0 ||
  intent.dependencies.length > 0;
const needsShapeIndex = intent.shapes.length > 0;

const preflight = runColdCachePreflight({
  root: ROOT,
  output: OUTPUT,
  skillRoot: SKILL_ROOT,
  fresh: !noFreshAudit,
  intent,
  includeShapeIndex: needsShapeIndex,
  includeTests: args.includeTests,
  exclude: args.exclude,
});
failures.push(...preflight.failures);

const symbols = loadIfExists(OUTPUT, 'symbols.json', { tag: 'pre-write' });
if (needsSymbols && !symbols && !preflight.failures.some((f) => f.kind === 'symbols-missing' || /symbols/i.test(f.kind))) {
  failures.push({ kind: 'symbols-missing', reason: `symbols.json not found in ${OUTPUT}` });
}

const capabilities = symbols?.meta?.supports ?? null;
if (symbols && !capabilities) {
  failures.push({ kind: 'capabilities-missing', reason: 'symbols.json present but meta.supports block absent; producer predates P1-0 preparatory patch' });
}

// ── Parse canonical (best-effort; absence is fine) ───────────

const canonicalPath = path.join(ROOT, 'canonical', 'type-ownership.md');
const canonicalClaims = [];
if (existsSync(canonicalPath)) {
  const parsed = parseCanonicalFile(canonicalPath);
  if (parsed.recognized) {
    for (const table of parsed.ownerTables) {
      for (const row of table.rows) {
        canonicalClaims.push({
          name: row.name,
          ownerFile: row.ownerFile,
          line: row.line,
          file: canonicalPath,
          section: table.section,
        });
      }
    }
  }
}

// ── Load optional P1-2 artifacts ─────────────────────────────

const topology = loadIfExists(OUTPUT, 'topology.json', { tag: 'pre-write' });
const triage = loadIfExists(OUTPUT, 'triage.json', { tag: 'pre-write' });
const shapeIndex = loadIfExists(OUTPUT, 'shape-index.json', { tag: 'pre-write' });
const functionClones = loadIfExists(OUTPUT, 'function-clones.json', { tag: 'pre-write' });

// Read package.json for dependency lookup. Absence is a caller-level
// problem — we still continue, emitting NEW_PACKAGE for every dep.
let packageJson = {};
const pkgPath = path.join(ROOT, 'package.json');
if (existsSync(pkgPath)) {
  try { packageJson = JSON.parse(readFileSync(pkgPath, 'utf8')); }
  catch (e) { failures.push({ kind: 'package-json-parse-error', reason: e.message }); }
}

// ── Run name lookups ─────────────────────────────────────────

const lookups = [];
if (symbols) {
  for (const intentName of intent.names) {
    const intentDeclaration =
      (intent.nameDeclarations ?? []).find((decl) => decl.name === intentName) ?? null;
    const result = lookupName(intentName, { symbols, canonicalClaims, intentDeclaration });
    lookups.push({ kind: 'name', ...result });
  }
} else {
  // Symbols missing — emit a degraded row per intent name.
  for (const intentName of intent.names) {
    lookups.push({
      kind: 'name',
      intentName,
      result: 'NOT_OBSERVED',
      identities: [],
      canonicalClaim: null,
      canonicalAstStatus: 'not-consulted',
      nearNames: [],
      semanticHints: [],
      citations: [`[확인 불가, reason: symbols.json absent in ${OUTPUT}; cannot ground any lookup]`],
    });
  }
}

// ── Run file / dependency / shape lookups (P1-2) ─────────────
//
// Name lookups come first in `lookups[]`; file/dep/shape append
// afterward. This preserves a stable grep-friendly ordering per
// maintainer history notes §4.4.

for (const intentFile of intent.files) {
  const result = lookupFile(intentFile, { topology, symbols, triage, root: ROOT });
  lookups.push(result);
}

for (const depName of intent.dependencies) {
  const result = lookupDependency(depName, { packageJson, symbols });
  lookups.push(result);
}

for (const shape of intent.shapes) {
  const result = lookupShape(shape, { shapeIndex, functionClones });
  lookups.push(result);
}

// ── Assemble advisory ────────────────────────────────────────

const invocationId = generateInvocationId();
const intentHash = hashIntent(intent);

// Compute canonical drift from P1-1 lookup results (P1-3 §5.4).
// Read-only projection — no canonical re-parse, no lookup re-run.
const drift = computeDrift({ canonicalClaims, lookups });
const cueTierResult = classifyPreWriteCues({ lookups, intent });

// ── P2-0 snapshot hook ───────────────────────────────────────
//
// Narrow append-only hook: spawn any-inventory.mjs to snapshot current
// type-escape occurrences BEFORE Claude writes code, writing
// any-inventory.pre.<invocationId>.json alongside the advisory. The
// advisory's `preWrite.anyInventoryPath` points at the snapshot so P2-1
// post-write can find the exact baseline for a given invocation.
//
// Contract per maintainer history notes §5.5:
//   - execFileSync with argv arrays (NO shell strings).
//   - Same scan-range flags as this pre-write run (--include-tests /
//     --production / --exclude) passed through to any-inventory.mjs.
//   - --no-fresh-audit → skip the hook entirely (no snapshot file, no
//     preWrite.anyInventoryPath field).
//   - Hook failure → CLI exits 0; failures[] records the error; no
//     partial snapshot file left on disk; preWrite.anyInventoryPath
//     stays ABSENT.

const preWriteBlock = {};
try {
  const files = repoRelativeFileList(ROOT, collectFiles(ROOT, {
    includeTests: args.includeTests,
    exclude: args.exclude,
  }));
  preWriteBlock.fileInventory = {
    status: 'available',
    pathMode: 'repo-relative',
    fileCount: files.length,
    files,
  };
} catch (e) {
  preWriteBlock.fileInventory = {
    status: 'failed',
    reason: e?.message?.slice(0, 400) ?? 'unknown',
  };
  failures.push({
    kind: 'file-inventory-hook-failed',
    reason: preWriteBlock.fileInventory.reason,
  });
}
if (!noFreshAudit) {
  const snapshotFileName = `any-inventory.pre.${invocationId}.json`;
  const snapshotPathAbs = path.join(OUTPUT, snapshotFileName);
  const inventoryCli = path.join(SKILL_ROOT, 'any-inventory.mjs');

  // Scan-range flag propagation (maintainer history notes §5.5 P1-5). Re-pass what this
  // pre-write run received; don't invent new defaults.
  const hookArgs = [
    inventoryCli,
    '--root', ROOT,
    '--output', OUTPUT,
    '--artifact-name', snapshotFileName,
  ];
  // parseCliArgs exposes `includeTests` as a boolean derived from the
  // raw flags. Pass `--production` through when `includeTests === false`
  // (matches how parseCliArgs computes it); otherwise inventory uses its
  // default which mirrors this pre-write's settings.
  if (args.includeTests === false) hookArgs.push('--production');
  for (const exc of (args.exclude ?? [])) hookArgs.push('--exclude', exc);

  process.stderr.write(`[pre-write] P2-0 hook: running any-inventory.mjs\n`);
  try {
    execFileSync(process.execPath, hookArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    if (existsSync(snapshotPathAbs)) {
      preWriteBlock.anyInventoryPath = snapshotFileName;
      process.stderr.write(`[pre-write] P2-0 hook: snapshot → ${snapshotFileName}\n`);
    } else {
      failures.push({
        kind: 'any-inventory-hook-failed',
        reason: `any-inventory.mjs succeeded but produced no ${snapshotFileName} artifact`,
      });
    }
  } catch (e) {
    // Any leftover partial file? Remove.
    if (existsSync(snapshotPathAbs)) {
      try { unlinkSync(snapshotPathAbs); } catch { /* best-effort */ }
    }
    failures.push({
      kind: 'any-inventory-hook-failed',
      reason: e?.message?.slice(0, 400) ?? 'unknown',
      stderr: e?.stderr?.toString?.()?.slice(0, 400) ?? '',
    });
    process.stderr.write(`[pre-write] P2-0 hook: FAILED\n`);
  }
}

const advisory = {
  invocationId,
  intentHash,
  artifactPaths: {
    invocationSpecific: path.join(ADVISORY_OUT, `pre-write-advisory.${invocationId}.json`),
    latest: path.join(ADVISORY_OUT, 'pre-write-advisory.latest.json'),
  },
  scanRange: {
    root: ROOT,
    output: OUTPUT,
    includeTests: args.includeTests,
    production: args.includeTests === false,
    excludes: args.exclude ?? [],
  },
  intent,
  intentWarnings,
  lookups,
  cueCards: cueTierResult.cueCards,
  suppressedCues: cueTierResult.suppressedCues,
  unavailableEvidence: cueTierResult.unavailableEvidence,
  cuePolicy: cueTierResult.cuePolicy,
  boundaryChecks: [],  // P1-2 keeps empty — NOT_EVALUATED entries are
                       // optional and omitted by default (maintainer history notes §4.5).
  drift,
  preWrite: preWriteBlock,
  capabilities,
  failures,
};

// ── Write artifact + emit Markdown ───────────────────────────

writeAdvisory(ADVISORY_OUT, renderJson(advisory));
const md = renderMarkdown(advisory);
process.stdout.write(md + '\n');

// Graceful exit even when advisory carries [확인 불가] rows. CLI exit
// code signals CLI-level errors (bad flags, malformed intent), not
// advisory content.
process.exit(0);
