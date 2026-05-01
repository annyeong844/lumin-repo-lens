// Pre-write intent schema validator.
//
// The pre-write gate's Step 2 (per canonical/pre-write-gate.md §3 Step
// 2) asks Claude to declare five intent bullets before lookup runs:
//   - names
//   - shapes
//   - files
//   - dependencies
//   - plannedTypeEscapes
//
// Empty arrays are OK. Missing top-level arrays are defaulted to [] with
// schema warnings so small/vibe-coder intents like {"files": [...]} don't
// fail before the useful lookup starts. Present-but-wrong types still fail:
// defaulting is only for absence, never for malformed data.
//
// Names and dependencies accept either terse strings or structured
// self-declarations (`{ name, kind?, why? }`, `{ specifier, why? }`).
// They normalize to string arrays for lookup compatibility while the
// structured declarations are preserved when present.
//
// plannedTypeEscapes items are structured objects, not strings. Shape
// mirrors canonical/fact-model.md §3.9 type-escape so the P2 post-write
// delta can compare planned vs observed 1:1.

// ── Canonical escapeKind enumeration ─────────────────────────
//
// Source of truth: canonical/fact-model.md §3.9. Any drift between
// this list and the canonical file is a defect — the tests lock it.

export const ESCAPE_KINDS = Object.freeze([
  'explicit-any',
  'as-any',
  'angle-any',
  'as-unknown-as-T',
  'rest-any-args',
  'index-sig-any',
  'generic-default-any',
  'ts-ignore',
  'ts-expect-error',
  'no-explicit-any-disable',
  'jsdoc-any',
]);

const ESCAPE_KIND_SET = new Set(ESCAPE_KINDS);

// ── plannedTypeEscapes entry keys (canonical shape) ──────────
//
// Single source of truth for the keys on a `plannedTypeEscapes[i]`
// entry, mirroring `canonical/fact-model.md §3.9` post-amendment.
// Consumers downstream (`_lib/post-write-delta.mjs::matchPlanned`) read
// named fields directly from the entry and then forward the whole
// object into `delta.entries[].plannedEntry`. Without this constant,
// adding a new canonical field meant a silent drop in normalization
// (unknown key stripped) while post-write still tried to read it.
//
// `required`  — entry.<key> MUST be present and correctly-typed.
// `optional`  — entry.<key> MAY be present; validator accepts absence.
export const PLANNED_ESCAPE_KEYS = Object.freeze({
  required: Object.freeze(['escapeKind', 'locationHint', 'reason']),
  optional: Object.freeze(['codeShape', 'alternativeConsidered']),
});

export const PLANNED_ESCAPE_ALL_KEYS = Object.freeze([
  ...PLANNED_ESCAPE_KEYS.required,
  ...PLANNED_ESCAPE_KEYS.optional,
]);

// ── Top-level intent keys ────────────────────────────────────

const TOP_LEVEL_ARRAY_KEYS = Object.freeze([
  'names',
  'shapes',
  'files',
  'dependencies',
  'plannedTypeEscapes',
]);

// ── Helpers ──────────────────────────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function fail(error, errorPath) {
  return { ok: false, error, errorPath };
}

function optionalStringField(entry, field, errorPath) {
  if (entry[field] !== undefined &&
      (typeof entry[field] !== 'string' || entry[field].length === 0)) {
    return fail(`${errorPath}.${field} must be a non-empty string when present`,
                `${errorPath}.${field}`);
  }
  return null;
}

function normalizeNameEntry(entry, index) {
  const errorPath = `names[${index}]`;
  if (typeof entry === 'string') {
    if (entry.length === 0) return fail(`${errorPath} must be a non-empty string`, errorPath);
    return { value: entry, declaration: null };
  }
  if (!isPlainObject(entry)) {
    return fail(`${errorPath} must be a non-empty string or object with name`, errorPath);
  }
  if (typeof entry.name !== 'string' || entry.name.length === 0) {
    return fail(`${errorPath}.name must be a non-empty string`, `${errorPath}.name`);
  }
  const kindErr = optionalStringField(entry, 'kind', errorPath);
  if (kindErr) return kindErr;
  const whyErr = optionalStringField(entry, 'why', errorPath);
  if (whyErr) return whyErr;
  return {
    value: entry.name,
    declaration: {
      name: entry.name,
      ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
      ...(entry.why !== undefined ? { why: entry.why } : {}),
    },
  };
}

