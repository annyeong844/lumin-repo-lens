// Pre-write advisory render (P1-1 step 5.5).
//
// Pure functions — take an advisory object and return Markdown / JSON.
// No I/O, no side effects. `_lib/pre-write-artifact.mjs` handles the
// write side.
//
// Markdown sections (per canonical/pre-write-gate.md §5, subset P1-1):
//   - Already exists (reuse candidates)
//   - Already exists — but any-contaminated (reuse with warning)
//   - Search hints (not reuse candidates)
//   - Planned type escapes (from Step 2 intent)
//
// P1-2 additions:
//   - New code candidates         (NEW_FILE / FILE_STATUS_UNKNOWN / NEW_PACKAGE)
//   - Watch-for                   (shape UNAVAILABLE, file hub, dep hub)
//
// Still deferred:
//   - Formal CANONICAL DRIFT:     (P1-3 §5.9)

// Watch-for threshold for "file is an inbound hub". Hardcoded per
// maintainer history notes §4.6; config flag is P2.
const HUB_INBOUND_FAN_IN_THRESHOLD = 10;

// Imported lazily inside renderJson/renderMarkdown so downstream
// consumers that only call one path don't pay for the other module.
import { isWatchForEligible, DEPENDENCY_WATCH_FOR_THRESHOLD } from './pre-write-lookup-dep.mjs';

// ── Canonical 10-escapeKind enumeration (mirror) ─────────────
//
// Referenced in the empty-list rendering so the "what counts as an
// escape" surface matches canonical/fact-model.md §3.9 exactly. The
// validator in `_lib/pre-write-intent.mjs` holds the authoritative list;
// this array is a render-side mirror.
const ALL_ESCAPE_KINDS = [
  'explicit-any', 'as-any', 'angle-any', 'as-unknown-as-T',
  'rest-any-args', 'index-sig-any', 'generic-default-any',
  'ts-ignore', 'ts-expect-error', 'no-explicit-any-disable',
  'jsdoc-any',
];

// ── Section classifier ──────────────────────────────────────
//
// Routes a name lookup to one of four sections:
//   - 'any-contaminated' — contaminated candidates
//   - 'already-exists'   — EXISTS / EXISTS_MULTIPLE / CANONICAL_EXISTS_*
//   - 'search-hints'     — NOT_OBSERVED with nearNames / semanticHints
//   - 'none'             — NOT_OBSERVED without hints (no render)

function sectionFor(lookup) {
  // Name lookups (P1-1).
  if (lookup.kind === 'name') {
    const isContaminated = (id) =>
      id.anyContamination?.state === 'any-contaminated' ||
      id.anyContamination?.state === 'severely-any-contaminated';
    if (lookup.identities?.some(isContaminated)) return 'any-contaminated';
    if (
      lookup.result === 'NOT_OBSERVED' &&
      ((lookup.nearNames?.length ?? 0) > 0 || (lookup.semanticHints?.length ?? 0) > 0) &&
      (lookup.identities?.length ?? 0) === 0 &&
      !lookup.canonicalClaim
    ) return 'search-hints';
    return 'already-exists';
  }

  // File lookups (P1-2).
  if (lookup.kind === 'file') {
    if (lookup.result === 'NEW_FILE' || lookup.result === 'FILE_STATUS_UNKNOWN') {
      return 'new-code';
    }
    // FILE_EXISTS → Already exists. Possibly ALSO contributes a Watch-for
    // entry for hub signal — handled by buildWatchForEntries.
    return 'already-exists';
  }

  // Dependency lookups (P1-2). Reuse fact, not creation.
  if (lookup.kind === 'dependency') {
    if (lookup.result === 'NEW_PACKAGE') return 'new-code';
    // DEPENDENCY_AVAILABLE / DEPENDENCY_AVAILABLE_NO_OBSERVED_IMPORTS
    // render as reuse rows. Hub-level consumer count may also contribute
    // a Watch-for entry (see buildWatchForEntries).
    return 'already-exists';
  }

  // Shape lookups (P1-2) — always Watch-for.
  if (lookup.kind === 'shape') return 'watch-for';

  return 'already-exists';
}

// ── Per-lookup row renderers ────────────────────────────────

