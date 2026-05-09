export function sortCounterObject(counter) {
  return Object.fromEntries([...counter.entries()]
    .sort((a, b) => a[0].localeCompare(b[0])));
}

export function buildBlockedCandidateHintReasonCounts(hints) {
  const groups = new Map();
  for (const hint of hints ?? []) {
    const reason = hint?.reason;
    if (!reason) continue;
    if (!groups.has(reason)) {
      groups.set(reason, {
        reason,
        count: 0,
        families: new Map(),
      });
    }
    const group = groups.get(reason);
    const family = hint.family ?? 'unknown';
    group.count++;
    group.families.set(family, (group.families.get(family) ?? 0) + 1);
  }
  return [...groups.values()]
    .map((group) => ({
      reason: group.reason,
      count: group.count,
      families: sortCounterObject(group.families),
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 20);
}

export function buildBlockedCandidateHintFamilyCounts(hints) {
  const groups = new Map();
  for (const hint of hints ?? []) {
    const family = hint?.family ?? 'unknown';
    if (!groups.has(family)) {
      groups.set(family, {
        family,
        count: 0,
        reasons: new Map(),
      });
    }
    const group = groups.get(family);
    const reason = hint.reason ?? 'unknown';
    group.count++;
    group.reasons.set(reason, (group.reasons.get(reason) ?? 0) + 1);
  }
  return [...groups.values()]
    .map((group) => ({
      family: group.family,
      count: group.count,
      reasons: sortCounterObject(group.reasons),
    }))
    .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family))
    .slice(0, 20);
}

export function formatBlockedCandidateHints(hints, limit = 3) {
  if (!Array.isArray(hints) || hints.length === 0) return null;
  const parts = hints
    .slice(0, limit)
    .map((hint) => {
      const target = hint?.candidatePath ?? hint?.affectedPackageScope;
      const specifier = hint?.specifier;
      const reason = hint?.reason;
      if (!target || !specifier || !reason) return null;
      return `${target} via ${specifier} (${reason})`;
    })
    .filter(Boolean);
  return parts.length ? parts.join('; ') : null;
}

function formatCounterRecord(counter) {
  if (!counter || typeof counter !== 'object' || Array.isArray(counter)) return null;
  const parts = Object.entries(counter)
    .filter(([, count]) => typeof count === 'number')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => `${label} ${count}`);
  return parts.length ? parts.join(', ') : null;
}

function formatDistributionList(items, labelKey, nestedKey, limit = 3) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const parts = items
    .slice(0, limit)
    .map((item) => {
      const label = item?.[labelKey];
      const count = item?.count;
      if (!label || typeof count !== 'number') return null;
      const nested = formatCounterRecord(item?.[nestedKey]);
      return `${label} ${count}${nested ? ` (${nested})` : ''}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export function formatBlockedCandidateHintDistribution(resolverDiagnostics) {
  const reasonText = formatDistributionList(
    resolverDiagnostics?.blockedCandidateHintReasonCounts,
    'reason',
    'families'
  );
  const familyText = formatDistributionList(
    resolverDiagnostics?.blockedCandidateHintFamilyCounts,
    'family',
    'reasons'
  );
  if (!reasonText && !familyText) return null;
  return [
    reasonText ? `reasons ${reasonText}` : null,
    familyText ? `families ${familyText}` : null,
  ].filter(Boolean).join('; ');
}
