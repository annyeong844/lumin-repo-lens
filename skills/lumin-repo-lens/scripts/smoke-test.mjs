#!/usr/bin/env node
// Minimal deployable-package smoke test.
//
// Creates a tiny TS repo, runs the public audit wrapper, and verifies the
// two artifacts a user needs for first-line debugging.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const auditCandidates = [
  path.join(__dirname, 'audit-repo.mjs'),
  path.join(__dirname, '..', 'audit-repo.mjs'),
];
const auditCli = auditCandidates.find((candidate) => existsSync(candidate));

function fail(message, detail = '') {
  process.stderr.write(`[smoke-test] ${message}\n`);
  if (detail) process.stderr.write(`${detail}\n`);
  process.exit(1);
}

if (!auditCli) {
  fail('could not find audit-repo.mjs next to smoke test or at repo root');
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'lumin-repo-lens-smoke-'));
const repo = path.join(tmp, 'repo');
const out = path.join(tmp, 'audit');

try {
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'lumin-repo-lens-smoke-fixture',
    type: 'module',
  }, null, 2));
  writeFileSync(path.join(repo, 'src/index.ts'), [
    'export function hello(name: string) {',
    '  return `hello ${name}`;',
    '}',
    '',
  ].join('\n'));

  const result = spawnSync(process.execPath, [
    auditCli,
    '--root', repo,
    '--output', out,
    '--profile', 'quick',
    '--production',
  ], {
    cwd: path.dirname(auditCli),
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    fail(`audit-repo exited ${result.status}`, `${result.stdout}\n${result.stderr}`);
  }

  const manifestPath = path.join(out, 'manifest.json');
  const summaryPath = path.join(out, 'audit-summary.latest.md');
  if (!existsSync(manifestPath) || !existsSync(summaryPath)) {
    fail('expected smoke artifacts were not written', `output: ${out}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.commandsRun) || manifest.commandsRun.length === 0) {
    fail('manifest.commandsRun is missing or empty', JSON.stringify(manifest, null, 2));
  }

  console.log(`[smoke-test] ok: ${manifestPath}`);
} finally {
  if (
    process.env.LUMIN_REPO_LENS_SMOKE_KEEP !== '1' &&
    process.env.LUMIN_AUDIT_SMOKE_KEEP !== '1'
  ) {
    rmSync(tmp, { recursive: true, force: true });
  }
}