function renderFanInSummary(identity) {
  if (identity.fanInConfidence !== 'grounded') return 'fan-in unavailable';
  const base = `fan-in ${identity.fanIn}`;
  if (identity.fanInSpaceConfidence !== 'grounded' || !identity.fanInSpace) {
    return base;
  }
  const value = identity.fanInSpace.value ?? 0;
  const type = identity.fanInSpace.type ?? 0;
  const broad = identity.fanInSpace.broad ?? 0;
  return `${base} (value ${value}, type ${type}, broad ${broad})`;
}

function renderIdentityRow(lookup, identity) {
  const out = [];
  const fanInStr = renderFanInSummary(identity);
  out.push(`- ${lookup.result} at \`${identity.identity}\` — ${fanInStr}.`);
  for (const c of identity.citations ?? []) {
    if (
      identity.anyContamination?.state === 'capability-absent' &&
      /producer did not emit anyContamination capability/.test(c)
    ) {
      continue;
    }
    out.push(`  ${c}`);
  }
  return out;
}

function renderLookupAlreadyExists(lookup) {
  const out = [];

  // NOT_OBSERVED bare (no canonical, no near-names) — surface as a
  // "not observed in scan range" line with the citations the lookup
  // produced (typically [확인 불가, ...]).
  if (
    lookup.result === 'NOT_OBSERVED' &&
    !lookup.canonicalClaim &&
    (lookup.identities?.length ?? 0) === 0
  ) {
    out.push(`- \`${lookup.intentName}\` — NOT_OBSERVED in scan range.`);
    for (const c of lookup.citations ?? []) {
      out.push(`  ${c}`);
    }
    return out;
  }

  // Canonical declaration first — one citation line per claim.
  if (lookup.canonicalClaim) {
    const cc = lookup.canonicalClaim;
    const fileName = cc.file.split(/[\\/]/).pop();
    out.push(`- ${lookup.result} — canonical \`${fileName}:L${cc.line}\` declares owner \`${cc.ownerFile}\` for \`${lookup.intentName}\`.`);
    out.push(`  [grounded, canonical/${fileName}:L${cc.line} row for '${lookup.intentName}' → owner '${cc.ownerFile}']`);
    if (lookup.canonicalAstStatus === 'ast-absent') {
      out.push(`  [확인 불가, scan range: current AST does not observe '${lookup.intentName}' under TS/JS production scope]`);
    } else if (lookup.canonicalAstStatus === 'owner-disagrees') {
      const astOwners = (lookup.identities ?? []).map((i) => i.ownerFile);
      out.push(`  Note: canonical declares owner \`${cc.ownerFile}\`; current AST observes owner(s) \`${astOwners.join(', ')}\`. Formal drift warning is deferred to P1-3 per canonical/pre-write-gate.md §8.`);
    }
  }

  // Per-identity rows.
  for (const identity of lookup.identities ?? []) {
    out.push(...renderIdentityRow(lookup, identity));
  }
  return out;
}

function renderLookupAnyContaminated(lookup) {
  const out = [];
  for (const identity of lookup.identities ?? []) {
    const ann = identity.anyContamination;
    const label = ann?.state === 'severely-any-contaminated'
      ? 'severely-any-contaminated'
      : 'any-contaminated';
    const meas = ann?.measurements ? ` raw: ${JSON.stringify(ann.measurements)}` : '';
    const recommendation = ann?.recommendation ?? {
      action: 'warn-on-reuse',
      confidence: 'low',
      reason: `${label} semantic reuse caution`,
    };
    out.push(`- \`${identity.identity}\` — **${label}** (reuse with warning).${meas}`);
    out.push(`  [recommendation: ${recommendation.action}, confidence: ${recommendation.confidence}, reason: ${recommendation.reason}; measurement remains grounded]`);
    for (const c of identity.citations ?? []) {
      out.push(`  ${c}`);
    }
  }
  return out;
}

