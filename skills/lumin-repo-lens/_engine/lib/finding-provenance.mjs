// Per-finding provenance — `supportedBy` / `taintedBy` /
// `resolverConfidence` / `parseStatus` fields that accompany each
// dead-export candidate on the way to `rank-fixes.mjs`.
//
// Moved out of `_lib/classify-facts.mjs` in v1.10.2 because the
// provenance layer was the youngest topic in that file and the most
// likely to grow (new taint kinds as new FP classes are discovered).
// Keeping it next to the regex/AST counters made classify-facts the
// fastest-growing module in `_lib/`; a dedicated home flattens the
// graph.
//
// The vocabulary (taint kinds, severity groups) lives in
// `_lib/vocab.mjs`. This module emits the structural records;
// `_lib/ranking.mjs` consumes them for tier decisions.

import { TAINT } from './vocab.mjs';

// Does an unresolved specifier's tail (after alias prefix) look like
// it could resolve to the given repo-rel file path? Used for the
// `unresolved-specifier-could-match` per-finding taint — if this
// returns true for any unresolved spec in the repo, the finding is
// demoted because a tsconfig-paths / alias addition could reveal a
// consumer.
//
// Over-matches intentionally — honest taint-too-much beats silent
// taint-too-little. Example: `@/components/auth-control` matches any
// file whose stem ends with `/components/auth-control`, regardless
// of whether the alias actually resolves there.
export function specifierCouldMatchFile(spec, relFile) {
  if (typeof spec !== 'string' || typeof relFile !== 'string') return false;
  const firstSlash = spec.indexOf('/');
  if (firstSlash < 0) return false;                 // bare `@foo` — can't match a path
  const tail = spec.slice(firstSlash + 1);
  const tailStem = tail.replace(/\.(tsx?|jsx?|mjs|cjs|d\.ts)$/, '');
  const fileStem = relFile.replace(/\\/g, '/').replace(/\.(tsx?|jsx?|mjs|cjs|d\.ts)$/, '');
  return fileStem === tailStem || fileStem.endsWith('/' + tailStem);
}

// Compute per-finding provenance. Returns
// `{supportedBy, taintedBy, resolverConfidence, parseStatus}`.
// The classifier appends these fields to each emitted dead-candidate
// so `rank-fixes.mjs` can gate tiering per finding instead of
// relying on a single repo-global ratio.
export function computeFindingProvenance(finding, {
  filesWithParseErrors = [],
  unresolvedInternalSpecifiers = [],
  astEvidence,
  astCount,
} = {}) {
  const supportedBy = [];
  const taintedBy = [];

  supportedBy.push({ kind: astEvidence, count: astCount });

  // Strongest taint — the defining file itself failed to parse. In
  // practice rare (parse-error files wouldn't emit defs into the
  // graph) but kept for defensive completeness.
  if (filesWithParseErrors.includes(finding.file)) {
    taintedBy.push({
      kind: TAINT.DEFINING_FILE_PARSE_ERROR,
      file: finding.file,
      effect: 'the file declaring this symbol failed to parse; classification may be incorrect',
    });
  }

  // Soft taint — parse errors elsewhere might have hidden a consumer
  // of THIS symbol.
  const otherFailed = filesWithParseErrors.filter((f) => f !== finding.file);
  if (otherFailed.length > 0) {
    taintedBy.push({
      kind: TAINT.PARSE_ERRORS_ELSEWHERE,
      scope: 'repo-wide',
      affected: otherFailed.length,
      sample: otherFailed.slice(0, 3),
      effect: 'other files failed to parse; a potential consumer of this symbol may be missing from the graph',
    });
  }

  // Strongest per-finding signal — an unresolved specifier's path
  // shape matches THIS file. A tsconfig-paths or alias addition
  // could make it resolve and surface a consumer.
  const matching = unresolvedInternalSpecifiers.filter((s) =>
    specifierCouldMatchFile(s, finding.file));
  if (matching.length > 0) {
    taintedBy.push({
      kind: TAINT.UNRESOLVED_SPEC_MATCH,
      specifiers: matching.slice(0, 5),
      total: matching.length,
      effect: "at least one unresolved import's path shape suggests it could resolve to this file; adding the matching tsconfig paths entry would likely surface a consumer",
    });
  }

  let resolverConfidence;
  if (taintedBy.some((t) => t.kind === TAINT.UNRESOLVED_SPEC_MATCH ||
                            t.kind === TAINT.DEFINING_FILE_PARSE_ERROR)) {
    resolverConfidence = 'low';
  } else if (taintedBy.some((t) => t.kind === TAINT.PARSE_ERRORS_ELSEWHERE)) {
    resolverConfidence = 'medium';
  } else {
    resolverConfidence = 'high';
  }

  return {
    supportedBy,
    taintedBy,
    resolverConfidence,
    parseStatus: filesWithParseErrors.includes(finding.file) ? 'error' : 'ok',
  };
}
