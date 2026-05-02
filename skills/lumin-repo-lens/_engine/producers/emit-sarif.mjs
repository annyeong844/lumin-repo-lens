// emit-sarif.mjs — Transform lumin-repo-lens artifacts into SARIF 2.1.0.
//
// Reads whichever JSON artifacts are present in --output and emits a single
// SARIF file consumable by GitHub Code Scanning, GitLab SAST, SonarQube, and
// similar tools. Prefers fused evidence (runtime × staleness) when available;
// falls back to static AST findings otherwise. Grounded/degraded labels from
// the skill's honesty framework map to SARIF levels (warning / note).
//
// Upload to GitHub:
//   gh api -X POST \
//     /repos/{owner}/{repo}/code-scanning/sarifs \
//     -f commit_sha=$(git rev-parse HEAD) \
//     -f ref=refs/heads/main \
//     -f sarif=@<encoded>.sarif
//
// Usage:
//   node emit-sarif.mjs --root <repo> --output <dir> [--out-sarif <path>]

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseCliArgs } from '../lib/cli.mjs';
import { loadIfExists as loadArtifact } from '../lib/artifacts.mjs';

const cli = parseCliArgs({
  'out-sarif': { type: 'string' },
});
const { root: ROOT, output } = cli;
const outPath = cli.raw['out-sarif'] ?? path.join(output, 'lumin-repo-lens.sarif');

// ─── Tool manifest ───────────────────────────────────────
const TOOL_VERSION = '0.9.0-beta.6';
const TOOL_INFO_URI = 'https://github.com/annyeong844/lumin-repo-lens';
const HELP_URI = TOOL_INFO_URI + '#readme';

const RULES = [
  {
    id: 'GA001',
    name: 'dead-export',
    shortDescription: { text: 'Exported symbol has no consumers.' },
    fullDescription: {
      text: 'Symbol is exported but no import or re-export references it across the scanned file set. Confidence is upgraded when fused with runtime coverage (merge-runtime-evidence) and git staleness (measure-staleness).',
    },
    defaultConfiguration: { level: 'warning' },
    helpUri: HELP_URI,
  },
  {
    id: 'GA002',
    name: 'cyclic-dependency',
    shortDescription: { text: 'File participates in an import cycle.' },
    fullDescription: {
      text: 'File-level strongly-connected component detected via Tarjan SCC on non-type-only import edges.',
    },
    defaultConfiguration: { level: 'warning' },
    helpUri: HELP_URI,
  },
  {
    id: 'GA003',
    name: 'escape-hatch',
    shortDescription: { text: 'Type-safety or discipline escape hatch.' },
    fullDescription: {
      text: 'Use of `: any`, `as any`, `@ts-ignore`, `@ts-nocheck`, `eslint-disable`, `new Function(...)`, or similar mechanisms that bypass static checks.',
    },
    defaultConfiguration: { level: 'note' },
    helpUri: HELP_URI,
  },
  {
    id: 'GA004',
    name: 'god-module',
    shortDescription: { text: 'File exceeds size threshold.' },
    fullDescription: {
      text: 'File has 1000+ lines of code — candidate for splitting into smaller modules.',
    },
    defaultConfiguration: { level: 'note' },
    helpUri: HELP_URI,
  },
  {
    id: 'GA005',
    name: 'cross-submodule-hotspot',
    shortDescription: { text: 'Heavy cross-submodule coupling.' },
    fullDescription: {
      text: 'High count of imports crossing top-level submodule boundaries — potential architectural layering violation.',
    },
    defaultConfiguration: { level: 'note' },
    helpUri: HELP_URI,
  },
  {
    id: 'GA006',
    name: 'barrel-discipline',
    shortDescription: { text: 'Import bypasses the package barrel.' },
    fullDescription: {
      text: 'Root-level (non-subpath) import of a workspace package — consumer should use the public subpath export instead of pulling through the barrel.',
    },
    defaultConfiguration: { level: 'warning' },
    helpUri: HELP_URI,
  },
];

// ─── helpers ─────────────────────────────────────────────
const loadIfExists = (name) => loadArtifact(output, name);

const absRoot = path.resolve(ROOT);
function uriFor(file) {
  if (!file) return '.';
  const absFile = path.isAbsolute(file) ? file : path.join(absRoot, file);
  const normAbs = absFile.replace(/\\/g, '/');
  const normRoot = absRoot.replace(/\\/g, '/');
  const rel = normAbs.startsWith(normRoot + '/')
    ? normAbs.slice(normRoot.length + 1)
    : normAbs;
  return rel || '.';
}

