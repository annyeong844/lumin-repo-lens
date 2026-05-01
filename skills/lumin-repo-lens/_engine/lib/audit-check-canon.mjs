// _lib/audit-check-canon.mjs — audit-repo check-canon lifecycle helper.
//
// Owns source validation, check-canon child process orchestration, and
// manifest.checkCanon aggregation. The public orchestrator only attaches the
// returned block and applies advisory/strict exit semantics.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const CHECK_CANON_SOURCES = Object.freeze([
  'type-ownership',
  'helper-registry',
  'topology',
  'naming',
]);

function parseRequestedSources(sourcesValue) {
  if (!sourcesValue) return { requestedSources: [...CHECK_CANON_SOURCES] };

  const parsed = sourcesValue.split(',').map((s) => s.trim()).filter(Boolean);
  const expanded = [];
  for (const source of parsed) {
    if (source === 'all') expanded.push(...CHECK_CANON_SOURCES);
    else expanded.push(source);
  }

  const unknown = expanded.filter((source) => !CHECK_CANON_SOURCES.includes(source));
  if (unknown.length > 0) return { unknown };

  const seen = new Set();
  const requestedSources = expanded.filter((source) => (
    seen.has(source) ? false : (seen.add(source), true)
  ));
  return { requestedSources };
}

function logicalExitForStatus(status, fallback) {
  if (status === 'clean') return 0;
  if (status === 'drift') return 1;
  if (
    status === 'parse-error' ||
    status === 'skipped-unrecognized-schema' ||
    status === 'skipped-missing-canon'
  ) return 2;
  return fallback;
}

function readCanonDrift(outDir) {
  try {
    return JSON.parse(readFileSync(path.join(outDir, 'canon-drift.json'), 'utf8'));
  } catch {
    return null;
  }
}

function copyChildEntry({ perSource, sourceName, childEntry, fallbackExitCode }) {
  const status = childEntry?.status ?? 'unknown';
  const entry = {
    ran: true,
    exitCode: logicalExitForStatus(status, fallbackExitCode),
    status,
    driftCount: childEntry?.driftCount ?? 0,
  };
  if (childEntry?.reportPath) entry.reportPath = childEntry.reportPath;
  if (Array.isArray(childEntry?.diagnostics) && childEntry.diagnostics.length > 0) {
    entry.diagnostics = childEntry.diagnostics;
  }
  perSource[sourceName] = entry;
}

function buildCheckCanonArgs({ checkCanonCli, root, outDir, sourceName, scanArgs }) {
  return [
    checkCanonCli,
    '--root', root,
    '--output', outDir,
    '--source', sourceName,
    ...scanArgs,
  ];
}

function allSourcesRequested(requestedSources) {
  return (
    requestedSources.length === CHECK_CANON_SOURCES.length &&
    CHECK_CANON_SOURCES.every((source) => requestedSources.includes(source))
  );
}

function primaryArtifactsReady(outDir) {
  return (
    existsSync(path.join(outDir, 'symbols.json')) &&
    existsSync(path.join(outDir, 'topology.json'))
  );
}

function childFailureEntry(res) {
  return {
    ran: false,
    exitCode: -1,
    reason: res.error?.message ?? `spawn failed (signal: ${res.signal})`,
  };
}

function runCheckCanonChild({ processExecPath, checkCanonCli, root, outDir, scanArgs, sourceName }) {
  return spawnSync(
    processExecPath,
    buildCheckCanonArgs({ checkCanonCli, root, outDir, sourceName, scanArgs }),
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    },
  );
}

function childDidNotRun(res) {
  return res.error || (res.status === null && res.signal);
}

function copyFailureForSources({ perSource, sourceNames, res }) {
  for (const sourceName of sourceNames) {
    perSource[sourceName] = childFailureEntry(res);
  }
}

function runAllSourceChild(context) {
  const { perSource, requestedSources, outDir } = context;
  const res = runCheckCanonChild({ ...context, sourceName: 'all' });
  if (childDidNotRun(res)) {
    copyFailureForSources({ perSource, sourceNames: requestedSources, res });
    return;
  }

  const aggregateExitCode = res.status ?? 1;
  const canonDrift = readCanonDrift(outDir);
  for (const sourceName of requestedSources) {
    copyChildEntry({
      perSource,
      sourceName,
      childEntry: canonDrift?.perSource?.[sourceName] ?? null,
      fallbackExitCode: aggregateExitCode,
    });
  }
}

