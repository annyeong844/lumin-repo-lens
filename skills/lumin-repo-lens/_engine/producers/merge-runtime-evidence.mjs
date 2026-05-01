// merge-runtime-evidence.mjs — Merge runtime coverage into dead-export classification.
//
// Fuses static AST evidence (symbols.json) with runtime coverage evidence
// (istanbul/nyc/c8 coverage-final.json) to upgrade the grounding tier of each
// dead-export claim:
//
//   static-dead + runtime zero-hit  →  grounded      (removal is safe)
//   static-dead + runtime hit > 0   →  degraded/FP   (dynamic use — AST missed it)
//   static-dead + file uncovered    →  degraded      (test gap, not absence)
//
// Requires:
//   - symbols.json      from build-symbol-graph.mjs (same --output dir)
//   - coverage-final.json from `nyc`, `c8 report --reporter=json`, or istanbul
//
// Usage:
//   node merge-runtime-evidence.mjs --root <repo> --output <dir> \
//        [--coverage <path/to/coverage-final.json>] [--verbose]
//
// If --coverage is omitted, auto-probes:
//   <root>/coverage/coverage-final.json
//   <root>/.nyc_output/coverage-final.json

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseCliArgs } from '../lib/cli.mjs';
import { relPath } from '../lib/paths.mjs';

const cli = parseCliArgs({
  coverage: { type: 'string' },
});
const { root: ROOT, output, verbose } = cli;
const coverageArg = cli.raw.coverage;

