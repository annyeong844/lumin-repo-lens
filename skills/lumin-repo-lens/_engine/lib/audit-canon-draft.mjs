// _lib/audit-canon-draft.mjs — audit-repo canon-draft lifecycle helper.
//
// Keeps the public orchestrator thin: this module only validates requested
// sources, spawns generate-canon-draft.mjs, and returns the manifest block.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CANON_DRAFT_SOURCES } from './canon-draft-utils.mjs';

function parseRequestedSources(sourcesValue) {
  if (!sourcesValue) return { requestedSources: [...CANON_DRAFT_SOURCES] };

  const parsed = sourcesValue.split(',').map((s) => s.trim()).filter(Boolean);
  const expanded = [];
  for (const source of parsed) {
    if (source === 'all') expanded.push(...CANON_DRAFT_SOURCES);
    else expanded.push(source);
  }

  const unknown = expanded.filter((source) => !CANON_DRAFT_SOURCES.includes(source));
  if (unknown.length > 0) return { unknown };

  const seen = new Set();
  const requestedSources = expanded.filter((source) => (
    seen.has(source) ? false : (seen.add(source), true)
  ));
  return { requestedSources };
}

function draftPathFromStderr(stderr, fallbackDir, sourceName) {
  const savedLine = (stderr ?? '')
    .split(/\r?\n/)
    .find((line) => line.startsWith('[canon-draft] saved '));
  const arrowIndex = savedLine?.indexOf('→') ?? -1;
  return arrowIndex >= 0
    ? savedLine.slice(arrowIndex + 1).trim()
    : path.join(fallbackDir, `${sourceName}.md`);
}

export function runCanonDraftLifecycle({
  sourcesValue,
  root,
  outDir,
  canonOutput,
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
      `Valid: ${CANON_DRAFT_SOURCES.join(', ')}, all\n`,
    );
    return {
      block: {
        requested: true,
        ran: false,
        reason: `unknown --sources values: ${unknownText}`,
      },
      exitCode: 1,
      forceExitCode: true,
    };
  }

  const requestedSources = parsed.requestedSources;
  const canonCliPath = path.join(scriptsDir, 'generate-canon-draft.mjs');
  const canonOutputDir = canonOutput
    ? path.resolve(canonOutput)
    : path.join(root, 'canonical-draft');
  const perSource = {};
  const draftPaths = [];

  for (const sourceName of requestedSources) {
    const args = [
      canonCliPath,
      '--root', root,
      '--output', outDir,
      '--source', sourceName,
      ...scanArgs,
    ];
    if (canonOutputDir) args.push('--canon-output', canonOutputDir);

    const res = spawnSync(processExecPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });

    if (res.error || (res.status === null && res.signal)) {
      perSource[sourceName] = {
        ran: false,
        exitCode: -1,
        reason: res.error?.message ?? `spawn failed (signal: ${res.signal})`,
      };
      continue;
    }

    const childExitCode = res.status ?? 1;
    if (childExitCode === 0) {
      const draftPath = draftPathFromStderr(res.stderr, canonOutputDir, sourceName);
      perSource[sourceName] = {
        ran: true,
        exitCode: 0,
        draftPath,
      };
      draftPaths.push(draftPath);
      continue;
    }

    perSource[sourceName] = {
      ran: false,
      exitCode: childExitCode,
      reason: childExitCode === 2
        ? 'required producer artifact absent (see stderr of child process)'
        : `generate-canon-draft.mjs exited ${childExitCode}`,
    };
  }

  const ran = Object.values(perSource).some((source) => source.ran === true);
  const block = {
    requested: true,
    ran,
    requestedSources,
    perSource,
    draftPaths,
  };

  if (!ran) {
    block.reason = 'all requested sources failed';
    return { block, exitCode: 1, forceExitCode: false };
  }

  return { block, exitCode: 0, forceExitCode: false };
}