function makeResult(ruleId, ruleIndex, level, message, file, line, properties = {}) {
  const result = {
    ruleId,
    ruleIndex,
    level,
    message: { text: message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: uriFor(file) },
          region: { startLine: Math.max(1, Number(line) || 1) },
        },
      },
    ],
  };
  if (Object.keys(properties).length > 0) result.properties = properties;
  return result;
}

const ruleIndexById = Object.fromEntries(RULES.map((r, i) => [r.id, i]));

// ─── collect findings ────────────────────────────────────
const results = [];
const artifactsUsed = [];

// GA001 — dead export.
// Priority order:
//   (1) fix-plan.json (v1.9.5+) — unified 4-tier ranking, SAFE_FIX→warning,
//       REVIEW_FIX/DEGRADED→note, MUTED not emitted
//   (2) runtime-evidence.json ⊕ staleness.json — per-finding grounding/confidence
//   (3) dead-classify.json — classifier post-policy output
//   (4) raw symbols.json — last-resort fallback
const runtimeEvidence = loadIfExists('runtime-evidence.json');
const staleness = loadIfExists('staleness.json');
const deadClassify = loadIfExists('dead-classify.json');
const symbols = loadIfExists('symbols.json');
const fixPlan = loadIfExists('fix-plan.json');

function makeStalenessLookup() {
  if (!staleness?.enriched) return null;
  const m = new Map();
  for (const s of staleness.enriched) {
    m.set(`${s.file}|${s.symbol}|${s.line}`, s);
  }
  return m;
}

function levelForDead(grounding, confidence, runtimeStatus) {
  // Probable false positives (runtime hit > 0) must be softened to `note`
  // even if statically "dead", to avoid noisy CI alerts.
  if (runtimeStatus === 'executed') return 'note';
  if (grounding === 'grounded' && confidence === 'high') return 'warning';
  if (grounding === 'grounded') return 'warning';
  return 'note';
}

