#!/usr/bin/env node
// Public CLI for the lumin-repo-lens repository evidence skill.
//
// Blessed entrypoint:
//
//   node audit-repo.mjs --root <repo> --output <dir> [--profile NAME] [--sarif]
//
// Stable user-facing capabilities:
//   - audit        (--profile quick|full|ci)
//   - pre-write    (--pre-write --intent <file|->)
//   - post-write   (--post-write --pre-write-advisory <file>)
//   - canon-draft  (--canon-draft [--sources <csv>])
//   - check-canon  (--check-canon [--sources <csv>])
//
// Sibling root scripts (build-symbol-graph.mjs, measure-topology.mjs,
// check-canon.mjs, etc.) remain internal engine entrypoints for
// development, testing, and narrow step-by-step debugging. Public docs
// should point users here first.
//
// Runs the requested capability in the order SKILL.md documents and
// writes `manifest.json` summarizing what happened. Audit profiles run
// the structural pipeline; pre-write-only invocations deliberately skip
// that base pipeline and delegate to the intent-shaped cold-cache gate.
// Partial failure is OK — a step's non-zero exit demotes it to `skipped`
// in the manifest rather than aborting the whole run. This matches
// reviewer's intent: the orchestrator is a convenience, not an
// all-or-nothing gate.
//
// Profiles:
//   quick — triage, topology, discipline, symbol graph, classify, rank
//   full  — quick + call graph + barrel discipline + shape index + function clone cues
//           + runtime fusion (if coverage present) + staleness (if git)
//   ci    — full + emit SARIF always
//
// manifest.json fields:
//   profile         which profile ran
//   commandsRun     scripts actually invoked, in order, with status
//   scanRange       root, includeTests, languages, excludes
//   confidence      parseErrors, unresolvedInternalRatio, externalImports
//   blindZones      standardized blind-zone list (_lib/blind-zones.mjs)
//   livingAudit     existing living audit docs that the model should read/update
//   skipped         scripts that were intentionally skipped (with reason)
//
// Design: this script does NOT re-implement any analysis. Every real
// step is a child process invocation of the existing .mjs. Failure of
// any step is captured but never hidden.

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { formatBlindZonesSummary } from '../lib/blind-zones.mjs';
import { loadIfExists as loadArtifact } from '../lib/artifacts.mjs';
import { atomicWrite } from '../lib/atomic-write.mjs';
import { normalizeIncludeTests } from '../lib/cli.mjs';
import { renderAuditSummary } from '../lib/audit-summary.mjs';
import { renderAuditReviewPack } from '../lib/audit-review-pack.mjs';
import { renderTopologyMermaid } from '../lib/topology-mermaid.mjs';
import { assertRuntimeSetup, formatRuntimeSetupError } from '../lib/dependency-guard.mjs';
import { detectMaintainerSelfAuditExcludes, mergeExcludes } from '../lib/self-audit-excludes.mjs';
import { runCanonDraftLifecycle } from '../lib/audit-canon-draft.mjs';
import { runCheckCanonLifecycle } from '../lib/audit-check-canon.mjs';
import {
  buildManifestEvidence,
  collectProducedArtifacts,
  refreshManifestEvidence,
} from '../lib/audit-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELP_TEXT = `
lumin-repo-lens public CLI

Recommended entrypoint:
  lumin-repo-lens --root <repo> --output <dir>
  node scripts/audit-repo.mjs --root <repo> --output <dir>    # generated skill package
  node audit-repo.mjs --root <repo> --output <dir>            # maintainer checkout

Stable capabilities:
  audit
    lumin-repo-lens --root <repo> --output <dir> --profile quick|full|ci

  pre-write
    lumin-repo-lens --root <repo> --output <dir> --pre-write --intent intent.json

  post-write
    lumin-repo-lens --root <repo> --output <dir> --post-write --pre-write-advisory advisory.json

  canon-draft
    lumin-repo-lens --root <repo> --output <dir> --canon-draft [--sources type-ownership,naming] [--canon-output <dir>]

  check-canon
    lumin-repo-lens --root <repo> --output <dir> --check-canon [--sources all]