function normalizeDependencyEntry(entry, index) {
  const errorPath = `dependencies[${index}]`;
  if (typeof entry === 'string') {
    if (entry.length === 0) return fail(`${errorPath} must be a non-empty string`, errorPath);
    return { value: entry, declaration: null };
  }
  if (!isPlainObject(entry)) {
    return fail(`${errorPath} must be a non-empty string or object with specifier`, errorPath);
  }
  if (typeof entry.specifier !== 'string' || entry.specifier.length === 0) {
    return fail(`${errorPath}.specifier must be a non-empty string`, `${errorPath}.specifier`);
  }
  const whyErr = optionalStringField(entry, 'why', errorPath);
  if (whyErr) return whyErr;
  return {
    value: entry.specifier,
    declaration: {
      specifier: entry.specifier,
      ...(entry.why !== undefined ? { why: entry.why } : {}),
    },
  };
}

// ── Per-entry validators ─────────────────────────────────────

function validateShape(shape, index) {
  if (!isPlainObject(shape)) {
    return fail(`shapes[${index}] must be an object`, `shapes[${index}]`);
  }
  const hasExactInput = shape.hash !== undefined || shape.typeLiteral !== undefined;
  if (shape.fields === undefined && !hasExactInput) {
    return fail(`shapes[${index}].fields must be an array`, `shapes[${index}].fields`);
  }
  if (shape.fields !== undefined && !Array.isArray(shape.fields)) {
    return fail(`shapes[${index}].fields must be an array`, `shapes[${index}].fields`);
  }
  const fields = shape.fields ?? [];
  for (let j = 0; j < fields.length; j++) {
    if (typeof fields[j] !== 'string' || fields[j].length === 0) {
      return fail(`shapes[${index}].fields[${j}] must be a non-empty string`,
                  `shapes[${index}].fields[${j}]`);
    }
  }
  if (shape.hash !== undefined) {
    if (typeof shape.hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(shape.hash)) {
      return fail(`shapes[${index}].hash must be sha256:<64 lowercase hex> when present`,
                  `shapes[${index}].hash`);
    }
  }
  if (shape.typeLiteral !== undefined) {
    if (typeof shape.typeLiteral !== 'string' || shape.typeLiteral.trim().length === 0) {
      return fail(`shapes[${index}].typeLiteral must be a non-empty string when present`,
                  `shapes[${index}].typeLiteral`);
    }
  }
  const nameErr = optionalStringField(shape, 'name', `shapes[${index}]`);
  if (nameErr) return nameErr;
  const whyErr = optionalStringField(shape, 'why', `shapes[${index}]`);
  if (whyErr) return whyErr;
  return null;
}

function validatePlannedEscape(entry, index) {
  const pathPrefix = `plannedTypeEscapes[${index}]`;

  if (!isPlainObject(entry)) {
    return fail(`${pathPrefix} must be an object`, pathPrefix);
  }

  // escapeKind — required, must be in the canonical enum.
  if (!ESCAPE_KIND_SET.has(entry.escapeKind)) {
    return fail(
      `${pathPrefix}.escapeKind must be one of ${JSON.stringify(ESCAPE_KINDS)}; got ${JSON.stringify(entry.escapeKind)}`,
      `${pathPrefix}.escapeKind`
    );
  }

  // locationHint — required, non-empty string. Literal 'unknown' is OK.
  if (typeof entry.locationHint !== 'string' || entry.locationHint.length === 0) {
    return fail(
      `${pathPrefix}.locationHint is required and must be a non-empty string (use literal "unknown" when the identity is not yet known)`,
      `${pathPrefix}.locationHint`
    );
  }

  // reason — required, non-empty string.
  if (typeof entry.reason !== 'string' || entry.reason.length === 0) {
    return fail(
      `${pathPrefix}.reason is required and must be a non-empty string (the intent-side half of the three-stage any-defense needs WHY)`,
      `${pathPrefix}.reason`
    );
  }

  // codeShape — optional, but if present must be a string.
  if (entry.codeShape !== undefined && typeof entry.codeShape !== 'string') {
    return fail(`${pathPrefix}.codeShape must be a string when present`,
                `${pathPrefix}.codeShape`);
  }

  // alternativeConsidered — optional, but if present must be a string.
  if (entry.alternativeConsidered !== undefined && typeof entry.alternativeConsidered !== 'string') {
    return fail(`${pathPrefix}.alternativeConsidered must be a string when present`,
                `${pathPrefix}.alternativeConsidered`);
  }

  return null;
}

// ── Entry point ──────────────────────────────────────────────