function renderLookupSearchHints(lookup) {
  const out = [];
  out.push(`- ${lookup.result} for \`${lookup.intentName}\` — search hint only, NOT a grounded reuse claim.`);
  const hasNear = (lookup.nearNames?.length ?? 0) > 0;
  const hasSemantic = (lookup.semanticHints?.length ?? 0) > 0;
  if (hasNear) {
    out.push(`  [degraded, fuzzy-name match; source: symbols.json.defIndex name scan — search hint only, NOT a grounded reuse claim]`);
  }
  if (hasSemantic) {
    out.push(`  [degraded, intent-token match; source: symbols.json.defIndex plus intent.name/intent.why tokens — search hint only, NOT a grounded reuse claim]`);
  }
  for (const hint of lookup.nearNames ?? []) {
    out.push(`  - \`${hint.name}\` at \`${hint.ownerFile}\` (edit-distance ${hint.distance})`);
  }
  for (const hint of lookup.semanticHints ?? []) {
    out.push(`  - \`${hint.name}\` at \`${hint.ownerFile}\` (matched tokens: ${hint.matchedTokens.map((t) => `\`${t}\``).join(', ')})`);
  }
  return out;
}

// ── P1-2 per-lookup renderers ──

function renderLookupFile_AlreadyExists(lookup) {
  const out = [];
  const loc = lookup.loc !== null ? `, loc ${lookup.loc}` : '';
  const fanInStr = lookup.inboundFanInConfidence === 'grounded'
    ? `, inbound fan-in ${lookup.inboundFanIn}`
    : '';
  out.push(`- ${lookup.result} — \`${lookup.intentFile}\`${loc}${fanInStr}.`);
  for (const c of lookup.citations ?? []) out.push(`  ${c}`);
  return out;
}

function renderLookupFile_NewCode(lookup) {
  const out = [];
  out.push(`- ${lookup.result} — \`${lookup.intentFile}\`.`);
  for (const c of lookup.citations ?? []) out.push(`  ${c}`);
  // Boundary is always NOT_EVALUATED in P1-2; surface it as a neutral sub-line.
  if (lookup.boundary?.status === 'NOT_EVALUATED') {
    out.push(`  boundary: not evaluated (no planned from→to edge in intent).`);
  } else if (lookup.boundary?.status === 'ALLOWED') {
    out.push(`  boundary: ALLOWED by rule \`${lookup.boundary.rule?.from} → ${lookup.boundary.rule?.to}\` in \`${lookup.boundary.rule?.declaredIn}\`.`);
  } else if (lookup.boundary?.status === 'FORBIDDEN') {
    out.push(`  boundary: FORBIDDEN by rule \`${lookup.boundary.rule?.from} → ${lookup.boundary.rule?.to}\` in \`${lookup.boundary.rule?.declaredIn}\` — advisory, not a blocker.`);
  }
  return out;
}

function renderLookupDep_AlreadyExists(lookup) {
  const out = [];
  const c = lookup.existingImports?.observedImportCount ?? 0;
  let cntStr = `sample only`;
  if (lookup.existingImports?.countConfidence === 'grounded') {
    cntStr = `${c} observed consumer${c === 1 ? '' : 's'}`;
  } else if (lookup.existingImports?.countConfidence === 'unavailable') {
    cntStr = 'import graph unavailable';
  }
  out.push(`- ${lookup.result} — \`${lookup.depName}\` declared in \`${lookup.declaredIn}\`, ${cntStr}.`);
  for (const c of lookup.citations ?? []) out.push(`  ${c}`);
  const examples = lookup.existingImports?.examples ?? [];
  for (const ex of examples) {
    out.push(`  - example consumer: \`${ex.file}\` (\`${ex.fromSpec}\`)`);
  }
  return out;
}

function renderLookupDep_NewCode(lookup) {
  const out = [];
  out.push(`- NEW_PACKAGE — \`${lookup.depName}\` not in package.json.{dependencies, devDependencies, peerDependencies}.`);
  for (const c of lookup.citations ?? []) out.push(`  ${c}`);
  return out;
}

