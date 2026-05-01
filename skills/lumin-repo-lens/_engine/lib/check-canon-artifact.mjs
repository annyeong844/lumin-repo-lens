// _lib/check-canon-artifact.mjs
//
// P5-1 — I/O layer for check-canon. Separated from check-canon-utils.mjs
// per reviewer P0-6 (utils stays pure; all fs reads/writes live here).
//
// Responsibilities:
//   - loadTypeOwnershipCanon: fs read + missing-file → skipped-missing-canon
//   - writeCanonDriftArtifacts: JSON always, per-source MD conditional.
//     NO append-merge; each call overwrites with its own perSource set.

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  parseTypeOwnershipCanonText,
  parseHelperRegistryCanonText,
  parseTopologyCanonText,
  parseNamingCanonText,
} from './check-canon-utils.mjs';
import { atomicWrite } from './atomic-write.mjs';

function loadCanonFile({ canonPath, canonLabelSet, parseFn }) {
  if (!existsSync(canonPath)) {
    return {
      records: new Map(),
      diagnostics: [{ reason: 'canon-file-absent', path: canonPath }],
      status: 'skipped-missing-canon',
      lineCount: 0,
    };
  }
  let text;
  try {
    text = readFileSync(canonPath, 'utf8');
  } catch (e) {
    return {
      records: new Map(),
      diagnostics: [{ reason: 'canon-file-unreadable', path: canonPath, message: e.message }],
      status: 'parse-error',
      lineCount: 0,
    };
  }
  return parseFn({ text, canonLabelSet });
}

export function loadTypeOwnershipCanon({ canonPath, canonLabelSet }) {
  return loadCanonFile({ canonPath, canonLabelSet, parseFn: parseTypeOwnershipCanonText });
}

export function loadHelperRegistryCanon({ canonPath, canonLabelSet }) {
  return loadCanonFile({ canonPath, canonLabelSet, parseFn: parseHelperRegistryCanonText });
}

export function loadTopologyCanon({ canonPath, canonLabelSet }) {
  // Topology parser returns a multi-section shape (inventory/cycles/crossEdges/
  // oversize/workspaces). The shared `loadCanonFile` wrapper handles missing +
  // unreadable cases with the same skipped-missing-canon / parse-error
  // semantics as types + helpers; the parser itself surfaces per-section
  // diagnostics inside the clean / parse-error return.
  return loadCanonFile({ canonPath, canonLabelSet, parseFn: parseTopologyCanonText });
}

export function loadNamingCanon({ canonPath, canonLabelSet }) {
  // Naming parser returns a multi-section shape (fileCohorts/symbolCohorts/
  // outliers). §3 Outliers is optional — absence = zero outliers, presence +
  // malformed = parse-error (P1-7 distinction, pinned in parser).
  return loadCanonFile({ canonPath, canonLabelSet, parseFn: parseNamingCanonText });
}

export function writeCanonDriftArtifacts({ output, driftObject, reportMarkdown, source }) {
  mkdirSync(output, { recursive: true });
  const jsonPath = path.join(output, 'canon-drift.json');
  const body = JSON.stringify(driftObject, null, 2) + '\n';
  atomicWrite(jsonPath, body);

  let reportPath = null;
  if (typeof reportMarkdown === 'string' && reportMarkdown.length > 0) {
    reportPath = path.join(output, `canon-drift.${source}.md`);
    atomicWrite(reportPath, reportMarkdown);
  }
  return { jsonPath, reportPath };
}
