// Lookup adapter for pre-write inline extraction review cues.

function stableCompare(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function hasLineIntersection(source, occurrence) {
  const lines = source?.lines;
  if (!Array.isArray(lines) || lines.length === 0) return true;
  const start = Number.isInteger(occurrence?.line) ? occurrence.line : null;
  const end = Number.isInteger(occurrence?.endLine) ? occurrence.endLine : start;
  if (start === null || end === null) return false;
  return lines.some((line) => line >= start && line <= end);
}

function occurrenceMatchesSource(occurrence, source) {
  return occurrence?.file === source?.file && hasLineIntersection(source, occurrence);
}

function groupMatchesSource(group, source) {
  return (group.occurrences ?? []).some((occurrence) =>
    occurrenceMatchesSource(occurrence, source)
  );
}

function normalizeGroup(group, refactorSources) {
  const matchingSources = refactorSources.filter((source) => groupMatchesSource(group, source));
  return {
    patternHash: group.patternHash,
    kind: group.kind,
    size: group.size ?? group.occurrences?.length ?? 0,
    ownerFiles: [...(group.ownerFiles ?? [])].sort(stableCompare),
    normalizedPattern: group.normalizedPattern,
    occurrences: [...(group.occurrences ?? [])].sort((a, b) =>
      stableCompare(a.file, b.file) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.endLine ?? 0) - (b.endLine ?? 0) ||
      stableCompare(a.enclosingFunction, b.enclosingFunction)
    ),
    reviewReason: group.reviewReason,
    normalizerVersion: group.normalizerVersion,
    refactorSources: matchingSources,
  };
}

/**
 * @param {{file: string, lines?: number[], why?: string}[]} refactorSources
 * @param {{inlinePatterns?: {groups?: object[]}}} opts
 * @returns {object}
 */
export function lookupInlinePatterns(refactorSources, { inlinePatterns } = {}) {
  if (!Array.isArray(refactorSources) || refactorSources.length === 0) {
    return { kind: 'inline-pattern', result: 'NO_INLINE_PATTERN_INTENT', groups: [] };
  }

  if (!inlinePatterns || !Array.isArray(inlinePatterns.groups)) {
    return {
      kind: 'inline-pattern',
      result: 'UNAVAILABLE',
      reason: 'missing-artifact',
      artifact: 'inline-patterns.json',
      citations: ['[확인 불가, inline-patterns.json absent; inline extraction cues unavailable]'],
    };
  }

  const groups = [];
  for (const group of inlinePatterns.groups) {
    if (!group?.patternHash) continue;
    if (refactorSources.some((source) => groupMatchesSource(group, source))) {
      groups.push(normalizeGroup(group, refactorSources));
    }
  }

  groups.sort((a, b) =>
    (b.size ?? 0) - (a.size ?? 0) ||
    stableCompare(a.patternHash, b.patternHash)
  );

  if (groups.length === 0) {
    return {
      kind: 'inline-pattern',
      result: 'NO_INLINE_PATTERN_MATCH',
      groups: [],
      citations: ['[grounded, inline-patterns.json present; no pattern group intersects refactorSources]'],
    };
  }

  return {
    kind: 'inline-pattern',
    result: 'INLINE_PATTERN_MATCH',
    groups,
    citations: [`[grounded, inline-patterns.json groups intersect ${refactorSources.length} refactor source${refactorSources.length === 1 ? '' : 's'}]`],
  };
}