function renderLookupShape_WatchFor(lookup) {
  const out = [];
  const fieldStr = (lookup.shape?.fields ?? []).map((f) => `\`${f}\``).join(', ');
  const shapeLabel = lookup.shapeHashSource === 'functionSignature'
    ? `function signature hash \`${lookup.shapeHash ?? 'unknown'}\``
    : fieldStr.length > 0
    ? `\`{ ${fieldStr} }\``
    : `hash \`${lookup.shape?.hash ?? lookup.shapeHash ?? 'unknown'}\``;
  out.push(`- Shape ${shapeLabel} — lookup ${lookup.result}.`);
  for (const c of lookup.citations ?? []) out.push(`  ${c}`);
  for (const match of lookup.matches ?? []) {
    out.push(`  - matching identity: \`${match.identity}\` (${match.confidence ?? 'unknown'} confidence)`);
  }
  return out;
}

function renderFileHub(lookup) {
  const out = [];
  out.push(`- Hub signal — \`${lookup.intentFile}\` has high inbound fan-in.`);
  out.push(`  [grounded, topology.json.nodes['${lookup.intentFile}'].inboundFanIn = ${lookup.inboundFanIn}, threshold = ${HUB_INBOUND_FAN_IN_THRESHOLD}]`);
  return out;
}

function renderDepHub(lookup) {
  const out = [];
  const c = lookup.existingImports?.observedImportCount;
  out.push(`- Hub signal — \`${lookup.depName}\` is deeply entangled.`);
  out.push(`  [grounded, package.json declares '${lookup.depName}'; symbols.json.uses observed ${c} consumers, threshold = ${DEPENDENCY_WATCH_FOR_THRESHOLD}]`);
  return out;
}

function renderDomainCluster(lookup) {
  const cluster = lookup.domainCluster;
  const out = [];
  const loc = typeof cluster.totalLoc === 'number'
    ? `, total LOC ${cluster.totalLoc}`
    : '';
  const relation = cluster.matchKind === 'domain-token'
    ? `shares domain token \`${cluster.basenamePrefix}\``
    : `shares prefix \`${cluster.prefixPath}*\``;
  out.push(`- DOMAIN_CLUSTER_DETECTED — planned \`${lookup.intentFile}\` ${relation} with ${cluster.matchCount} existing files${loc}.`);
  for (const c of cluster.citations ?? []) out.push(`  ${c}`);
  out.push(`  recommend: inspect the existing domain cluster before creating a parallel owner file.`);
  for (const ex of cluster.examples ?? []) {
    const exLoc = typeof ex.loc === 'number' ? `, loc ${ex.loc}` : '';
    out.push(`  - existing file: \`${ex.file}\`${exLoc}`);
  }
  if (cluster.omittedCount > 0) {
    out.push(`  - ... ${cluster.omittedCount} more file${cluster.omittedCount === 1 ? '' : 's'} omitted`);
  }
  return out;
}

function isFileHub(lookup) {
  return (
    lookup.kind === 'file' &&
    lookup.result === 'FILE_EXISTS' &&
    lookup.inboundFanInConfidence === 'grounded' &&
    typeof lookup.inboundFanIn === 'number' &&
    lookup.inboundFanIn >= HUB_INBOUND_FAN_IN_THRESHOLD
  );
}

function isDepHub(lookup) {
  return lookup.kind === 'dependency' && isWatchForEligible(lookup.existingImports);
}

function hasDomainCluster(lookup) {
  return lookup.kind === 'file' && lookup.domainCluster?.kind === 'DOMAIN_CLUSTER_DETECTED';
}

function renderCapabilityNotes(lookups) {
  const hasAnyCapabilityAbsent = lookups.some((lookup) =>
    lookup.kind === 'name' &&
    (lookup.identities ?? []).some((id) => id.anyContamination?.state === 'capability-absent')
  );
  if (!hasAnyCapabilityAbsent) return [];
  return [
    '> Capability note: anyContamination evidence is not available in this symbols.json; reuse rows omit per-candidate any-contamination status.',
    '> [확인 불가, reason: producer did not emit anyContamination capability]',
    '',
  ];
}

function evidenceSummary(evidence) {
  const items = Array.isArray(evidence) ? evidence : [];
  if (items.length === 0) return 'evidence recorded';
  return items.map((item) => {
    const parts = [];
    if (item.artifact) parts.push(item.artifact);
    if (item.matchedField) parts.push(item.matchedField);
    if (item.algorithmVersion) parts.push(item.algorithmVersion);
    return parts.join(' / ');
  }).filter(Boolean).join('; ');
}

