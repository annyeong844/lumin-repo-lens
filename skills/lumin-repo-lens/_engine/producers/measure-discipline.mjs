#!/usr/bin/env node
// measure-discipline.mjs — discipline counters (:any, @ts-ignore, TODO, etc.)
//
// Usage: node measure-discipline.mjs --root <repo> [--output <dir>]
//
// Counts by regex. See references/false-positive-patterns.md for FP awareness —
// some counts are affected by comments/strings; sample-verify if suspicious.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseCliArgs } from '../lib/cli.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { JS_FAMILY_LANGS } from '../lib/lang.mjs';
import { relPath } from '../lib/paths.mjs';

const cli = parseCliArgs();
const { root, output } = cli;

// v1.8.3: discipline scan is regex-only — no parser involved. Previously
// Python / Go inclusion was gated behind `isPythonAvailable()` /
// `isTreeSitterAvailable()` checks that are genuinely needed by the
// *symbol* pipeline (AST extraction), not by this regex-based smell
// counter. A user without Python installed should still get counts on
// `panic(`, `unsafe.`, and `//nolint` in their Go sources. Also: respect
// --include-tests / --exclude like every other scanner (prior version
// ignored them, so "production" scans leaked test-file smells).
const langList = [...JS_FAMILY_LANGS, 'py', 'go'];
const files = collectFiles(root, {
  languages: langList,
  includeTests: cli.includeTests,
  exclude: cli.exclude,
});
const pyCount = files.filter((f) => f.endsWith('.py')).length;
const goCount = files.filter((f) => f.endsWith('.go')).length;
console.error(
  `[discipline] scanning ${files.length} files (${pyCount} .py, ${goCount} .go) ...`
);

// Language tag for dispatch. Each pattern declares which language groups it
// applies to; patterns are skipped for files of other languages to avoid
// cross-language false positives.
function langOf(f) {
  if (f.endsWith('.py')) return 'py';
  if (f.endsWith('.go')) return 'go';
  return 'ts';
}