if (fixPlan) {
  // v1.9.5: fix-plan.json carries the unified 4-tier ranking. Use it
  // as the source of truth for SARIF severity — SAFE_FIX → warning,
  // REVIEW_FIX/DEGRADED → note, MUTED not emitted.
  artifactsUsed.push('fix-plan.json');

  const { TIER_TO_SARIF_LEVEL } = await import('../lib/ranking.mjs');

  const emit = (entries, tier) => {
    const level = TIER_TO_SARIF_LEVEL[tier];
    if (level === null) return; // MUTED: don't emit
    for (const s of entries) {
      const f = s.finding;
      const ev = s.evidence ?? {};
      const parts = [
        `Dead export \`${f.symbol}\` (${f.kind})`,
        `tier: ${tier}`,
      ];
      if (ev.runtime?.status) parts.push(`runtime: ${ev.runtime.status}`);
      if (ev.staleness?.tier) parts.push(`staleness: ${ev.staleness.tier}`);
      parts.push(`(${s.reason})`);

      const props = {
        symbol: f.symbol,
        kind: f.kind,
        tier,
        reason: s.reason,
        proposalBucket: f.bucket,
        grounding: ev.runtime?.grounding ?? 'grounded',
        confidence: ev.runtime?.confidence ?? 'medium',
        runtimeStatus: ev.runtime?.status ?? 'not-measured',
        hitsInSymbol: ev.runtime?.hitsInSymbol ?? 0,
        ...(ev.staleness?.tier ? { stalenessTier: ev.staleness.tier } : {}),
        ...(ev.staleness?.lineLastTouchedDaysAgo !== undefined
          ? { lineLastTouchedDaysAgo: ev.staleness.lineLastTouchedDaysAgo } : {}),
        ...(f.fileInternalUses !== undefined ? { fileInternalUses: f.fileInternalUses } : {}),
        ...(f.predicatePartner ? { predicatePartner: f.predicatePartner } : {}),
        ...(f.localName ? { localName: f.localName } : {}),
      };
      results.push(makeResult('GA001', ruleIndexById.GA001, level,
        parts.join(' | '), f.file, f.line, props));
    }
  };
  emit(fixPlan.safeFixes ?? [], 'SAFE_FIX');
  emit(fixPlan.reviewFixes ?? [], 'REVIEW_FIX');
  emit(fixPlan.degraded ?? [], 'DEGRADED');
  // fixPlan.muted intentionally not emitted
} else if (runtimeEvidence?.merged?.length) {
  artifactsUsed.push('runtime-evidence.json');
  const stalenessBy = makeStalenessLookup();
  if (stalenessBy) artifactsUsed.push('staleness.json');

  for (const m of runtimeEvidence.merged) {
    if (m.grounding === 'blind') continue;
    const st = stalenessBy?.get(`${m.file}|${m.symbol}|${m.line}`) ?? null;

    const parts = [
      `Dead export \`${m.symbol}\` (${m.kind})`,
      `runtime: ${m.runtimeStatus}`,
    ];
    if (st) parts.push(`staleness: ${st.stalenessTier}`);
    parts.push(`grounding: ${m.grounding}/${m.confidence}`);

    const props = {
      symbol: m.symbol,
      kind: m.kind,
      grounding: m.grounding,
      confidence: m.confidence,
      runtimeStatus: m.runtimeStatus,
      hitsInSymbol: m.hitsInSymbol ?? 0,
      note: m.note,
    };
    if (st) {
      props.stalenessTier = st.stalenessTier;
      props.lineLastTouchedDaysAgo = st.lineLastTouchedDaysAgo;
      props.symbolMentionStatus = st.symbolMentionStatus;
    }

    results.push(
      makeResult('GA001', ruleIndexById.GA001,
        levelForDead(m.grounding, m.confidence, m.runtimeStatus),
        parts.join(' | '), m.file, m.line, props)
    );
  }
} else if (deadClassify) {
  // v1.8.1: prefer classifier output. It has already applied framework
  // exclusions (config files FP-22, public API FP-23, framework sentinel
  // FP-27, Nuxt/Nitro FP-30) and grouped symbols into proposal buckets
  // that tell the user what action to take. Raw symbols.json is only a
  // pre-policy candidate list — emitting it directly (as we used to) makes
  // SARIF contradict dead-classify.json in exactly the cases policy was
  // designed to suppress.
  artifactsUsed.push('dead-classify.json');

  // Severity map: C (defines-only removal) and A (demote-to-internal) are
  // warning; B (design review) is note; aliased specifier-only is note.
  const emitProposal = (list, level, actionField) => {
    for (const p of list) {
      results.push(
        makeResult('GA001', ruleIndexById.GA001, level,
          `Dead export \`${p.symbol}\` (${p.kind}) — ${p.action}`,
          p.file, p.line,
          {
            symbol: p.symbol,
            kind: p.kind,
            grounding: 'grounded',
            confidence: 'medium',
            runtimeStatus: 'not-measured',
            proposalBucket: actionField,
            ...(p.localName ? { localName: p.localName } : {}),
            ...(p.fileInternalUses !== undefined
              ? { fileInternalUses: p.fileInternalUses }
              : {}),
            ...(p.predicatePartner
              ? { predicatePartner: p.predicatePartner }
              : {}),
          })
      );
    }
  };
  emitProposal(deadClassify.proposal_C_remove_symbol ?? [], 'warning', 'C');
  emitProposal(deadClassify.proposal_A_demote_to_internal ?? [], 'warning', 'A');
  emitProposal(deadClassify.proposal_B_review ?? [], 'note', 'B');
  emitProposal(deadClassify.proposal_remove_export_specifier ?? [], 'note', 'specifier');
} else if (symbols?.deadProdList?.length) {
  // Last-resort fallback: raw pre-policy candidates. Only reached if the
  // classifier artifact is missing (upstream pipeline didn't run).
  artifactsUsed.push('symbols.json');
  for (const d of symbols.deadProdList) {
    results.push(
      makeResult('GA001', ruleIndexById.GA001, 'note',
        `Dead export \`${d.symbol}\` (${d.kind}) — pre-policy static AST; run classify-dead-exports.mjs for policy-filtered verdict.`,
        d.file, d.line,
        { symbol: d.symbol, kind: d.kind, grounding: 'grounded', confidence: 'low', runtimeStatus: 'not-measured' })
    );
  }
}

// GA002 — cyclic dependency, plus GA004 god-module, GA005 cross-submodule hotspot
const topology = loadIfExists('topology.json');
if (topology) {
  artifactsUsed.push('topology.json');

  for (const scc of topology.sccs ?? []) {
    const preview = scc.members.slice(0, 3).join(' → ') + (scc.members.length > 3 ? ' → …' : '');
    for (const member of scc.members) {
      results.push(
        makeResult('GA002', ruleIndexById.GA002, 'warning',
          `File participates in SCC of size ${scc.size}. Cycle preview: ${preview}`,
          member, 1,
          { sccSize: scc.size, sccMembers: scc.members })
      );
    }
  }

  for (const lf of topology.largestFiles ?? []) {
    if (lf.loc >= 1000) {
      results.push(
        makeResult('GA004', ruleIndexById.GA004, 'note',
          `File has ${lf.loc} LOC (threshold: 1000). Consider splitting.`,
          lf.file, 1,
          { loc: lf.loc })
      );
    }
  }

  for (const cst of (topology.crossSubmoduleTop ?? []).slice(0, 5)) {
    if ((cst.count ?? 0) < 20) continue;
    results.push({
      ruleId: 'GA005',
      ruleIndex: ruleIndexById.GA005,
      level: 'note',
      message: { text: `Cross-submodule hotspot: ${cst.edge} (${cst.count} imports).` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: '.' },
            region: { startLine: 1 },
          },
        },
      ],
      properties: { edge: cst.edge, importCount: cst.count },
    });
  }
}