function renderCueSections(advisory) {
  const cueCards = advisory.cueCards ?? [];
  const unavailable = advisory.unavailableEvidence ?? [];
  const grounded = [];
  const review = [];

  for (const card of cueCards) {
    for (const cue of card.cues ?? []) {
      const row = `- \`${card.candidate?.identity ?? 'unknown'}\` — ${cue.claim}.`;
      const evidence = `  [${cue.confidence ?? 'grounded'}, ${evidenceSummary(cue.evidence)}; cueTier=${cue.cueTier}]`;
      if (cue.cueTier === 'SAFE_CUE') {
        grounded.push(row, evidence, '  Note: grounded fact only; not a semantic-equivalence or auto-reuse claim.');
      } else if (cue.cueTier === 'AGENT_REVIEW_CUE') {
        review.push(row, evidence, '  action: inspect the cited file or symbol before creating parallel code.');
      }
    }
  }

  const out = [];
  if (grounded.length > 0) {
    out.push('### Grounded facts', '', ...grounded, '');
  }
  if (review.length > 0) {
    out.push('### Agent review cues', '', ...review, '');
  }
  if (unavailable.length > 0) {
    out.push('### Unavailable evidence', '');
    for (const u of unavailable) {
      out.push(`- ${u.evidenceLane ?? 'unknown'} — ${u.status ?? 'UNAVAILABLE'} (${u.reason ?? 'unknown'}).`);
      if (u.artifact) out.push(`  artifact: \`${u.artifact}\``);
      for (const c of u.citations ?? []) out.push(`  ${c}`);
    }
    out.push('');
  }
  return out;
}

function cueCoveredIdentities(advisory) {
  const covered = new Set();
  for (const card of advisory.cueCards ?? []) {
    const identity = card.candidate?.identity;
    if (!identity) continue;
    for (const cue of card.cues ?? []) {
      if (['exact-symbol', 'near-name', 'intent-token', 'function-signature', 'shape-hash', 'exact-file'].includes(cue.evidenceLane)) {
        covered.add(identity);
      }
    }
  }
  return covered;
}

function unavailableEvidenceLanes(advisory) {
  return new Set((advisory.unavailableEvidence ?? [])
    .map((u) => u.evidenceLane)
    .filter(Boolean));
}

function lookupCandidateIdentities(lookup) {
  const out = [];
  for (const identity of lookup.identities ?? []) {
    if (identity.identity) out.push(identity.identity);
  }
  for (const near of lookup.nearNames ?? []) {
    if (near.ownerFile && near.name) out.push(`${near.ownerFile}::${near.name}`);
  }
  for (const hint of lookup.semanticHints ?? []) {
    if (hint.ownerFile && hint.name) out.push(`${hint.ownerFile}::${hint.name}`);
  }
  for (const match of lookup.matches ?? []) {
    if (match.identity) out.push(match.identity);
  }
  if (lookup.kind === 'file' && lookup.intentFile) out.push(`${lookup.intentFile}::__file__`);
  return out;
}

function shouldSkipLegacyLookup(lookup, coveredIdentities, coveredUnavailableLanes) {
  if (lookup.kind === 'shape' && lookup.result === 'UNAVAILABLE') {
    const lane = lookup.shapeHashSource === 'functionSignature' ? 'function-signature' : 'shape-hash';
    return coveredUnavailableLanes.has(lane);
  }
  const identities = lookupCandidateIdentities(lookup);
  return identities.length > 0 && identities.every((identity) => coveredIdentities.has(identity));
}

