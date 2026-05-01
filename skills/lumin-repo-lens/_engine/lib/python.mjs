// _lib/python.mjs — Python AST extraction + import resolver.
//
// Shells out to python3 once (batch mode, JSONL over stdin) and returns a
// Map<absPath, { imports, defs, loc, error? }> shaped identically to the
// oxc-parser output where applicable. Requires Python ≥ 3.8 (for `ast.parse`
// stability). Gracefully reports unavailable when python3/python is missing.
//
// Resolver understands:
//   import foo.bar
//   import foo.bar as baz
//   from foo.bar import baz
//   from . import baz     (relative, level=1)
//   from ..foo import baz (relative, level=2)
// and attempts to resolve to absolute .py / __init__.py paths under <root>.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ─── python3 resolution (cached) ────────────────────────
let _pythonCmd = undefined;
export function isPythonAvailable() {
  if (_pythonCmd !== undefined) return _pythonCmd !== null;
  for (const cmd of ['python3', 'python']) {
    try {
      const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
      const out = (r.stdout || '') + (r.stderr || '');
      if (r.status === 0 && /Python 3\./.test(out)) {
        _pythonCmd = cmd;
        return true;
      }
    } catch {
      // spawnSync itself threw — typically ENOENT (python not installed).
      // This is the main non-exception path we probe for; continuing to
      // the next cmd is the intended behavior.
    }
  }
  _pythonCmd = null;
  return false;
}

// ─── extractor script (written once per process) ────────
const EXTRACTOR_PY = `
import ast, json, sys

def emit(path, payload):
    payload['path'] = path
    sys.stdout.write(json.dumps(payload) + '\\n')

for raw in sys.stdin:
    p = raw.strip()
    if not p:
        continue
    try:
        src = open(p, 'r', encoding='utf-8').read()
    except Exception as e:
        emit(p, {'error': 'read: ' + str(e)})
        continue
    loc = src.count('\\n') + 1
    try:
        tree = ast.parse(src, filename=p)
    except SyntaxError as e:
        emit(p, {'error': 'syntax: ' + str(e), 'loc': loc})
        continue

    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append({
                    'source': alias.name,
                    'imported': [alias.asname or alias.name.split('.')[0]],
                    'isFromImport': False,
                    'level': 0,
                    'line': node.lineno,
                })
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ''
            names = [a.asname or a.name for a in node.names]
            imports.append({
                'source': mod,
                'imported': names,
                'isFromImport': True,
                'level': node.level or 0,
                'line': node.lineno,
            })

    defs = []
    dunder_all = None  # If module declares __all__ = [...], record the list;
                       # None means "no declaration" (everything top-level is
                       # implicitly public under PEP 8 convention).
    # v1.7.2: Python dunder names are never user-facing exports. They're
    # invoked by the runtime itself on attribute access / iteration /
    # context-manager protocols / etc. A module-level __getattr__ is a
    # lazy-loading hook; __dir__ customizes dir(); these are protocol
    # methods, not imports. Skip them from the def list so they don't
    # enter the dead-export graph.
    DUNDER_SKIP = {
        '__getattr__', '__setattr__', '__delattr__', '__dir__',
        '__init_subclass__', '__class_getitem__',
        '__init__', '__new__', '__del__',
        '__enter__', '__exit__', '__aenter__', '__aexit__',
        '__call__', '__repr__', '__str__', '__bytes__', '__format__',
        '__hash__', '__bool__', '__len__', '__length_hint__',
        '__iter__', '__next__', '__reversed__', '__contains__',
        '__eq__', '__ne__', '__lt__', '__le__', '__gt__', '__ge__',
        '__add__', '__sub__', '__mul__', '__truediv__', '__floordiv__',
        '__mod__', '__pow__', '__and__', '__or__', '__xor__',
        '__getitem__', '__setitem__', '__delitem__',
        '__await__', '__aiter__', '__anext__',
    }
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name in DUNDER_SKIP:
                continue
            # v1.7.2: detect decorator patterns that register the function
            # with an external dispatcher (Typer / Click / Flask route /
            # FastAPI route / Celery task / pytest fixtures for CLI etc.).
            # These functions look "dead" to cross-file import analysis
            # because the framework invokes them by decorator side effect,
            # not by JS-style import + call.
            is_registered = False
            for dec in node.decorator_list:
                d = dec.func if isinstance(dec, ast.Call) else dec
                # Handle Attribute (app.command) or Name (command)
                if isinstance(d, ast.Attribute):
                    if d.attr in ('command', 'callback', 'route', 'get', 'post',
                                   'put', 'delete', 'patch', 'websocket',
                                   'task', 'fixture', 'step'):
                        is_registered = True
                        break
                elif isinstance(d, ast.Name):
                    if d.id in ('command', 'task', 'fixture'):
                        is_registered = True
                        break
            entry = {'name': node.name, 'kind': 'FunctionDef', 'line': node.lineno}
            if is_registered:
                entry['frameworkRegistered'] = True
            defs.append(entry)
        elif isinstance(node, ast.ClassDef):
            defs.append({'name': node.name, 'kind': 'ClassDef', 'line': node.lineno})
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    # v1.7.2: if this is __all__ = [...], parse the list and
                    # record it -- don't treat __all__ itself as a candidate
                    # symbol. (It's Python's native export declaration, not
                    # user code.)
                    if t.id == '__all__':
                        if isinstance(node.value, (ast.List, ast.Tuple, ast.Set)):
                            try:
                                dunder_all = [
                                    e.value for e in node.value.elts
                                    if isinstance(e, ast.Constant) and isinstance(e.value, str)
                                ]
                            except Exception:
                                dunder_all = []
                        continue  # don't add __all__ as a def
                    defs.append({'name': t.id, 'kind': 'Assign', 'line': node.lineno})
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.target.id == '__all__':
                continue
            defs.append({'name': node.target.id, 'kind': 'AnnAssign', 'line': node.lineno})

    emit(p, {'imports': imports, 'defs': defs, 'loc': loc, 'dunder_all': dunder_all})
`;

