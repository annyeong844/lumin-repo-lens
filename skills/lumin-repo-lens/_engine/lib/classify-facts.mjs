// Fact-extraction helpers for classify-dead-exports.
//
// These functions take source text + a symbol name and return objective
// observations:
//   - how many times the symbol appears in the file (excluding definition
//     and export lines),
//   - whether the symbol has a predicate-partner export (isX / assertX /
//     parseX / toX / fromX),
//   - whether a dead-list entry is an aliased `export { local as public }`.
//
// All functions are pure — no I/O, no state. The orchestrator
// (classify-dead-exports.mjs) owns I/O and policy decisions and calls
// these to assemble a per-symbol fact sheet before classifying.
//
// v1.10.0 P0: `countFileReferencesAst` replaces the regex-text counters
// as the primary path. Regex functions are kept as explicit fallback for
// parse-error files (syntactically invalid sources where no AST exists).
// The AST counter fixes four classes of FP that the regex counter hit:
//   - identifiers inside comments
//   - identifiers inside string / template literal text
//   - property keys in object literals, destructuring, and member access
//   - export-specifier self-references
//
// FP-41 (2026-04-20): the original walker matched only
// `node.type === 'Identifier'`, which misses JSXIdentifier. Any same-file
// JSX usage of an exported symbol was invisible, over-escalating Tier A
// compound-component patterns (AlertDialog + AlertDialogTrigger, etc.)
// to Tier C on TSX repos. The walker now accepts JSXIdentifier as a
// counted reference, subject to additional JSX skip rules:
//   - JSXAttribute.name   — attribute prop name, not a JS binding ref
//   - JSXMemberExpression.property — sub-component, like MemberExpression.property
//   - JSXNamespacedName.namespace — XML-ish prefix slot
// JSX usage always counts as a value reference (JSX compiles to calls).
//
// Scope-aware shadowing (2026-04-20 landed): the walker tracks a scope
// stack for FunctionDeclaration/Expression, ArrowFunctionExpression,
// ClassDeclaration/Expression, BlockStatement, CatchClause, and for-loops.
// Bindings from let/const/var/function/class declarations and function
// parameters (including destructuring) are collected on scope entry. A
// reference to `symbolName` inside any scope that rebinds the name is
// treated as bound locally and does NOT count against the top-level
// export. Evidence label stays `ast-ident-ref-count` — scope awareness
// is a precision improvement, not a new capability kind. Known edge:
// `var` hoisting across blocks is approximated (block-scoped binding in
// v1); rare for modern TS codebases.

export {
  countFileReferencesAst,
  countFileReferencesAstMany,
} from './classify-facts-ast-counter.mjs';

const IDENT_ESCAPE = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Declaration-line patterns used to exclude the in-file definition from
// the occurrence count — otherwise `function X() {}` registers as a "use"
// of X, inflating the file-internal count by one.
function localDeclPatterns(name) {
  const n = IDENT_ESCAPE(name);
  return [
    new RegExp(`\\b(?:function|class|interface|enum)\\s+${n}\\b`),
    new RegExp(`\\btype\\s+${n}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s+${n}\\b`),
    new RegExp(`\\bfunction\\s*\\*\\s*${n}\\b`), // generator
  ];
}

/**
 * Count occurrences of `name` in `text`, excluding the definition line.
 * Used for non-aliased dead exports — the symbol we're counting is the
 * same name that appears in the definition.
 */
export function countOccurrencesExceptDefLine(text, name, defLine) {
  const re = new RegExp(`\\b${IDENT_ESCAPE(name)}\\b`, 'g');
  const lines = text.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i + 1 === defLine) continue; // skip the def line itself
    const m = lines[i].match(re);
    if (m) count += m.length;
  }
  return count;
}

/**
 * Count occurrences of `localName` in `text`, excluding BOTH the export
 * specifier line AND the local declaration line. Used for aliased dead
 * exports (`export { localName as publicName }`) where we want the in-file
 * use count of the actual binding — not counting the declaration as a use.
 */
export function countExcludingDeclAndExport(text, localName, exportLine) {
  const re = new RegExp(`\\b${IDENT_ESCAPE(localName)}\\b`, 'g');
  const lines = text.split('\n');
  const patterns = localDeclPatterns(localName);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i + 1 === exportLine) continue;
    if (patterns.some((p) => p.test(lines[i]))) continue;
    const m = lines[i].match(re);
    if (m) count += m.length;
  }
  return count;
}

/**
 * Detect whether `name` has a predicate/constructor partner exported in
 * the same file — `isX`, `assertX`, `parseX`, `toX`, `fromX`. When a
 * symbol has a partner, it's often an intentional type+helper pair and
 * should stay public even if internal uses are sparse.
 */
export function hasPredicatePartner(text, name) {
  const predicates = [`is${name}`, `assert${name}`, `parse${name}`, `to${name}`, `from${name}`];
  for (const p of predicates) {
    const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${IDENT_ESCAPE(p)}\\b`);
    if (re.test(text)) return p;
  }
  return null;
}

/**
 * Is this dead-list entry an aliased `export { local as public }` where
 * the local and public names differ? These need specifier-only removal
 * (not definition removal) — the local symbol may be used elsewhere.
 */
export function isAliasedSpec(entry) {
  return entry.kind === 'ExportSpecifier'
      && entry.localName
      && entry.localName !== entry.symbol;
}

// Per-finding provenance (`specifierCouldMatchFile` + `computeFindingProvenance`)
// moved to `_lib/finding-provenance.mjs` in v1.10.2 — classify-facts.mjs
// keeps counting & predicate-partner concerns; provenance lives on its own.