function renderDriftSection(drift) {
  if (!Array.isArray(drift) || drift.length === 0) return [];
  const out = [];
  out.push('### Canonical drift');
  out.push('');
  for (const d of drift) {
    const fileName = (d.canonicalFile ?? '').split(/[\\/]/).pop();
    if (d.kind === 'owner-disagrees') {
      const astList = (d.astOwners ?? []).map((o) => `\`${o}\``).join(', ');
      out.push(`- CANONICAL DRIFT: \`${fileName}:L${d.canonicalLine}\` declares owner \`${d.canonicalOwner}\` for \`${d.intentName}\`; current AST observes owner(s) ${astList}.`);
      out.push(`  [grounded, canonical/${fileName}:L${d.canonicalLine} row for '${d.intentName}' → owner '${d.canonicalOwner}']`);
      for (const owner of d.astOwners ?? []) {
        out.push(`  [grounded, symbols.json.defIndex['${owner}']::${d.intentName} present]`);
      }
    } else if (d.kind === 'ast-absent') {
      out.push(`- CANONICAL DRIFT: \`${fileName}:L${d.canonicalLine}\` declares owner \`${d.canonicalOwner}\` for \`${d.intentName}\`; AST does not observe this name in the current scan range.`);
      out.push(`  [grounded, canonical/${fileName}:L${d.canonicalLine} row for '${d.intentName}' → owner '${d.canonicalOwner}']`);
      out.push(`  [확인 불가, scan range: current AST does not observe '${d.intentName}' — file may be absent, moved, or renamed]`);
    }
  }
  out.push('');
  return out;
}

function renderPlannedEscapes(intent) {
  const escapes = intent?.plannedTypeEscapes ?? [];
  const out = [];
  out.push('### Planned type escapes (from Step 2 intent)');
  out.push('');
  if (escapes.length === 0) {
    out.push(`- 0 escapes planned. Post-write will treat any observed \`type-escape\` (every \`escapeKind\` enumerated in \`canonical/fact-model.md\` §3.9 — ${ALL_ESCAPE_KINDS.map((k) => `\`${k}\``).join(', ')}) as a silent introduction per any-contamination.md §6 Stage 2.`);
    out.push(`  [grounded, intent extracted at pre-write Step 2 with plannedTypeEscapes = []]`);
  } else {
    for (let i = 0; i < escapes.length; i++) {
      const e = escapes[i];
      out.push(`- Planned escape #${i + 1}: \`${e.escapeKind}\` at \`${e.locationHint}\`.`);
      if (e.codeShape) out.push(`  code: \`${e.codeShape}\``);
      out.push(`  reason: ${e.reason}`);
      if (e.alternativeConsidered) out.push(`  alternative considered: ${e.alternativeConsidered}`);
      out.push(`  [grounded, intent extracted at pre-write Step 2; will be checked against observed escapes in post-write per any-contamination.md §6 Stage 2]`);
    }
  }
  out.push('');
  return out;
}

// ── renderMarkdown ──────────────────────────────────────────

/**
 * Render the advisory to Markdown.
 * @param {object} advisory
 * @returns {string}
 */