function runPerSourceChildren(context) {
  const { perSource, requestedSources, outDir } = context;
  for (const sourceName of requestedSources) {
    const res = runCheckCanonChild({ ...context, sourceName });
    if (childDidNotRun(res)) {
      copyFailureForSources({ perSource, sourceNames: [sourceName], res });
      continue;
    }

    const childExitCode = res.status ?? 1;
    const canonDrift = readCanonDrift(outDir);
    copyChildEntry({
      perSource,
      sourceName,
      childEntry: canonDrift?.perSource?.[sourceName] ?? null,
      fallbackExitCode: childExitCode,
    });
  }
}

function runCheckCanonChildren({ requestedSources, root, outDir, scriptsDir, scanArgs, processExecPath }) {
  const checkCanonCli = path.join(scriptsDir, 'check-canon.mjs');
  const perSource = {};
  const requestedAllSources = allSourcesRequested(requestedSources);
  const useAllSourceChild = requestedAllSources && primaryArtifactsReady(outDir);
  const context = {
    perSource,
    requestedSources,
    processExecPath,
    checkCanonCli,
    root,
    outDir,
    scanArgs,
  };

  if (useAllSourceChild) {
    runAllSourceChild(context);
    return {
      perSource,
      executionMode: 'single-invocation-all',
      childInvocations: 1,
    };
  }

  runPerSourceChildren(context);
  return {
    perSource,
    executionMode: requestedAllSources ? 'per-source-artifact-fallback' : 'per-source',
    childInvocations: requestedSources.length,
  };
}

function summarizeCheckCanon({ perSource, requestedSources }) {
  const entries = Object.values(perSource);
  const skipped = entries.filter((entry) => entry.status === 'skipped-missing-canon');
  const failed = entries.filter((entry) =>
    entry.status === 'parse-error' || entry.status === 'skipped-unrecognized-schema');
  const checked = entries.filter((entry) =>
    entry.status === 'clean' || entry.status === 'drift');
  const driftCount = entries.reduce((acc, entry) => acc + (entry.driftCount ?? 0), 0);
  const driftCounts = {};
  for (const sourceName of requestedSources) {
    driftCounts[sourceName] = perSource[sourceName]?.driftCount ?? 0;
  }

  return {
    entries,
    driftCounts,
    checkedCount: checked.length,
    summary: {
      driftCount,
      sourcesRequested: requestedSources.length,
      sourcesChecked: checked.length,
      sourcesSkipped: skipped.length,
      sourcesFailed: failed.length,
    },
  };
}

function strictExitCode({ strict, checkedCount, driftCount }) {
  if (!strict) return 0;
  if (checkedCount === 0) return 2;
  if (driftCount > 0) return 1;
  return 0;
}

export function runCheckCanonLifecycle({
  sourcesValue,
  strict = false,
  root,
  outDir,
  scriptsDir,
  scanArgs = [],
  stderr = process.stderr,
  processExecPath = process.execPath,
}) {
  const parsed = parseRequestedSources(sourcesValue);

  if (parsed.unknown?.length > 0) {
    const unknownText = parsed.unknown.join(', ');
    stderr.write(
      `[audit-repo] --sources contains unknown values: ${unknownText}. ` +
      `Valid: ${CHECK_CANON_SOURCES.join(', ')}, all\n`,
    );
    return {
      block: {
        requested: true,
        ran: false,
        strict,
        reason: `unknown --sources values: ${unknownText}`,
      },
      exitCode: 1,
    };
  }

  const requestedSources = parsed.requestedSources;
  const { perSource, executionMode, childInvocations } = runCheckCanonChildren({
    requestedSources,
    root,
    outDir,
    scriptsDir,
    scanArgs,
    processExecPath,
  });
  const { entries, driftCounts, checkedCount, summary } = summarizeCheckCanon({
    perSource,
    requestedSources,
  });

  const block = {
    requested: true,
    ran: entries.length > 0 && entries.some((entry) => entry.ran === true),
    strict,
    requestedSources,
    executionMode,
    childInvocations,
    summary,
    driftCounts,
    perSource,
  };

  const exitCode = strictExitCode({
    strict,
    checkedCount,
    driftCount: summary.driftCount,
  });

  return { block, exitCode };
}