Flags:
  --root, -r               repo root to scan
  --output, -o             artifact output dir (default: <root>/.audit)
  --profile                quick | full | ci (default: quick)
  --sarif                  force SARIF emission
  --production             exclude test files
  --include-tests          include test files (default)
  --include-tests=false    exclude test files
  --no-include-tests       exclude test files
  --no-tests               exclude test files
  --exclude-tests          exclude test files
  --exclude <pattern>      repeatable dir-segment or file-path exclusion
  --no-self-audit-excludes do not auto-exclude maintainer lab/corpus mirrors
  --strict-post-write      exit 2 when post-write orchestration cannot run
  --strict-post-write-confidence
                           exit 2 when post-write delta confidence is limited
  --strict-check-canon     escalate drift to exit 1, all-fail to exit 2
  --sources, --source      canon source CSV (alias; --sources wins)
  --canon-output <dir>     canon-draft proposal dir (default: <root>/canonical-draft)

Internal note:
  Root sibling scripts such as build-symbol-graph.mjs, measure-topology.mjs,
  generate-canon-draft.mjs, and check-canon.mjs are internal engine
  entrypoints. They remain available for engine development and debugging,
  but the public surface is audit-repo.mjs plus the validation modes above.

Profiles:
  quick  default fast structural pass
  full   quick + call graph + barrel discipline + shape index + function clone cues + optional runtime/staleness
  ci     full + SARIF
