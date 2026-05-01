// Shared production/test-path classifier.
//
// Path-segment based to avoid name collisions — `contest.ts` or `latest/`
// are NOT test paths even though they contain the substring "test".
//
// Used by `collectFiles` internally (to honor `includeTests: false`) and
// via `classifyFileRole` downstream (triage-repo's `shape.testFiles`,
// classifier's per-file policy, etc.) so classification stays consistent.
//
// FP-31 additions (absorbed from build-symbol-graph.mjs local `isTestPath`):
// Nuxt/monorepo fixtures surfaced path conventions that inflated production
// dead counts — `test-support/`, `playground(s)/`, `__<any>__/` (not only
// `__tests__/` but also `__mocks__/`, `__snapshots__/`, `__tests_dts__/`),
// and the `-fixture(s)` suffix on directory segments. Folding the wider
// classifier in means `collectFiles({ includeTests: false })` and downstream
// dead-export bucketing agree on "what is a test file".

export function isTestLikePath(filePath) {
  const norm = String(filePath ?? '').replace(/\\/g, '/');
  const base = norm.split('/').pop() ?? norm;

  // Naming conventions
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;   // JS/TS foo.test.ts
  if (/(^|[-_.])test-support\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/^test_.*\.py$/.test(base)) return true;                  // pytest test_*.py
  if (/_test\.py$/.test(base)) return true;                     // pytest *_test.py
  if (/_test\.go$/.test(base)) return true;                     // Go *_test.go

  // Directory conventions (path-segment exact match, plus FP-31 patterns)
  for (const seg of norm.split('/')) {
    if (
      seg === 'test' || seg === 'tests' ||
      seg === 'e2e' || seg === 'integration' ||
      seg === 'fixtures' || seg === 'fixture' ||
      seg === 'mocks' || seg === 'mock' ||
      seg === 'test-support' ||
      seg === 'playground' || seg === 'playgrounds'
    ) return true;
    // FP-31: __<anything>__ convention — __tests__, __mocks__,
    // __snapshots__, __tests_dts__, etc.
    if (seg.length >= 4 && seg.startsWith('__') && seg.endsWith('__')) return true;
    // FP-31: *-fixture / *-fixtures directory suffix
    if (seg.endsWith('-fixture') || seg.endsWith('-fixtures')) return true;
  }
  return false;
}

function isScriptLikePath(filePath) {
  const norm = String(filePath ?? '').replace(/\\/g, '/');
  const base = norm.split('/').pop() ?? norm;
  const segments = norm.split('/').filter(Boolean);

  for (const seg of segments) {
    if (
      seg === 'script' || seg === 'scripts' ||
      seg === 'bin' ||
      seg === 'tool' || seg === 'tools' || seg === 'tooling' ||
      seg === 'task' || seg === 'tasks' ||
      seg === 'devtool' || seg === 'devtools'
    ) return true;
  }

  if (/^(eslint|vite|vitest|jest|rollup|webpack|tsup|prettier|tailwind|postcss|babel|playwright|astro|next|svelte|nuxt)\.config\./.test(base)) {
    return true;
  }
  if (/(^|[-_.])(smoke|conformance|benchmark|bench|fixture|fixtures|setup|migration|migrate|seed|generate|codegen|sync)([-_.]|$)/i.test(base)) {
    return true;
  }
  return false;
}

export function classifyFileRole(filePath) {
  if (isTestLikePath(filePath)) return 'test';
  if (isScriptLikePath(filePath)) return 'script';
  return 'production';
}
