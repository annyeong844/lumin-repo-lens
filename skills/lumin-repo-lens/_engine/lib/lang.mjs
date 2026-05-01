// Language detection for audit scripts.
//
// Centralizes the per-file language decision that was previously
// inlined as `filePath.endsWith('.tsx') ? 'tsx' : 'ts'` in every caller.
// That inlined form had two problems:
//
//   1. `.jsx` files were parsed as TS. oxc-parser doesn't accept JSX
//      syntax in TS mode, so pure React+JS codebases produced dozens of
//      spurious parse errors and `extractDefinitionsAndUses` returned
//      empty def/use lists — everything looked dead.
//   2. `.mjs` / `.cjs` / `.js` were also forced into TS mode. This
//      happens to work for most JS because TS is (almost) a superset,
//      but the edge cases fail silently.
//
// Using this helper means new language support (or a parser migration)
// is a local change.
//
// Public exports:
//   - langForFile(path) → the value oxc-parser accepts in its `lang`
//     option ('ts' | 'tsx' | 'js' | 'jsx'), or null for non-JS-family
//     files (Python / Go / Rust / other).
//   - canContainJsx(path) → true for .tsx / .jsx. Callers that need to
//     decide whether to look for JSX-specific patterns (e.g. React
//     element creation) use this instead of overloading langForFile.
//   - nonJsLangForFile(path) → 'python' | 'go' | null. For dispatching
//     to language-specific extractors (_lib/python.mjs, tree-sitter for
//     Go, etc.).

const TS_EXTS = /\.(mts|cts|ts)$/i;
const TSX_EXTS = /\.tsx$/i;
const JS_EXTS  = /\.(mjs|cjs|js)$/i;
const JSX_EXTS = /\.jsx$/i;

// v1.8.3: canonical list of JS-family extensions. Used by every scanner
// that walks the tree looking for source files (build-symbol-graph,
// build-call-graph, measure-topology, check-barrel-discipline,
// resolve-method-calls, triage-repo, measure-discipline). Before this
// constant existed, each script inlined its own truncated list —
// typically `['ts', 'tsx', 'js', 'mjs']` — silently dropping `.jsx`,
// `.cjs`, `.mts`, `.cts`. A pure-JSX repo scanned as 0 files; a `.cts`
// dual-emit package missed half its definitions; etc.
export const JS_FAMILY_LANGS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];

export function langForFile(filePath) {
  if (TSX_EXTS.test(filePath)) return 'tsx';
  if (JSX_EXTS.test(filePath)) return 'jsx';
  if (TS_EXTS.test(filePath))  return 'ts';
  if (JS_EXTS.test(filePath))  return 'js';
  return null;
}

export function canContainJsx(filePath) {
  return TSX_EXTS.test(filePath) || JSX_EXTS.test(filePath);
}

export function nonJsLangForFile(filePath) {
  if (/\.py$/i.test(filePath)) return 'python';
  if (/\.go$/i.test(filePath)) return 'go';
  return null;
}