/**
 * Validate and normalize an intent block.
 *
 * @param {unknown} raw  value to validate (typically parsed from JSON)
 * @returns {{
 *   ok: true,
 *   intent: {
 *     names: string[],
 *     nameDeclarations?: { name: string, kind?: string, why?: string }[],
 *     shapes: { fields: string[], hash?: string, typeLiteral?: string, name?: string, why?: string }[],
 *     files: string[],
 *     dependencies: string[],
 *     dependencyDeclarations?: { specifier: string, why?: string }[],
 *     plannedTypeEscapes: Array<{
 *       escapeKind: string,
 *       locationHint: string,
 *       codeShape?: string,
 *       reason: string,
 *       alternativeConsidered?: string,
 *     }>,
 *     [extra: string]: unknown,   // extra top-level keys preserved
 *   },
 *   warnings: { kind: string, key: string, action: string }[],
 * } | {
 *   ok: false,
 *   error: string,
 *   errorPath: string,
 * }}
 */
export function validateIntent(raw) {
  if (!isPlainObject(raw)) {
    return fail('intent must be a plain object', '');
  }

  const warnings = [];
  const normalizedInput = { ...raw };

  // 1. Missing top-level arrays default to [] with an explicit warning.
  for (const key of TOP_LEVEL_ARRAY_KEYS) {
    if (!(key in normalizedInput)) {
      normalizedInput[key] = [];
      warnings.push({
        kind: 'missing-intent-key-defaulted',
        key,
        action: 'defaulted-to-empty-array',
      });
    }
  }

  // 2. Top-level types — each known intent key must be an array when present.
  for (const key of TOP_LEVEL_ARRAY_KEYS) {
    if (!Array.isArray(normalizedInput[key])) {
      return fail(`${key} must be an array`, key);
    }
  }

  // 3. names — terse strings or structured self-declarations.
  const names = [];
  const nameDeclarations = [];
  for (let i = 0; i < normalizedInput.names.length; i++) {
    const normalized = normalizeNameEntry(normalizedInput.names[i], i);
    if (normalized.ok === false) return normalized;
    names.push(normalized.value);
    if (normalized.declaration) nameDeclarations.push(normalized.declaration);
  }

  // 4. shapes — each { fields: string[], hash?: sha256:<64hex>, typeLiteral?: string }.
  for (let i = 0; i < normalizedInput.shapes.length; i++) {
    const err = validateShape(normalizedInput.shapes[i], i);
    if (err) return err;
  }

  // 5. files — array of non-empty strings.
  for (let i = 0; i < normalizedInput.files.length; i++) {
    if (typeof normalizedInput.files[i] !== 'string' || normalizedInput.files[i].length === 0) {
      return fail(`files[${i}] must be a non-empty string`, `files[${i}]`);
    }
  }

  // 6. dependencies — terse strings or structured self-declarations.
  const dependencies = [];
  const dependencyDeclarations = [];
  for (let i = 0; i < normalizedInput.dependencies.length; i++) {
    const normalized = normalizeDependencyEntry(normalizedInput.dependencies[i], i);
    if (normalized.ok === false) return normalized;
    dependencies.push(normalized.value);
    if (normalized.declaration) dependencyDeclarations.push(normalized.declaration);
  }

  // 7. plannedTypeEscapes — each entry fully validated.
  for (let i = 0; i < normalizedInput.plannedTypeEscapes.length; i++) {
    const err = validatePlannedEscape(normalizedInput.plannedTypeEscapes[i], i);
    if (err) return err;
  }

  // 8. Normalize — extra top-level keys (like taskId) are preserved
  //    so callers can thread task identifiers through without a schema
  //    revision. The 5 known keys are always present and typed.
  const normalized = {
    ...normalizedInput,
    names,
    ...(nameDeclarations.length > 0 ? { nameDeclarations } : {}),
    shapes: normalizedInput.shapes.map((s) => ({
      fields: [...(s.fields ?? [])],
      ...(s.hash !== undefined ? { hash: s.hash } : {}),
      ...(s.typeLiteral !== undefined ? { typeLiteral: s.typeLiteral } : {}),
      ...(s.name !== undefined ? { name: s.name } : {}),
      ...(s.why !== undefined ? { why: s.why } : {}),
    })),
    files: [...normalizedInput.files],
    dependencies,
    ...(dependencyDeclarations.length > 0 ? { dependencyDeclarations } : {}),
    plannedTypeEscapes: normalizedInput.plannedTypeEscapes.map((e) => {
      // Build the normalized entry from PLANNED_ESCAPE_KEYS so adding a
      // canonical §3.9 field to the constant propagates here without a
      // manual edit. Required keys already validated above; optional keys
      // only copied when present (preserves the "undefined is absence"
      // contract).
      const out = {};
      for (const k of PLANNED_ESCAPE_KEYS.required) out[k] = e[k];
      for (const k of PLANNED_ESCAPE_KEYS.optional) {
        if (e[k] !== undefined) out[k] = e[k];
      }
      return out;
    }),
  };

  return { ok: true, intent: normalized, warnings };
}