`.trim();

// ─── Lifecycle flag matrix (see SKILL.md § Lifecycle flag matrix) ───
//
// Three lifecycle flags layered on top of the base pipeline:
//   --pre-write     (P1-3)  needs --intent <file|->
//   --post-write    (P2-2)  needs --pre-write-advisory <file>
//   --canon-draft   (P3-4)  no companion; optional --sources <csv>
//
// Interaction rules (authoritative: SKILL.md table):
//   pre-write ↔ post-write  : MUTUALLY EXCLUSIVE (exit 2 if both set)
//   canon-draft             : ORTHOGONAL to both
//   any combination below   : allowed — manifest.{preWrite,postWrite,canonDraft}
//                              populated independently
//
// None of these flags enter the default quick/full/ci profiles.
const CLI_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  root: { type: 'string', short: 'r' },
  output: { type: 'string', short: 'o' },
  profile: { type: 'string', default: 'quick' },
  sarif: { type: 'boolean', default: false },
  'include-tests': { type: 'boolean', default: true },
  production: { type: 'boolean', default: false },
  'no-tests': { type: 'boolean', default: false },
  'exclude-tests': { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
  // P1-3: opt-in pre-write integration. Not in default profiles.
  'pre-write': { type: 'boolean', default: false },
  intent: { type: 'string' },
  // P2-2: opt-in post-write integration. Mutually exclusive with --pre-write.
  'post-write': { type: 'boolean', default: false },
  'pre-write-advisory': { type: 'string' },
  'delta-out': { type: 'string' },
  'no-include-tests': { type: 'boolean', default: false },
  'no-fresh-audit': { type: 'boolean', default: false },
  'no-self-audit-excludes': { type: 'boolean', default: false },
  exclude: { type: 'string', multiple: true, default: [] },
  // P2-2 follow-up: strict mode converts manifest.postWrite.ran === false
  // into exit code 2. Closes the "silent CI green on unreadable advisory"
  // gap without changing default advisory semantics.
  'strict-post-write': { type: 'boolean', default: false },
  'strict-post-write-confidence': { type: 'boolean', default: false },
  // P3-4-b: opt-in canon-draft orchestrator. Thin spawn wrapper that
  // invokes `generate-canon-draft.mjs` per source. NOT in default profiles.
  // `--sources <csv>` scopes to a subset; default runs all four sources
  // from `CANON_DRAFT_SOURCES`. Mutually orthogonal with --pre-write /
  // --post-write (canon draft operates outside the lifecycle-stage axis).
  'canon-draft': { type: 'boolean', default: false },
  'sources': { type: 'string' },
  'source': { type: 'string' },
  'canon-output': { type: 'string' },
  // P5-4: opt-in check-canon orchestrator. Thin spawn wrapper that
  // invokes `check-canon.mjs`; when all sources are requested it uses the
  // CLI's single-invocation `--source all` path to avoid duplicate child
  // startup/scans. NOT in default profiles. Mutually orthogonal with
  // --pre-write / --post-write (can coexist; pre/post mutex still applies
  // separately).
  // Per p5-4.md §4.4: advisory default (orchestrator exit 0 if ran);
  // `--strict-check-canon` escalates drift→1, all-fail→2.
  'check-canon': { type: 'boolean', default: false },
  'strict-check-canon': { type: 'boolean', default: false },
};

const { values, tokens } = parseArgs({
  options: CLI_OPTIONS,
  strict: false,
  tokens: true,
});

if (values.help) {
  console.log(HELP_TEXT);
  process.exit(0);
}

const KNOWN_OPTIONS = new Set(Object.keys(CLI_OPTIONS));
const unknownOptions = [...new Set(tokens
  .filter((token) => token.kind === 'option' && !KNOWN_OPTIONS.has(token.name))
  .map((token) => `--${token.name}`))];
if (unknownOptions.length > 0) {
  console.error(`[audit-repo] unknown option(s): ${unknownOptions.join(', ')}`);
  process.exit(2);
}

if (!values.root) {
  console.error('usage: audit-repo.mjs --root <repo> [--output <dir>] [--profile quick|full|ci] [--sarif] [--production]\n       audit-repo.mjs --help');
  process.exit(1);
}

try {
  await assertRuntimeSetup({ startDir: __dirname, commandName: 'audit-repo' });
} catch (error) {
  console.error(formatRuntimeSetupError(error));
  process.exit(error?.exitCode ?? 2);
}

const ROOT = path.resolve(values.root);
const OUT = path.resolve(values.output ?? path.join(ROOT, '.audit'));
const OUTPUT_WAS_DEFAULT = !values.output;
const PROFILE = values.profile;
const SOURCES_VALUE = values.sources ?? values.source;
const INCLUDE_TESTS = normalizeIncludeTests(values, process.argv.slice(2));
const PRODUCTION = !INCLUDE_TESTS;
const EMIT_SARIF = values.sarif || PROFILE === 'ci';
const PRE_POST_MUTEX = values['pre-write'] && values['post-write'];
const PRE_WRITE_ONLY =
  values['pre-write'] &&
  !values['post-write'] &&
  !values['canon-draft'] &&
  !values['check-canon'] &&
  !EMIT_SARIF;
const RUN_BASE_PIPELINE = !PRE_POST_MUTEX && !PRE_WRITE_ONLY;
const AUTO_EXCLUDES = values['no-self-audit-excludes']
  ? []
  : detectMaintainerSelfAuditExcludes(ROOT);
const EFFECTIVE_EXCLUDES = mergeExcludes(values.exclude ?? [], AUTO_EXCLUDES);

mkdirSync(OUT, { recursive: true });

function isWithinPath(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

if (OUTPUT_WAS_DEFAULT) {
  process.stderr.write(
    `[audit-repo] privacy note: default artifacts are written to ${path.join(ROOT, '.audit')}.\n` +
    `[audit-repo] Add ".audit/" to .gitignore or use --output outside the repo if these artifacts should not be committed.\n`
  );
} else if (!isWithinPath(OUT, ROOT)) {
  process.stderr.write(
    `[audit-repo] note: --output is outside --root; artifacts will be written to: ${OUT}\n`
  );
}

if (!['quick', 'full', 'ci'].includes(PROFILE)) {
  console.error(`[audit-repo] unknown profile: ${PROFILE}. Use quick|full|ci.`);
  process.exit(1);
}

const commandsRun = [];
const skipped = [];

const loadIfExists = (name) => loadArtifact(OUT, name);

function forwardedScanArgs() {
  const args = [];
  if (!INCLUDE_TESTS) args.push('--production');
  for (const exc of EFFECTIVE_EXCLUDES) args.push('--exclude', exc);
  return args;
}

function manifestEvidenceOptions() {
  return {
    root: ROOT,
    outDir: OUT,
    includeTests: INCLUDE_TESTS,
    production: PRODUCTION,
    excludes: EFFECTIVE_EXCLUDES,
    autoExcludes: AUTO_EXCLUDES,
  };
}

function shortenConsoleLine(line, max = 150) {
  const normalized = String(line ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function collectSummarySectionLines(markdown, heading, limit) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) break;
    if (!trimmed) continue;
    if (/^(?:-|\d+\.)\s+/.test(trimmed)) {
      out.push(shortenConsoleLine(trimmed));
      if (out.length >= limit) break;
    }
  }
  return out;
}

function renderSummaryConsolePreview(markdown) {
  const sections = [
    ['Command Result', collectSummarySectionLines(markdown, '## Command Result', 3)],
    ['Read First', collectSummarySectionLines(markdown, '## Read First', 2)],
    ['Measured Cues', collectSummarySectionLines(markdown, '## Measured Cues (Unranked)', 3)],
    ['Living Audit Tracking', collectSummarySectionLines(markdown, '## Living Audit Tracking', 2)],
    ['Guardrails', collectSummarySectionLines(markdown, '## Guardrails', 2)],
  ].filter(([, lines]) => lines.length > 0);
  if (sections.length === 0) return null;

  const out = ['[audit-repo] artifact brief preview:'];
  for (const [label, lines] of sections) {
    out.push(`[audit-repo]   ${label}:`);
    for (const line of lines) out.push(`[audit-repo]     ${line}`);
  }
  return out.join('\n');
}

function runStep(scriptRelPath, { required = false, precondition = null, reason = '' } = {}) {
  const name = path.basename(scriptRelPath);
  if (precondition) {
    const ok = precondition();
    if (!ok) {
      skipped.push({ step: name, reason });
      console.log(`[audit-repo] skip  ${name}  (${reason})`);
      return { status: 'skipped', reason };
    }
  }
  // P1-3 shell-safety: spawn via argv array. Shell-string interpolation
  // broke on paths with spaces / $ / parentheses. Keeping execSync's
  // import for any future command-line composition outside of producer
  // spawning.
  const argv = [
    path.join(__dirname, scriptRelPath),
    '--root', ROOT,
    '--output', OUT,
    ...forwardedScanArgs(),
  ];
  const t0 = Date.now();
  try {
    const out = execFileSync(process.execPath, argv, {
      stdio: values.verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const ms = Date.now() - t0;
    commandsRun.push({ step: name, status: 'ok', ms });
    console.log(`[audit-repo] ok    ${name}  (${ms}ms)`);
    return { status: 'ok', out, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    const status = required ? 'failed-required' : 'failed-optional';
    commandsRun.push({
      step: name, status, ms,
      stderr: (e.stderr || e.message || '').toString().slice(0, 500),
    });
    console.log(`[audit-repo] ${required ? 'FAIL' : 'warn'}  ${name}  (${ms}ms) — ` +
                `${required ? 'required, aborting' : 'optional, continuing'}`);
    if (required) throw e;
    return { status };
  }
}

console.log(`[audit-repo] profile=${PROFILE}  root=${ROOT}  output=${OUT}`);

if (!RUN_BASE_PIPELINE) {
  const baseSkipReason = PRE_POST_MUTEX
    ? '--pre-write and --post-write are mutually exclusive'
    : 'pre-write-only mode uses intent-shaped cold-cache instead of full quick audit';
  skipped.push({
    step: 'base-audit-profile',
    reason: baseSkipReason,
  });
  console.log(`[audit-repo] skip  base audit profile  (${baseSkipReason})`);
} else {
  // ─── Step 1: triage (always) ──────────────────────────────
  runStep('triage-repo.mjs', { required: true });

  // ─── Step 2-3: measurement (quick+) ──────────────────────
  runStep('measure-topology.mjs', { required: false });
  runStep('measure-discipline.mjs', { required: false });

  // ─── Step 4: optional structural evidence (full+) ───────────
  if (PROFILE !== 'quick') {
    runStep('build-call-graph.mjs', { required: false });
    runStep('check-barrel-discipline.mjs', { required: false });
    runStep('build-shape-index.mjs', { required: false });
    runStep('build-function-clone-index.mjs', { required: false });
  }

  // ─── Step 5: symbol graph (always, required for classify) ──
  runStep('build-symbol-graph.mjs', { required: true });

  // ─── Step 6: classify dead exports ──────────────────────
  runStep('classify-dead-exports.mjs', { required: false });

  // ─── Step 7: runtime evidence (full only, coverage present) ──
  const hasCoverage = () => {
    const candidates = [
      path.join(ROOT, 'coverage', 'coverage-final.json'),
      path.join(ROOT, '.nyc_output', 'coverage-final.json'),
    ];
    return candidates.some(existsSync);
  };
  if (PROFILE !== 'quick') {
    runStep('merge-runtime-evidence.mjs', {
      required: false,
      precondition: hasCoverage,
      reason: 'no coverage-final.json in coverage/ or .nyc_output/',
    });
  }

  // ─── Step 8: staleness (full only, git repo) ───────────
  function isGitWorkTree() {
    try {
      const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out === 'true';
    } catch {
      return false;
    }
  }
  if (PROFILE !== 'quick') {
    runStep('measure-staleness.mjs', {
      required: false,
      precondition: isGitWorkTree,
      reason: 'not a git working tree',
    });
  }

  // ─── Step 9: rank-fixes ──────────────────────────────────
  runStep('rank-fixes.mjs', {
    required: false,
    precondition: () => existsSync(path.join(OUT, 'dead-classify.json')),
    reason: 'dead-classify.json missing (classify step failed or was skipped)',
  });

  // ─── Step 10: checklist-facts (pre-compute for templates/REVIEW_CHECKLIST.md) ──
  // Always runs — cheap and degrades per-item when inputs are missing.
  // Produces `checklist-facts.json` so a structural-review walker lands
  // with the automatable half pre-labeled `[grounded]`.
  runStep('checklist-facts.mjs', { required: false });

  // ─── Step 11: SARIF emission (ci, or --sarif) ──────────────
  if (EMIT_SARIF) {
    runStep('emit-sarif.mjs', { required: false });
  } else {
    skipped.push({ step: 'emit-sarif.mjs', reason: 'not in --sarif mode' });
  }
}

// ─── Build manifest ───────────────────────────────────────
const initialEvidence = buildManifestEvidence(manifestEvidenceOptions());

const manifest = {
  meta: {
    generated: new Date().toISOString(),
    tool: 'audit-repo.mjs',
    profile: PROFILE,
    root: ROOT,
    output: OUT,
  },
  profile: PROFILE,
  commandsRun,
  skipped,
  scanRange: initialEvidence.scanRange,
  confidence: initialEvidence.confidence,
  blindZones: initialEvidence.blindZones,
  livingAudit: initialEvidence.livingAudit,
  artifactsProduced: collectProducedArtifacts(OUT),
};

// ─── P1-3: pre-write opt-in step ──────────────────────────
// ─── P2-2: post-write opt-in step — mutually exclusive with --pre-write ─
//
// Exit-code contract (maintainer history notes §4.4, maintainer history notes v2 §4.2):
//   0 — audit succeeded; pre-write OR post-write (whichever was requested)
//       ran and succeeded; or neither was requested.
//   1 — existing audit-step-failed path; OR dispatched pre-write child failed.
//   2 — --pre-write without --intent; OR --post-write without
//       --pre-write-advisory; OR --pre-write AND --post-write together.

let preWriteBlock = undefined;
let postWriteBlock = undefined;
let finalExitCode = 0;
let auditSummaryPreview = null;

if (values['pre-write'] && values['post-write']) {
  const reason = '--pre-write and --post-write are mutually exclusive';
  process.stderr.write(`[audit-repo] ${reason}\n`);
  preWriteBlock = { requested: true, ran: false, reason };
  postWriteBlock = { requested: true, ran: false, reason };
  finalExitCode = 2;
} else if (values['pre-write']) {
  if (!values.intent) {
    process.stderr.write(`[audit-repo] --pre-write requested but skipped: --intent <file|-> missing\n`);
    preWriteBlock = {
      requested: true,
      ran: false,
      reason: '--intent missing',
    };
    finalExitCode = 2;
  } else {
    const { execFileSync: _exec } = await import('node:child_process');
    const preWritePath = path.join(__dirname, 'pre-write.mjs');
    const intentPath = values.intent === '-' ? '-' : path.resolve(values.intent);
    const preArgs = [
      preWritePath,
      '--root', ROOT,
      '--output', OUT,
      '--intent', intentPath,
      ...forwardedScanArgs(),
    ];
    if (values['no-fresh-audit']) preArgs.push('--no-fresh-audit');
    try {
      _exec(process.execPath, preArgs, {
        stdio: [values.intent === '-' ? 'inherit' : 'ignore', 'inherit', 'inherit'],
      });
      const latestAdvisoryPath = path.join(OUT, 'pre-write-advisory.latest.json');
      let advisoryPath = latestAdvisoryPath;
      let advisoryInvocationId = null;
      try {
        const advisory = JSON.parse(readFileSync(latestAdvisoryPath, 'utf8'));
        advisoryInvocationId = advisory.invocationId ?? null;
        if (typeof advisory.artifactPaths?.invocationSpecific === 'string') {
          advisoryPath = path.resolve(advisory.artifactPaths.invocationSpecific);
        } else if (typeof advisory.invocationId === 'string') {
          advisoryPath = path.join(OUT, `pre-write-advisory.${advisory.invocationId}.json`);
        }
      } catch { /* leave latest path fallback */ }
      preWriteBlock = {
        requested: true,
        ran: true,
        advisoryPath,
        latestAdvisoryPath,
        advisoryInvocationId,
      };
    } catch (e) {
      preWriteBlock = {
        requested: true,
        ran: false,
        reason: `pre-write.mjs exited non-zero: ${e.message}`,
      };
      finalExitCode = typeof e.status === 'number' && e.status !== 0 ? e.status : 1;
    }
  }
} else if (values['post-write']) {
  if (!values['pre-write-advisory']) {
    process.stderr.write(`[audit-repo] --post-write requested but skipped: --pre-write-advisory <file> missing\n`);
    postWriteBlock = {
      requested: true,
      ran: false,
      reason: '--pre-write-advisory missing',
    };
    finalExitCode = 2;
  } else {
    const { execFileSync: _exec } = await import('node:child_process');
    const postWritePath = path.join(__dirname, 'post-write.mjs');
    const advisoryPath = path.resolve(values['pre-write-advisory']);
    const deltaOutDir = values['delta-out'] ? path.resolve(values['delta-out']) : OUT;
    const forwardedArgs = [
      postWritePath,
      '--root', ROOT,
      '--output', OUT,
      '--pre-write-advisory', advisoryPath,
    ];
    if (values['delta-out']) forwardedArgs.push('--delta-out', deltaOutDir);
    if (values['no-fresh-audit']) forwardedArgs.push('--no-fresh-audit');
    forwardedArgs.push(...forwardedScanArgs());

    try {
      _exec(process.execPath, forwardedArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
      const deltaPath = path.join(deltaOutDir, 'post-write-delta.latest.json');
      postWriteBlock = { requested: true, ran: true, deltaPath };
      // Re-read the delta artifact to surface summary fields in the manifest.
      // Honest signal: if the delta fails to parse, summary fields stay absent
      // rather than defaulting to a "clean" value.
      try {
        const delta = JSON.parse(readFileSync(deltaPath, 'utf8'));
        postWriteBlock.silentNew = delta.summary?.silentNew ?? 0;
        postWriteBlock.requiredAcknowledgementCount =
          (delta.entries ?? []).filter((e) => e.label === 'silent-new').length;
        postWriteBlock.baselineStatus = delta.baseline?.status ?? 'missing';
        postWriteBlock.scanRangeParity = delta.scanRangeParity?.status ?? 'baseline-missing';
        postWriteBlock.afterComplete = delta.inventoryCompleteness?.afterComplete ?? false;
        postWriteBlock.fileDeltaStatus = delta.fileDelta?.status ?? 'missing';
        postWriteBlock.unexpectedNewFileCount = delta.fileDelta?.summary?.unexpectedNew ?? 0;
        postWriteBlock.plannedMissingFileCount = delta.fileDelta?.summary?.plannedMissing ?? 0;
      } catch { /* delta unreadable — leave summary fields absent */ }
    } catch (e) {
      postWriteBlock = {
        requested: true,
        ran: false,
        reason: `post-write.mjs exited non-zero: ${e.message}`,
      };
    }
  }
}

manifest.preWrite = preWriteBlock;
manifest.postWrite = postWriteBlock;

// ─── P3-4-b: opt-in canon-draft orchestrator ─────────────
//
// Thin spawn wrapper. Each source runs a separate `generate-canon-draft.mjs`
// invocation; per-source outcomes populate `manifest.canonDraft.perSource`.
// Orthogonal with --pre-write / --post-write — all three can coexist on
// one invocation.
//
// Exit contract (advisory):
//   - `manifest.canonDraft.ran === true` iff ≥ 1 requested source succeeded.
//   - Orchestrator exit 0 if ran; exit 1 if every requested source failed
//     OR if --sources contained an unknown value.

if (values['canon-draft']) {
  const result = runCanonDraftLifecycle({
    sourcesValue: SOURCES_VALUE,
    root: ROOT,
    outDir: OUT,
    canonOutput: values['canon-output'],
    scriptsDir: __dirname,
    scanArgs: forwardedScanArgs(),
  });
  manifest.canonDraft = result.block;
  if (result.forceExitCode || finalExitCode === 0) finalExitCode = result.exitCode;
}

// ─── P5-4: check-canon orchestrator ──────────────────────────────
//
// Thin spawn wrapper mirroring the --canon-draft block. When every source is
// requested, spawn `check-canon.mjs --source all` once and copy its perSource
// entries into manifest.checkCanon. For subsets, spawn one child per source.
// Child exit 1 (drift) and exit 2 (attempted-but-failed-to-check, e.g.
// missing canon) are LEGITIMATE per-source outcomes recorded into manifest —
// NOT spawn failures. Only a true ENOENT-style failure produces ran=false on
// that source.
//
// Advisory default: orchestrator exit 0 if manifest.checkCanon.ran === true.
// --strict-check-canon escalates:
//   summary.driftCount > 0 → orchestrator exit 1
//   summary.sourcesChecked === 0 → orchestrator exit 2

if (values['check-canon']) {
  const result = runCheckCanonLifecycle({
    sourcesValue: SOURCES_VALUE,
    strict: !!values['strict-check-canon'],
    root: ROOT,
    outDir: OUT,
    scriptsDir: __dirname,
    scanArgs: forwardedScanArgs(),
  });
  manifest.checkCanon = result.block;
  if (finalExitCode === 0) finalExitCode = result.exitCode;
}

// Strict post-write: if --strict-post-write is set AND the post-write step
// was requested but did not run (spawn failure), escalate to exit 2. The
// mutual-exclusion and missing-advisory branches above already set
// finalExitCode=2, so this strictly targets the spawn-failure case (which
// defaults to exit 0 under advisory semantics).
if (values['strict-post-write'] && postWriteBlock?.ran === false && finalExitCode === 0) {
  process.stderr.write(`[audit-repo] --strict-post-write: post-write did not run; escalating to exit 2\n`);
  finalExitCode = 2;
}

function postWriteConfidenceLimited(block) {
  if (!block?.ran) return false;
  return block.baselineStatus !== 'available' ||
    block.scanRangeParity !== 'ok' ||
    block.afterComplete !== true;
}

if (values['strict-post-write-confidence'] && postWriteConfidenceLimited(postWriteBlock) && finalExitCode === 0) {
  process.stderr.write(
    `[audit-repo] --strict-post-write-confidence: post-write delta confidence limited ` +
    `(baseline=${postWriteBlock.baselineStatus ?? 'unknown'}, ` +
    `scanRange=${postWriteBlock.scanRangeParity ?? 'unknown'}, ` +
    `afterComplete=${postWriteBlock.afterComplete === true}); escalating to exit 2\n`
  );
  finalExitCode = 2;
}

refreshManifestEvidence(manifest, manifestEvidenceOptions());
const topologyArtifact = loadIfExists('topology.json');
if (topologyArtifact) {
  const topologyMermaidPath = path.join(OUT, 'topology.mermaid.md');
  atomicWrite(topologyMermaidPath, renderTopologyMermaid(topologyArtifact));
  manifest.topologyMermaid = {
    path: topologyMermaidPath,
    format: 'markdown',
    source: 'topology.json',
    use: 'human visual companion; topology.json remains authoritative for exact citations',
  };
  manifest.artifactsProduced = collectProducedArtifacts(OUT);
}
const SHOULD_WRITE_SUMMARY = (
  RUN_BASE_PIPELINE ||
  preWriteBlock?.requested ||
  postWriteBlock?.requested ||
  manifest.canonDraft?.requested ||
  manifest.checkCanon?.requested
);
if (SHOULD_WRITE_SUMMARY) {
  const auditSummaryPath = path.join(OUT, 'audit-summary.latest.md');
  const summaryMarkdown = renderAuditSummary({
    manifest,
    checklistFacts: loadIfExists('checklist-facts.json'),
    fixPlan: loadIfExists('fix-plan.json'),
    topology: topologyArtifact,
    discipline: loadIfExists('discipline.json'),
    callGraph: loadIfExists('call-graph.json'),
    functionClones: loadIfExists('function-clones.json'),
    symbols: loadIfExists('symbols.json'),
  });
  writeFileSync(auditSummaryPath, summaryMarkdown);
  auditSummaryPreview = renderSummaryConsolePreview(summaryMarkdown);
  manifest.auditSummary = {
    path: auditSummaryPath,
    format: 'markdown',
  };
}
if (RUN_BASE_PIPELINE && PROFILE !== 'quick') {
  const reviewPackPath = path.join(OUT, 'audit-review-pack.latest.md');
  const reviewPackMarkdown = renderAuditReviewPack({
    manifest,
    checklistFacts: loadIfExists('checklist-facts.json'),
    fixPlan: loadIfExists('fix-plan.json'),
    topology: loadIfExists('topology.json'),
    discipline: loadIfExists('discipline.json'),
    callGraph: loadIfExists('call-graph.json'),
    functionClones: loadIfExists('function-clones.json'),
    barrels: loadIfExists('barrels.json'),
    shapeIndex: loadIfExists('shape-index.json'),
    deadClassify: loadIfExists('dead-classify.json'),
    symbols: loadIfExists('symbols.json'),
  });
  writeFileSync(reviewPackPath, reviewPackMarkdown);
  manifest.reviewPack = {
    path: reviewPackPath,
    format: 'markdown',
    use: 'main assistant reads lanes as artifact briefs; if using built-in reviewer subagents, translate lanes into focused codebase-reading tasks with file:line evidence; the engine never calls external APIs',
  };
}
manifest.artifactsProduced = collectProducedArtifacts(OUT);

const manifestPath = path.join(OUT, 'manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// ─── Console report ───────────────────────────────────────
console.log('');
console.log(`[audit-repo] wrote ${manifestPath}`);
console.log(`[audit-repo] artifacts: ${manifest.artifactsProduced.length} produced`);
if (manifest.auditSummary?.path) {
  console.log(`[audit-repo] summary: ${manifest.auditSummary.path}`);
}
if (manifest.reviewPack?.path) {
  console.log(`[audit-repo] review pack: ${manifest.reviewPack.path}`);
}
if (auditSummaryPreview) {
  console.log('');
  console.log(auditSummaryPreview);
}
if ((manifest.blindZones ?? []).length > 0) {
  console.log(`[audit-repo] ${formatBlindZonesSummary(manifest.blindZones)}`);
  for (const z of manifest.blindZones) {
    console.log(`             • ${z.area} (${z.severity}) — ${z.effect.slice(0, 80)}${z.effect.length > 80 ? '…' : ''}`);
  }
} else {
  console.log('[audit-repo] blindZones: none detected');
}
console.log('');
console.log('Next: review manifest.blindZones before making absence/removal claims.');

if (finalExitCode !== 0) process.exit(finalExitCode);
