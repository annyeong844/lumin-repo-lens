# Pre-Write Intent Shape

Use this reference before invoking `pre-write`. The intent file is not
free-form prose. It is a small JSON declaration of what the model is about
to add or change.

Human users should not have to hand-author this JSON in normal chat use.
The assistant should infer a compact intent from the user's request, write
or stream that JSON internally, and only ask a follow-up when the planned
change cannot be inferred safely.

## Minimal Valid Intent

All five top-level keys are normalized into the advisory. Empty arrays are
valid, and missing top-level arrays are defaulted to `[]` with an
`intentWarnings` entry. Present-but-wrong types are still schema errors.

```json
{
  "names": [],
  "shapes": [],
  "files": [],
  "dependencies": [],
  "plannedTypeEscapes": []
}
```

`deps` is not accepted. Use `dependencies`.

## Fields

| Key | Meaning |
| --- | --- |
| `names` | Symbols, helpers, types, components, routes, or commands the model plans to introduce or modify. Entries may be strings or `{ "name": "...", "kind": "...", "why": "..." }`. When exact and near-name lookup miss, `why` may produce degraded intent-token search hints such as `loadArtifactJson` → existing `loadIfExists` / `readJsonFile`; these hints are not reuse claims. |
| `shapes` | Exact structural shapes the model plans to introduce. Prefer `typeLiteral` or `hash`; field names alone are not equality evidence. `fields` is required only when neither `typeLiteral` nor `hash` is present. |
| `files` | Planned file paths, relative to the `--root` passed to pre-write. Pre-write checks exact paths and sibling domain clusters by basename prefix or repeated domain token. |
| `dependencies` | Package dependencies the change expects to import, such as `date-fns` or `@scope/pkg`. This lane checks package.json declaration buckets plus observed static package-import consumers. Use `files` or `names` for internal modules, relative imports, or API surfaces. Entries may be strings or `{ "specifier": "...", "why": "..." }`. |
| `plannedTypeEscapes` | Intentional `any`, `as any`, `as unknown as T`, JSDoc `{any}`, `@ts-ignore`, or lint-disable escapes planned before writing. |

Structured `names` and `dependencies` normalize to string arrays for
lookup compatibility. Their `why` fields are preserved in the advisory
JSON as self-declaration evidence.

## Example

```json
{
  "names": [
    { "name": "formatTimestamp", "kind": "function", "why": "new display helper" },
    { "name": "TimestampViewModel", "kind": "type", "why": "view model contract" }
  ],
  "shapes": [
    {
      "name": "TimestampViewModel",
      "typeLiteral": "{ label: string; iso: string; timezone: string }"
    }
  ],
  "files": [
    "src/features/time/format-timestamp.ts"
  ],
  "dependencies": [
    { "specifier": "date-fns", "why": "timestamp formatting" }
  ],
  "plannedTypeEscapes": []
}
```

## Planned Type Escapes

When an escape is intentional, declare it before writing:

```json
{
  "escapeKind": "as-any",
  "locationHint": "src/vendor/bridge.ts",
  "reason": "third-party package has no stable public type",
  "alternativeConsidered": "local type guard"
}
```

Post-write compares this declared intent against observed escapes. Silent
new escapes must be cited or removed.