// ─── locate coverage file ────────────────────────────────
function locateCoverage() {
  if (coverageArg) {
    const p = path.resolve(coverageArg);
    if (!existsSync(p)) throw new Error(`--coverage not found: ${p}`);
    return p;
  }
  const candidates = [
    path.join(ROOT, 'coverage', 'coverage-final.json'),
    path.join(ROOT, '.nyc_output', 'coverage-final.json'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

const covPath = locateCoverage();
if (!covPath) {
  console.error('[merge-rt] no coverage-final.json found.');
  console.error('[merge-rt] run tests with coverage first, e.g.:');
  console.error('[merge-rt]   npx c8 --reporter=json npm test');
  console.error('[merge-rt]   npx nyc --reporter=json npm test');
  console.error('[merge-rt] or pass --coverage <path> explicitly.');
  process.exit(2);
}
if (verbose) console.error(`[merge-rt] coverage: ${covPath}`);

// ─── load inputs ─────────────────────────────────────────
const symbolsPath = path.join(output, 'symbols.json');
if (!existsSync(symbolsPath)) {
  console.error(`[merge-rt] missing ${symbolsPath} — run build-symbol-graph.mjs first.`);
  process.exit(2);
}
const symbolsData = JSON.parse(readFileSync(symbolsPath, 'utf8'));
const deadList = symbolsData.deadProdList ?? [];

const coverageRaw = JSON.parse(readFileSync(covPath, 'utf8'));
const covStat = statSync(covPath);

// ─── index coverage by absolute & relative path ──────────
// istanbul coverage-final.json keys are typically absolute.
// Build both abs→cov and rel→cov maps so we match regardless.
const covByAbs = new Map();
const covByRel = new Map();
for (const [key, entry] of Object.entries(coverageRaw)) {
  const abs = path.resolve(entry.path ?? key);
  covByAbs.set(abs, entry);
  const rel = relPath(ROOT, abs);
  if (rel !== abs) covByRel.set(rel, entry);
}

if (verbose) console.error(`[merge-rt] coverage entries: ${covByAbs.size}`);
console.log(`[merge-rt] ${deadList.length} dead candidates, ${covByAbs.size} files in coverage`);

// ─── per-candidate runtime lookup ────────────────────────
function runtimeVerdictFor(entry, defLine) {
  // Returns { runtimeStatus, hitsInSymbol, fileStatements, fileCovered }
  // runtimeStatus ∈
  //   'executed'       — any statement inside the def's enclosing block was hit > 0
  //   'dead-confirmed' — def's enclosing block present but zero hits
  //   'file-untested'  — file is in coverage but has 0 executed statements overall
  //   'uncovered'      — file not in coverage at all (caller supplies this)

  const statementMap = entry.statementMap ?? {};
  const s = entry.s ?? {};
  const fnMap = entry.fnMap ?? {};
  const f = entry.f ?? {};

  let fileStatements = 0;
  let fileCoveredStatements = 0;
  for (const id of Object.keys(statementMap)) {
    fileStatements++;
    if ((s[id] ?? 0) > 0) fileCoveredStatements++;
  }

  if (fileStatements === 0) {
    return { runtimeStatus: 'file-untested', hitsInSymbol: 0, fileStatements, fileCoveredStatements };
  }

  // Find the enclosing function whose range covers defLine. Prefer function-level
  // hit count because istanbul tracks function execution distinct from statements.
  let enclosingFnHits = null;
  for (const id of Object.keys(fnMap)) {
    const loc = fnMap[id].loc ?? fnMap[id].decl;
    if (!loc) continue;
    if (loc.start.line <= defLine && defLine <= loc.end.line) {
      const span = loc.end.line - loc.start.line;
      // Prefer the innermost (smallest-span) function enclosing defLine.
      if (enclosingFnHits === null || span < enclosingFnHits.span) {
        enclosingFnHits = { hits: f[id] ?? 0, span };
      }
    }
  }

  // Aggregate statement hits within +/- a small window around defLine.
  // Most symbols are functions/classes/types. For type-only (interface/type alias)
  // no runtime hit is ever possible; caller distinguishes by kind.
  let hitsInSymbol = 0;
  let stmtsInSymbol = 0;
  for (const id of Object.keys(statementMap)) {
    const loc = statementMap[id];
    // statement is "near" the def if its first line is within the enclosing
    // function's span; if no enclosing fn found, fall back to same-line window.
    const withinFn =
      enclosingFnHits !== null &&
      fnMap &&
      Object.values(fnMap).some((fn) => {
        const l = fn.loc ?? fn.decl;
        return l && l.start.line <= loc.start.line && loc.end.line <= l.end.line &&
               l.start.line <= defLine && defLine <= l.end.line;
      });
    const nearDefLine = Math.abs(loc.start.line - defLine) <= 50;
    if (withinFn || (enclosingFnHits === null && nearDefLine)) {
      stmtsInSymbol++;
      hitsInSymbol += s[id] ?? 0;
    }
  }

  const hits = enclosingFnHits !== null ? enclosingFnHits.hits : hitsInSymbol;

  return {
    runtimeStatus: hits > 0 ? 'executed' : 'dead-confirmed',
    hitsInSymbol: hits,
    stmtsInSymbol,
    fileStatements,
    fileCoveredStatements,
    usedFnMap: enclosingFnHits !== null,
  };
}

// ─── kind → is-runtime-observable? ───────────────────────
// Type-only declarations (interface, type alias, enum const-type position, module
// declaration) are erased at compile time — runtime coverage can never show hits
// for them. Treat those specially.
function isTypeOnly(kind) {
  return (
    kind === 'TSInterfaceDeclaration' ||
    kind === 'TSTypeAliasDeclaration' ||
    kind === 'TSModuleDeclaration'
  );
}

// ─── merge ───────────────────────────────────────────────
const merged = [];
const stats = {
  total: deadList.length,
  grounded_dead: 0,        // static dead + runtime zero (or type-only with tests present)
  degraded_fp_suspect: 0,  // static dead + runtime hit  → probable FP (dynamic use)
  degraded_uncovered: 0,   // static dead + file not exercised by tests
  degraded_type_only: 0,   // type-only symbol — runtime evidence n/a by definition
  degraded_file_untested: 0, // file in coverage but 0% coverage (module-level test gap)
};

for (const d of deadList) {
  const abs = path.isAbsolute(d.file) ? d.file : path.join(ROOT, d.file);
  const entry = covByAbs.get(abs) ?? covByRel.get(d.file);

  // Type-only symbols: runtime evidence is categorically unavailable.
  if (isTypeOnly(d.kind)) {
    merged.push({
      ...d,
      runtimeStatus: 'type-only',
      grounding: 'degraded',
      confidence: 'medium',
      note: 'Type-only declaration — erased at compile. Runtime evidence n/a; rely on AST.',
    });
    stats.degraded_type_only++;
    continue;
  }

  if (!entry) {
    merged.push({
      ...d,
      runtimeStatus: 'uncovered',
      grounding: 'degraded',
      confidence: 'medium',
      note: 'File not present in coverage output. Test range did not exercise this file.',
    });
    stats.degraded_uncovered++;
    continue;
  }

  const verdict = runtimeVerdictFor(entry, d.line);

  if (verdict.runtimeStatus === 'file-untested') {
    merged.push({
      ...d,
      runtimeStatus: 'file-untested',
      hitsInSymbol: 0,
      fileStatements: verdict.fileStatements,
      grounding: 'degraded',
      confidence: 'medium',
      note: 'File loaded by tests but 0 statements executed. Module-level test gap.',
    });
    stats.degraded_file_untested++;
    continue;
  }

  if (verdict.runtimeStatus === 'executed') {
    merged.push({
      ...d,
      runtimeStatus: 'executed',
      hitsInSymbol: verdict.hitsInSymbol,
      stmtsInSymbol: verdict.stmtsInSymbol,
      grounding: 'degraded',
      confidence: 'low',
      note: `AST says dead but runtime hit ${verdict.hitsInSymbol}×. Likely dynamic use (reflection, string import, framework autowire). Probable FP — DO NOT remove without manual check.`,
    });
    stats.degraded_fp_suspect++;
    continue;
  }

  // dead-confirmed
  merged.push({
    ...d,
    runtimeStatus: 'dead-confirmed',
    hitsInSymbol: 0,
    stmtsInSymbol: verdict.stmtsInSymbol,
    fileStatements: verdict.fileStatements,
    fileCoveredStatements: verdict.fileCoveredStatements,
    grounding: 'grounded',
    confidence: 'high',
    note: 'AST-dead and runtime zero-hit across covered range. Safe-to-remove with highest evidence tier.',
  });
  stats.grounded_dead++;
}

// ─── file-level orphan detection ─────────────────────────
// Files in static graph but absent from coverage at all → candidate orphan modules.
// (Only meaningful if the test suite is supposed to reach them.)
const staticFiles = new Set();
for (const d of deadList) {
  const abs = path.isAbsolute(d.file) ? d.file : path.join(ROOT, d.file);
  staticFiles.add(abs);
}
const orphanFiles = [];
for (const f of staticFiles) {
  if (!covByAbs.has(f)) orphanFiles.push(relPath(ROOT, f));
}

// ─── report ──────────────────────────────────────────────
console.log('\n══════ runtime-fused grounding ══════');
console.log(`  grounded  (static-dead + runtime zero)     : ${stats.grounded_dead}`);
console.log(`  degraded/FP suspect (runtime hit > 0)      : ${stats.degraded_fp_suspect}`);
console.log(`  degraded/file-untested (0% coverage)       : ${stats.degraded_file_untested}`);
console.log(`  degraded/uncovered (file absent)           : ${stats.degraded_uncovered}`);
console.log(`  degraded/type-only (runtime n/a)           : ${stats.degraded_type_only}`);
console.log(`  ─────────────────────────────────────────── `);
console.log(`  total                                      : ${stats.total}`);

const reductionPct =
  stats.total === 0 ? 0 : Math.round((stats.grounded_dead / stats.total) * 100);
console.log(`\n  grounded share: ${reductionPct}% of all dead candidates`);

if (stats.degraded_fp_suspect > 0) {
  console.log(`\n⚠ ${stats.degraded_fp_suspect} candidates have runtime hits — these are probable FPs.`);
  const sample = merged.filter((m) => m.runtimeStatus === 'executed').slice(0, 10);
  for (const m of sample) {
    console.log(`    ${m.file}:${m.line}  ${m.symbol}  (${m.hitsInSymbol}× hits)`);
  }
}

// ─── save artifact ───────────────────────────────────────
const artifact = {
  meta: {
    generated: new Date().toISOString(),
    root: ROOT,
    tool: 'merge-runtime-evidence.mjs',
    coverageSource: covPath,
    coverageMtime: covStat.mtime.toISOString(),
    symbolsSource: symbolsPath,
  },
  summary: {
    ...stats,
    coverageFileCount: covByAbs.size,
    orphanStaticFiles: orphanFiles.length,
    groundedSharePct: reductionPct,
  },
  merged,
  orphanFilesSample: orphanFiles.slice(0, 50),
};

const outPath = path.join(output, 'runtime-evidence.json');
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`\n[merge-rt] saved → ${outPath}`);
