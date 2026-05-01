// CLI args parsing for lumin-repo-lens scripts.
//
// Exposes a single function `parseCliArgs(extraOptions)` that returns a
// normalized shape `{ root, output, verbose, includeTests, exclude, raw }`.
// The extraOptions map is spread into the parseArgs options so individual
// scripts can add their own flags (e.g. `focus-class` in resolve-method-calls).
//
// Historical note: Node's `parseArgs` has two boolean-handling quirks that
// silently made test exclusion unreachable from the CLI — (a) `--no-*` is
// ignored on Node <22.4, (b) `--flag=false` stores the string "false"
// (truthy in JS). This module pre-scans argv for negation forms, adds an
// explicit `--production` flag, and coerces string booleans to real
// booleans. See CHANGELOG 1.2.0.

import { parseArgs } from 'node:util';
import { statSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const NEGATION_FLAGS = new Set([
  '--no-include-tests',
  '--no-tests',
  '--exclude-tests',
  '--production',
]);

function coerceBool(v, fallback) {
  if (v === true || v === false) return v;
  if (v === 'false' || v === 'no' || v === '0') return false;
  if (v === 'true' || v === 'yes' || v === '1') return true;
  return fallback;
}

export function normalizeIncludeTests(values = {}, argv = process.argv.slice(2)) {
  const argvNegates = argv.some((a) => NEGATION_FLAGS.has(a));
  if (argvNegates || values.production === true) return false;
  return coerceBool(values['include-tests'], true);
}

export function parseCliArgs(extraOptions = {}) {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', short: 'r' },
      output: { type: 'string', short: 'o' },
      verbose: { type: 'boolean', short: 'v', default: false },
      'include-tests': { type: 'boolean', default: true },
      production: { type: 'boolean', default: false },
      exclude: { type: 'string', multiple: true, default: [] },
      ...extraOptions,
    },
    strict: false,
  });

  const root = path.resolve(values.root ?? process.cwd());
  try {
    if (!statSync(root).isDirectory()) throw new Error(`root is not a directory: ${root}`);
  } catch (e) {
    throw new Error(`--root not accessible: ${root} (${e.message})`);
  }

  const output = path.resolve(values.output ?? path.join(root, '.audit'));
  mkdirSync(output, { recursive: true });

  const includeTests = normalizeIncludeTests(values, process.argv.slice(2));

  return {
    root,
    output,
    verbose: values.verbose,
    includeTests,
    exclude: values.exclude ?? [],
    raw: values,
  };
}