const patterns = [
  // ── TS/JS patterns ─────────────────────────────────────
  { name: ':any',                 re: /:\s*any\b/g,             langs: ['ts'], about: 'TypeScript explicit any annotation' },
  { name: 'as any',               re: /\bas\s+any\b/g,          langs: ['ts'], about: 'TypeScript any cast' },
  { name: 'as unknown as',        re: /\bas\s+unknown\s+as\b/g, langs: ['ts'], about: 'Double-cast bypass' },
  { name: '@ts-ignore',           re: /@ts-ignore/g,            langs: ['ts'], about: 'Type check disable' },
  { name: '@ts-expect-error',     re: /@ts-expect-error/g,      langs: ['ts'], about: 'Expected error marker' },
  { name: '@ts-nocheck',          re: /@ts-nocheck/g,           langs: ['ts'], about: 'Whole-file check disable' },
  { name: 'eslint-disable',       re: /eslint-disable/g,        langs: ['ts'], about: 'ESLint rule disable' },
  { name: 'Function constructor', re: /\bnew\s+Function\s*\(/g, langs: ['ts'], about: 'Dynamic function (security risk)' },
  // ── Python patterns ────────────────────────────────────
  { name: '# type: ignore',       re: /#\s*type:\s*ignore/g,    langs: ['py'], about: 'Python type check disable' },
  { name: '# pyright: ignore',    re: /#\s*pyright:\s*ignore/g, langs: ['py'], about: 'Pyright disable' },
  { name: '# pylint: disable',    re: /#\s*pylint:\s*disable/g, langs: ['py'], about: 'Pylint rule disable' },
  { name: '# noqa',               re: /#\s*noqa\b/g,            langs: ['py'], about: 'flake8/ruff disable' },
  { name: 'eval(',                re: /\beval\s*\(/g,           langs: ['py'], about: 'Python dynamic eval (security risk)' },
  { name: 'exec(',                re: /\bexec\s*\(/g,           langs: ['py'], about: 'Python dynamic exec (security risk)' },
  // ── Go patterns ────────────────────────────────────────
  { name: 'interface{}',          re: /\binterface\s*\{\s*\}/g, langs: ['go'], about: 'Go empty interface (pre-generics any)' },
  { name: 'panic(',               re: /\bpanic\s*\(/g,          langs: ['go'], about: 'Go panic call (error-handling escape)' },
  { name: 'unsafe.',              re: /\bunsafe\.\w+/g,         langs: ['go'], about: 'Go unsafe package (memory safety bypass)' },
  { name: '//nolint',             re: /\/\/\s*nolint/g,         langs: ['go'], about: 'golangci-lint disable' },
  // ── Universal markers ──────────────────────────────────
  { name: 'TODO',                 re: /\bTODO\b/g,              langs: ['ts', 'py', 'go'], about: 'Deferred work marker' },
  { name: 'FIXME',                re: /\bFIXME\b/g,             langs: ['ts', 'py', 'go'], about: 'Known bug marker' },
  { name: 'HACK',                 re: /\bHACK\b/g,              langs: ['ts', 'py', 'go'], about: 'Workaround marker' },
  { name: 'XXX',                  re: /\bXXX\b/g,               langs: ['ts', 'py', 'go'], about: 'Attention marker' },
];

const perFile = new Map();
const totals = Object.fromEntries(patterns.map((p) => [p.name, 0]));
const byFileDistribution = Object.fromEntries(patterns.map((p) => [p.name, []]));
let sourceTotalLines = 0;
let unreadableCount = 0; // E-4: surface per-file skip count so counts aren't silently wrong.

for (const f of files) {
  let src;
  try { src = readFileSync(f, 'utf8'); } catch { unreadableCount++; continue; }
  sourceTotalLines += src.split('\n').length;
  const lang = langOf(f);

  const counts = {};
  for (const p of patterns) {
    if (!p.langs.includes(lang)) continue;
    const m = src.match(p.re);
    const n = m ? m.length : 0;
    counts[p.name] = n;
    totals[p.name] += n;
    if (n > 0) byFileDistribution[p.name].push({ file: relPath(root, f), count: n });
  }
  perFile.set(f, counts);
}

// Sort byFileDistribution by count
for (const name of Object.keys(byFileDistribution)) {
  byFileDistribution[name].sort((a, b) => b.count - a.count);
}

// ─── Files with highest concentration of each violation ──
const topOffendersPerPattern = {};
for (const p of patterns) {
  topOffendersPerPattern[p.name] = byFileDistribution[p.name].slice(0, 10);
}

// ─── Overall violation index ──────────────────────────────
// Simple: sum all pattern hits weighted equally, per file
// (rough relative indicator, not scientific)
const fileViolationIndex = [];
for (const [f, counts] of perFile) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    fileViolationIndex.push({
      file: relPath(root, f),
      total,
      breakdown: counts,
    });
  }
}
fileViolationIndex.sort((a, b) => b.total - a.total);

const artifact = {
  meta: {
    generated: new Date().toISOString(),
    root,
    tool: 'measure-discipline.mjs',
    note: 'Regex-based. Subject to false positives from comments/strings. See references/false-positive-patterns.md.',
  },
  scannedFiles: files.length,
  unreadableFiles: unreadableCount,
  totalLines: sourceTotalLines,
  totals,
  ratesPerFile: Object.fromEntries(
    Object.entries(totals).map(([k, v]) => [k, parseFloat((v / files.length).toFixed(3))])
  ),
  ratesPerKLoc: Object.fromEntries(
    Object.entries(totals).map(([k, v]) => [k, parseFloat(((v / sourceTotalLines) * 1000).toFixed(2))])
  ),
  topOffenders: topOffendersPerPattern,
  overallTopOffenders: fileViolationIndex.slice(0, 20),
};

const outPath = path.join(output, 'discipline.json');
writeFileSync(outPath, JSON.stringify(artifact, null, 2));

console.log(
  `[discipline] ${files.length} files scanned (${pyCount} .py, ${goCount} .go)`
);
if (unreadableCount > 0) {
  console.warn(`[discipline] WARN: ${unreadableCount} file(s) could not be read — totals may be low. Check permissions/symlinks.`);
}
const tsSummary = `:any=${totals[':any']}, as any=${totals['as any']}, @ts-ignore=${totals['@ts-ignore']}`;
// v1.8.3: Python/Go summaries print when any such file was actually
// scanned, not when a parser was available. This scanner is regex-only
// — it doesn't need Python to count `# type: ignore`.
const pySummary = pyCount > 0
  ? `, # type: ignore=${totals['# type: ignore'] ?? 0}, # noqa=${totals['# noqa'] ?? 0}, eval(=${totals['eval('] ?? 0}`
  : '';
const goSummary = goCount > 0
  ? `, interface{}=${totals['interface{}'] ?? 0}, panic(=${totals['panic('] ?? 0}, unsafe.=${totals['unsafe.'] ?? 0}`
  : '';
console.log(`[discipline] ${tsSummary}${pySummary}${goSummary}, TODO=${totals['TODO']}`);
console.log(`[discipline] saved → ${outPath}`);
