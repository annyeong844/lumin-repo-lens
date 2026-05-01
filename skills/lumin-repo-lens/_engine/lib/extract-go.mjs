// Go file shape converter for the symbol graph.
//
// The tree-sitter Go extractor in `_lib/tree-sitter-langs.mjs`
// emits language-native records ({defs, imports, uses} where uses
// carry `nsName` — the selector-expression object). This converter
// projects them onto the canonical graph shape
// ({filePath, defs, uses, reExports, loc}) that build-symbol-graph
// and downstream scripts consume uniformly.
//
// Go limits surfaced here (tracked in SKILL.md's Language Support
// section): within-package plain references (no `pkg.` prefix) and
// interface-dispatch are not yet tracked. `main` entry functions
// also appear dead (no consumer) — identical to TS entry-file
// behavior.

export function goExtractShape(filePath, goRec) {
  const defs = (goRec.defs ?? []).map((d) => ({
    name: d.name,
    kind: d.kind,
    line: d.line,
  }));
  const uses = [];
  // Map selector uses (`util.DoThing`) to symbol use with fromSpec =
  // import path for that alias. Build alias→path map from imports
  // first; selector uses then resolve against it.
  const aliasToPath = new Map();
  for (const imp of goRec.imports ?? []) {
    // If an alias is set, use it; else the default local name is the
    // last path segment.
    const local = imp.name ?? imp.source.split('/').pop();
    aliasToPath.set(local, imp.source);
  }
  for (const u of goRec.uses ?? []) {
    const src = aliasToPath.get(u.nsName);
    if (!src) continue;                // selector on non-import (local struct etc.)
    uses.push({
      fromSpec: src,
      name: u.name,
      kind: 'import',
      typeOnly: false,
      line: u.line,
    });
  }
  return { filePath, defs, uses, reExports: [], loc: goRec.loc ?? 0 };
}