// GA003 — escape hatches from discipline.json
const discipline = loadIfExists('discipline.json');
if (discipline?.overallTopOffenders?.length) {
  artifactsUsed.push('discipline.json');
  // discipline.json has per-file aggregate counts, not per-line findings.
  // Emit one SARIF result per (file × non-zero pattern) at line 1 with the
  // total in `properties` — useful as CI signal even without precise line.
  for (const off of discipline.overallTopOffenders) {
    for (const [pattern, count] of Object.entries(off.breakdown)) {
      if (count === 0) continue;
      results.push(
        makeResult('GA003', ruleIndexById.GA003, 'note',
          `Discipline: ${count}× \`${pattern}\` in this file.`,
          off.file, 1,
          { pattern, count })
      );
    }
  }
}

// GA006 — barrel discipline
const barrels = loadIfExists('barrels.json');
if (barrels?.byPackage) {
  artifactsUsed.push('barrels.json');
  for (const [pkg, info] of Object.entries(barrels.byPackage)) {
    for (const imp of info.sampleRootImporters ?? []) {
      if (imp.eslintDisable) continue; // explicitly sanctioned
      results.push(
        makeResult('GA006', ruleIndexById.GA006, 'warning',
          `Root-level barrel import of \`${pkg}\`. Prefer subpath export.`,
          imp.file, imp.line,
          { package: pkg, symbols: imp.symbols, reExport: !!imp.reExport })
      );
    }
  }
}

// ─── assemble SARIF ──────────────────────────────────────
const nowIso = new Date().toISOString();
const sarif = {
  $schema: 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json',
  version: '2.1.0',
  runs: [
    {
      tool: {
        driver: {
          name: 'lumin-repo-lens',
          version: TOOL_VERSION,
          informationUri: TOOL_INFO_URI,
          shortDescription: {
            text: 'AST-based repository structural audit with layered evidence (AST + runtime + git history).',
          },
          rules: RULES,
        },
      },
      invocations: [
        {
          executionSuccessful: true,
          startTimeUtc: nowIso,
          endTimeUtc: nowIso,
          workingDirectory: { uri: 'file://' + absRoot.replace(/\\/g, '/') },
        },
      ],
      originalUriBaseIds: {
        SRCROOT: { uri: 'file://' + absRoot.replace(/\\/g, '/') + '/' },
      },
      results,
      properties: {
        artifactsUsed,
        scanRoot: ROOT,
        generatedAt: nowIso,
        totalFindings: results.length,
        // v1.8.2: collect warnings from every upstream artifact that
        // carries a `meta.warnings[]` array and surface them here.
        // Consumers (CI dashboards, human reviewers) can tell at a
        // glance whether the findings below came from a clean scan or
        // one that partially failed — previously this was buried in
        // stderr logs.
        upstreamWarnings: [
          ...(symbols?.meta?.warnings ?? []).map((w) => ({ source: 'symbols.json', ...w })),
          ...(deadClassify?.meta?.warnings ?? []).map((w) => ({ source: 'dead-classify.json', ...w })),
          ...(topology?.meta?.warnings ?? []).map((w) => ({ source: 'topology.json', ...w })),
          ...(discipline?.meta?.warnings ?? []).map((w) => ({ source: 'discipline.json', ...w })),
        ],
      },
    },
  ],
};

writeFileSync(outPath, JSON.stringify(sarif, null, 2));

// ─── summary ─────────────────────────────────────────────
const byRule = {};
const byLevel = { error: 0, warning: 0, note: 0 };
for (const r of results) {
  byRule[r.ruleId] = (byRule[r.ruleId] ?? 0) + 1;
  byLevel[r.level] = (byLevel[r.level] ?? 0) + 1;
}

console.log(`[sarif] ${results.length} findings from ${artifactsUsed.length} artifacts`);
for (const rule of RULES) {
  if (byRule[rule.id]) {
    console.log(`  ${rule.id} ${rule.name.padEnd(24)} ${byRule[rule.id]}`);
  }
}
console.log(`  by level: warning=${byLevel.warning}, note=${byLevel.note}, error=${byLevel.error}`);
console.log(`[sarif] artifacts used: ${artifactsUsed.join(', ') || '(none — nothing to report)'}`);
console.log(`[sarif] saved → ${outPath}`);
