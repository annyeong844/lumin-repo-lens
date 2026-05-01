// Python file shape converter for the symbol graph.
//
// The Python extractor in `_lib/python.mjs` spawns python3 as a
// subprocess and receives NDJSON records per file. This converter
// projects those records onto the canonical graph shape
// ({filePath, defs, uses, reExports, loc, [pyDunderAll]}) that
// build-symbol-graph and downstream scripts consume.
//
// Python-specific metadata (`__all__`, framework-registered defs) is
// preserved as optional fields so downstream consumers that care
// about Python convention can read them; generic consumers just see
// the uniform shape.

export function pythonExtractShape(filePath, pyRec) {
  const defs = (pyRec.defs ?? []).map((d) => {
    const entry = {
      name: d.name,
      kind: d.kind,
      line: d.line,
    };
    // v1.7.2 Python conventions: carry per-def metadata so downstream
    // dead-detection can respect framework dispatch (Typer/Flask/
    // Celery/pytest) and `__all__` declarations.
    if (d.frameworkRegistered) entry.frameworkRegistered = true;
    return entry;
  });
  const uses = [];
  for (const imp of pyRec.imports ?? []) {
    if (imp.isFromImport) {
      // `from X import a, b` → each name is a symbol use from X
      for (const name of imp.imported ?? []) {
        uses.push({
          fromSpec: imp.source,
          name,
          kind: 'import',
          typeOnly: false,
          line: imp.line,
          pyIsFromImport: true,
          pyLevel: imp.level ?? 0,
        });
      }
    } else {
      // `import X` / `import X.Y as Z` → namespace use of the deepest module
      uses.push({
        fromSpec: imp.source,
        name: '*',
        kind: 'namespace',
        typeOnly: false,
        line: imp.line,
        pyIsFromImport: false,
        pyLevel: 0,
      });
    }
  }
  // v1.7.2: expose __all__ declaration (array of name strings, or null
  // when the module doesn't declare one). Consumers that care about
  // Python's explicit-public-API convention read this field; file
  // records without it (non-Python or Python without __all__) keep the
  // prior "everything top-level is implicitly public" semantics.
  return {
    filePath,
    defs,
    uses,
    reExports: [],
    loc: pyRec.loc ?? 0,
    ...(pyRec.dunder_all !== null && pyRec.dunder_all !== undefined
      ? { pyDunderAll: pyRec.dunder_all }
      : {}),
  };
}
