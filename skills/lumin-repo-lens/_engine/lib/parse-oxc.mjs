// Unified entry point for all oxc-parser calls in this codebase.
//
// Problem without this helper: `oxc-parser`'s parseSync does NOT throw
// on syntactic errors — it returns them in `result.errors[]` and hands
// back whatever AST it could salvage. If callers don't check errors[],
// malformed files silently contribute empty def/use lists to the graph,
// which hides real parse failures from the user AND makes every symbol
// in those files look dead. v1.8.2 fixed this in build-symbol-graph
// only; v1.8.3 ships the fix as a helper so measure-topology,
// build-call-graph, and check-barrel-discipline can all use it.
//
// Exports:
//   parseOxcOrThrow(filePath, src) — parse and escalate any error[] to
//     a thrown Error. The outer caller's try/catch then decides whether
//     to record it in a warnings array, log, or rethrow.
//
// This module also owns the `lang` decision so all callers dispatch
// identically. Passing a non-JS-family path (e.g. `.py`, `.go`) falls
// back to `'ts'`; those callers shouldn't be hitting this helper in the
// first place (they should go through _lib/python.mjs or tree-sitter),
// but the fallback keeps the helper defensively correct.

import { parseSync } from 'oxc-parser';
import { langForFile } from './lang.mjs';

export function parseOxcOrThrow(filePath, src) {
  const result = parseSync(filePath, src, {
    sourceType: 'module',
    lang: langForFile(filePath) ?? 'ts',
  });
  if (result.errors && result.errors.length > 0) {
    const first = result.errors[0];
    const more = result.errors.length - 1;
    throw new Error(
      `oxc-parser: ${first.message ?? 'syntax error'}${more > 0 ? ` (+ ${more} more)` : ''}`
    );
  }
  return result;
}