let _extractorPath = null;
function ensureExtractor() {
  if (_extractorPath && existsSync(_extractorPath)) return _extractorPath;
  const dir = path.join(tmpdir(), 'lumin-repo-lens');
  mkdirSync(dir, { recursive: true });
  _extractorPath = path.join(dir, 'python-extractor.py');
  writeFileSync(_extractorPath, EXTRACTOR_PY);
  return _extractorPath;
}

// ─── batch extraction ───────────────────────────────────
// Input:  array of absolute .py paths
// Output: Map<absPath, { imports, defs, loc, error? }>
export function extractPythonBatch(files) {
  if (!isPythonAvailable()) return null;
  if (!files || files.length === 0) return new Map();

  const script = ensureExtractor();
  const input = files.join('\n') + '\n';
  const r = spawnSync(_pythonCmd, [script], {
    input,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 256,
  });

  if (r.status !== 0) {
    const err = (r.stderr || '').trim();
    throw new Error(`python extractor failed: ${err || 'unknown'}`);
  }

  const results = new Map();
  let parseFailures = 0;
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.path) results.set(obj.path, obj);
    } catch {
      // NDJSON stream may have stray non-JSON lines if the extractor
      // wrote diagnostics to stdout on a syntax error in one file
      // (unlikely — errors should go to stderr — but cheap to tolerate).
      // We track the count so callers can surface it as a warning
      // rather than silently losing data.
      parseFailures++;
    }
  }
  if (parseFailures > 0) {
    results.set('__meta__', { parseFailures });
  }
  return results;
}

// ─── import resolver ─────────────────────────────────────
// For `from X.Y import a, b` the resolver attempts, in order:
//   - root/X/Y/a.py or root/X/Y/a/__init__.py  (each name as a submodule)
//   - root/X/Y.py or root/X/Y/__init__.py       (the base module)
// For `import X.Y.Z` it walks parts from deepest to shallowest and returns
// the first resolvable file.
// Relative imports (`level ≥ 1`) walk up from fromFile's directory.
// Returns an array of absolute paths (may be empty → external or unresolved).
//
// v1.7.2 self-reference fix: a common Python layout is `--root` pointing
// directly at the package dir (e.g. `/src/ouroboros/`) while imports use
// the fully-qualified form `ouroboros.agents.loader` (because the user
// runs with PYTHONPATH one level up). The old resolver treated the
// leading `ouroboros.` as a subdirectory, probed `ouroboros/ouroboros/
// agents/loader.py`, and falsely flagged `load_agent_prompt` as dead.
// Strip the leading package segment when `parts[0] === basename(root)`
// before the main probe — mirror of the TS FP-16 self-reference branch.
export function resolvePythonImport(root, fromFile, spec, isFromImport, names, level) {
  let searchRoot;
  if (level > 0) {
    searchRoot = path.dirname(fromFile);
    for (let i = 1; i < level; i++) searchRoot = path.dirname(searchRoot);
  } else {
    searchRoot = root;
  }
  const parts = (spec || '').split('.').filter(Boolean);

  // Self-reference normalization (only for absolute imports, level === 0).
  // If the spec starts with the root package name, try once with the
  // leading segment stripped. We'll probe both interpretations below and
  // keep whichever one resolves.
  const rootBasename = path.basename(root);
  const selfRefCandidate =
    level === 0 && parts.length > 0 && parts[0] === rootBasename
      ? parts.slice(1)
      : null;

  const hits = [];
  const seen = new Set();
  const tryPush = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    if (existsSync(p)) hits.push(p);
  };

  const probe = (partsArr) => {
    const basePath = partsArr.length > 0 ? path.join(searchRoot, ...partsArr) : searchRoot;
    if (isFromImport) {
      for (const name of names) {
        tryPush(path.join(basePath, name + '.py'));
        tryPush(path.join(basePath, name, '__init__.py'));
      }
      tryPush(basePath + '.py');
      tryPush(path.join(basePath, '__init__.py'));
    } else {
      // `import X.Y.Z` — deepest resolvable wins; stop on first hit.
      for (let i = partsArr.length; i >= 1; i--) {
        const p = path.join(searchRoot, ...partsArr.slice(0, i));
        if (existsSync(p + '.py')) { hits.push(p + '.py'); return; }
        if (existsSync(path.join(p, '__init__.py'))) { hits.push(path.join(p, '__init__.py')); return; }
      }
    }
  };

  probe(parts);
  if (hits.length === 0 && selfRefCandidate) probe(selfRefCandidate);

  return hits;
}