export function renderMarkdown(advisory) {
  const out = [];
  out.push('## pre-write advisory (canonical/pre-write-gate §5)');
  out.push('');

  if (advisory.artifactPaths?.invocationSpecific) {
    out.push(`Post-write handoff: \`--pre-write-advisory ${advisory.artifactPaths.invocationSpecific}\`.`);
    out.push('Use this invocation-specific path for the matching post-write check; `pre-write-advisory.latest.json` is only a convenience pointer and can be overwritten by another pre-write run.');
    out.push('');
  }

  if ((advisory.intentWarnings?.length ?? 0) > 0) {
    out.push('### Intent schema notes');
    out.push('');
    const keys = advisory.intentWarnings
      .filter((w) => w.kind === 'missing-intent-key-defaulted')
      .map((w) => w.key);
    if (keys.length > 0) {
      out.push(`- Missing top-level intent keys defaulted to empty arrays: ${keys.map((k) => `\`${k}\``).join(', ')}.`);
      out.push('  [grounded, pre-write intent schema normalization]');
    }
    out.push('');
  }

  const lookups = advisory.lookups ?? [];
  out.push(...renderCapabilityNotes(lookups));
  out.push(...renderCueSections(advisory));
  const coveredCueIdentities = cueCoveredIdentities(advisory);
  const coveredUnavailableLanes = unavailableEvidenceLanes(advisory);
  const legacyLookups = lookups.filter((lookup) =>
    !shouldSkipLegacyLookup(lookup, coveredCueIdentities, coveredUnavailableLanes)
  );

  // Route each lookup to its section. P1-1 name lookups AND P1-2
  // file/dep/shape lookups land here.
  const alreadyExists = [];
  const anyContaminated = [];
  const searchHints = [];
  const newCode = [];
  const watchFor = [];

  for (const l of legacyLookups) {
    const sec = sectionFor(l);
    if (sec === 'already-exists')     alreadyExists.push(l);
    else if (sec === 'any-contaminated') anyContaminated.push(l);
    else if (sec === 'search-hints')  searchHints.push(l);
    else if (sec === 'new-code')      newCode.push(l);
    else if (sec === 'watch-for')     watchFor.push(l);
  }

  // Hub signals also populate Watch-for (in addition to their primary section).
  for (const l of lookups) {
    if (isFileHub(l) || isDepHub(l) || hasDomainCluster(l)) watchFor.push(l);
  }

  if (alreadyExists.length > 0) {
    out.push('### Already exists (reuse candidates)');
    out.push('');
    for (const l of alreadyExists) {
      if (l.kind === 'name')            out.push(...renderLookupAlreadyExists(l));
      else if (l.kind === 'file')       out.push(...renderLookupFile_AlreadyExists(l));
      else if (l.kind === 'dependency') out.push(...renderLookupDep_AlreadyExists(l));
    }
    out.push('');
  }

  if (anyContaminated.length > 0) {
    out.push('### Already exists — but any-contaminated (reuse with warning)');
    out.push('');
    for (const l of anyContaminated) out.push(...renderLookupAnyContaminated(l));
    out.push('');
  }

  if (searchHints.length > 0) {
    out.push('### Search hints (not reuse candidates)');
    out.push('');
    for (const l of searchHints) out.push(...renderLookupSearchHints(l));
    out.push('');
  }

  if (newCode.length > 0) {
    out.push('### New code candidates');
    out.push('');
    for (const l of newCode) {
      if (l.kind === 'file')            out.push(...renderLookupFile_NewCode(l));
      else if (l.kind === 'dependency') out.push(...renderLookupDep_NewCode(l));
    }
    out.push('');
  }

  if (watchFor.length > 0) {
    out.push('### Watch-for');
    out.push('');
    for (const l of watchFor) {
      if (l.kind === 'shape') out.push(...renderLookupShape_WatchFor(l));
      if (isFileHub(l)) out.push(...renderFileHub(l));
      if (isDepHub(l)) out.push(...renderDepHub(l));
      if (hasDomainCluster(l)) out.push(...renderDomainCluster(l));
    }
    out.push('');
  }

  // Canonical drift — P1-3 section. Omitted when advisory.drift is empty.
  // The literal string "CANONICAL DRIFT:" appears ONLY here.
  out.push(...renderDriftSection(advisory.drift));

  // Planned type escapes — always rendered (empty-list has its own text).
  out.push(...renderPlannedEscapes(advisory.intent));

  return out.join('\n');
}

// ── renderJson ──────────────────────────────────────────────

/**
 * Produce the JSON artifact shape. Empty-array defaults for optional
 * collections so downstream (P2) consumers have a stable shape.
 * @param {object} advisory
 * @returns {object}
 */
export function renderJson(advisory) {
  return {
    invocationId: advisory.invocationId,
    intentHash: advisory.intentHash,
    artifactPaths: advisory.artifactPaths ?? null,
    taskId: advisory.taskId,
    scanRange: advisory.scanRange,
    intent: advisory.intent,
    intentWarnings: advisory.intentWarnings ?? [],
    lookups: advisory.lookups ?? [],
    cueCards: advisory.cueCards ?? [],
    suppressedCues: advisory.suppressedCues ?? [],
    unavailableEvidence: advisory.unavailableEvidence ?? [],
    cuePolicy: advisory.cuePolicy ?? null,
    boundaryChecks: advisory.boundaryChecks ?? [],
    drift: advisory.drift ?? [],
    capabilities: advisory.capabilities ?? null,
    failures: advisory.failures ?? [],
    // P2-0 snapshot pointer. Object may be empty ({}) when hook is
    // skipped (--no-fresh-audit) or failed; `anyInventoryPath` is ABSENT
    // rather than null per maintainer history notes §4.3 contract.
    preWrite: advisory.preWrite ?? {},
  };
}
