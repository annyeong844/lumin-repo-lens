// Small presentation helpers for symbols.json anyContamination owner maps.
//
// These helpers do not rank or judge findings. They only summarize where the
// model should look before making semantic reuse, contract, or shape claims.

function n(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function ownerRows(map) {
  return Object.entries(map ?? {})
    .map(([identity, owner]) => ({ identity, owner }))
    .filter((row) => row.owner && typeof row.owner === 'object')
    .sort((a, b) => a.identity.localeCompare(b.identity));
}

function hasLabel(annotation, label) {
  return Array.isArray(annotation?.labels) && annotation.labels.includes(label);
}

function summarizeOwners(map) {
  const rows = ownerRows(map);
  const contaminated = rows.filter(({ owner }) => owner.anyContamination);
  const severe = contaminated.filter(({ owner }) =>
    hasLabel(owner.anyContamination, 'severely-any-contaminated') ||
    owner.anyContamination?.label === 'severely-any-contaminated');
  const anyContaminated = contaminated.filter(({ owner }) =>
    hasLabel(owner.anyContamination, 'any-contaminated') ||
    owner.anyContamination?.label === 'any-contaminated' ||
    owner.anyContamination?.label === 'severely-any-contaminated');
  const hasAny = contaminated.filter(({ owner }) =>
    hasLabel(owner.anyContamination, 'has-any') ||
    owner.anyContamination?.label === 'has-any');
  const unknownSurface = contaminated.filter(({ owner }) =>
    hasLabel(owner.anyContamination, 'unknown-surface') ||
    owner.anyContamination?.label === 'unknown-surface');

  return {
    total: rows.length,
    annotated: contaminated.length,
    severe: severe.length,
    anyContaminated: anyContaminated.length,
    hasAny: hasAny.length,
    unknownSurface: unknownSurface.length,
    severeExamples: severe.slice(0, 3).map(({ identity }) => identity),
  };
}

function summarizeAnyContaminationOwners(symbols) {
  const support = symbols?.meta?.supports?.anyContamination;
  const supported = support === true;
  const helper = summarizeOwners(symbols?.helperOwnersByIdentity);
  const type = summarizeOwners(symbols?.typeOwnersByIdentity);
  const annotated = n(helper.annotated) + n(type.annotated);
  const severe = n(helper.severe) + n(type.severe);

  return {
    present: !!symbols,
    supported,
    support,
    helper,
    type,
    annotated,
    severe,
    hasSignal: annotated > 0 || supported,
  };
}

function exampleText(summary) {
  const examples = [
    ...summary.type.severeExamples.map((id) => `type ${id}`),
    ...summary.helper.severeExamples.map((id) => `helper ${id}`),
  ].slice(0, 3);
  return examples.length > 0 ? ` Examples: ${examples.join('; ')}.` : '';
}

export function formatAnyContaminationCue(symbols) {
  const summary = summarizeAnyContaminationOwners(symbols);
  if (!summary.present) return null;
  if (!summary.supported) {
    return '- Exported any-contamination: not measured by this symbols.json. Treat semantic reuse/shape safety claims as not enough evidence yet.';
  }
  if (summary.annotated === 0) {
    return '- Exported any-contamination: measured; no contaminated exported owner identities observed. Read `symbols.json.helperOwnersByIdentity` and `symbols.json.typeOwnersByIdentity` before semantic reuse or shape-merge claims.';
  }
  return `- Exported any-contamination: ${summary.type.severe} severe type ${summary.type.severe === 1 ? 'owner' : 'owners'}, ${summary.helper.severe} severe helper ${summary.helper.severe === 1 ? 'owner' : 'owners'} (${summary.type.anyContaminated} any-contaminated type ${summary.type.anyContaminated === 1 ? 'owner' : 'owners'}, ${summary.helper.anyContaminated} helper ${summary.helper.anyContaminated === 1 ? 'owner' : 'owners'}). Read \`symbols.json.typeOwnersByIdentity\` and \`symbols.json.helperOwnersByIdentity\` before semantic reuse or shape-merge claims.${exampleText(summary)}`;
}

export function formatAnyContaminationReviewCheck(symbols) {
  const summary = summarizeAnyContaminationOwners(symbols);
  if (!summary.present) {
    return 'Identity-level anyContamination: symbols.json not loaded in this lane. If symbols.json was produced, inspect helperOwnersByIdentity/typeOwnersByIdentity before semantic reuse claims.';
  }
  if (!summary.supported) {
    return 'Identity-level anyContamination: producer capability is not available; do not claim contaminated identities are clean.';
  }
  if (summary.annotated === 0) {
    return 'Identity-level anyContamination: measured clean for exported owners. Keep this separate from occurrence-level discipline totals.';
  }
  return `Identity-level anyContamination: ${summary.type.severe} severe type ${summary.type.severe === 1 ? 'owner' : 'owners'}, ${summary.helper.severe} severe helper ${summary.helper.severe === 1 ? 'owner' : 'owners'}; ${summary.type.anyContaminated} any-contaminated type ${summary.type.anyContaminated === 1 ? 'owner' : 'owners'}, ${summary.helper.anyContaminated} helper ${summary.helper.anyContaminated === 1 ? 'owner' : 'owners'}. Inspect symbols.json owner maps before shape/reuse recommendations.${exampleText(summary)}`;
}
