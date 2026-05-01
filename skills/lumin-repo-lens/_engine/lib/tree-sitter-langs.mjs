// _lib/tree-sitter-langs.mjs — WASM-based multi-language L1 extractor.
//
// Wraps `web-tree-sitter` + `@vscode/tree-sitter-wasm` to provide AST extraction
// for languages that don't ship a first-party Node parser. Zero toolchain —
// WASM grammars are bundled in the tree-sitter-wasm npm package (Go, Rust,
// Java, Python, Ruby, PHP, C#, C++, Bash, CSS, and more).
//
// Public surface:
//   isTreeSitterAvailable()           → Promise<boolean>
//   extractTreeSitterBatch(files)     → Promise<Map<abs, {imports,defs,uses,loc,error?}>>
//
// Files are routed to language extractors by extension. Only registered
// languages are parsed; others are ignored (caller handles via its own branch).
//
// Resolvers (per-language, sync):
//   resolveGoImport(root, modulePath, spec) → abs[]
//   findGoModule(startDir)                   → {dir, moduleName} | null

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// ─── module paths to bundled WASM files ─────────────────
// Resolve through Node's package resolver rather than assuming a fixed
// repo layout. The maintainer checkout keeps this file in `_lib/`, while
// the generated skill package moves it to `_engine/lib/`.
const require = createRequire(import.meta.url);
const TREE_SITTER_WASM_ROOT = path.dirname(
  require.resolve('@vscode/tree-sitter-wasm/package.json'),
);
const WEB_TREE_SITTER_ROOT = path.dirname(require.resolve('web-tree-sitter'));
const WASM_DIR = path.join(TREE_SITTER_WASM_ROOT, 'wasm');
const RUNTIME_WASM = path.join(WEB_TREE_SITTER_ROOT, 'web-tree-sitter.wasm');

// Registered languages: extension → wasm grammar name
const REGISTRY = {
  '.go': 'go',
  // Extend here — add mapping + extractor below.
  // '.rs': 'rust',
  // '.java': 'java',
};

// ─── lazy tree-sitter init ──────────────────────────────
let _initPromise = null;
let _initialized = false;
let _Parser = null;
let _Language = null;
let _Query = null;
const _langCache = new Map();

async function init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    if (!existsSync(RUNTIME_WASM) || !existsSync(WASM_DIR)) return false;
    try {
      const mod = await import('web-tree-sitter');
      _Parser = mod.Parser;
      _Language = mod.Language;
      _Query = mod.Query;
      await _Parser.init({
        locateFile(f) {
          if (f === 'web-tree-sitter.wasm') return RUNTIME_WASM;
          return f;
        },
      });
      _initialized = true;
      return true;
    } catch {
      return false;
    }
  })();
  return _initPromise;
}

export async function isTreeSitterAvailable() {
  return await init();
}

async function loadLang(name) {
  if (_langCache.has(name)) return _langCache.get(name);
  const wasmPath = path.join(WASM_DIR, `tree-sitter-${name}.wasm`);
  if (!existsSync(wasmPath)) {
    _langCache.set(name, null);
    return null;
  }
  try {
    const lang = await _Language.load(wasmPath);
    _langCache.set(name, lang);
    return lang;
  } catch {
    _langCache.set(name, null);
    return null;
  }
}

// ─── per-language extractors ────────────────────────────
// Each returns { imports: [{source, line, name?}], defs: [{name, kind, line}], uses: [{fromSpec, name, line}] }

function extractGo({ tree, lang, src }) {
  const query = new _Query(
    lang,
    `
    (import_spec path: (interpreted_string_literal) @path (#set! name "src"))
    (import_spec name: (package_identifier) @alias path: (interpreted_string_literal) @path-aliased)
    (function_declaration name: (identifier) @fn)
    (method_declaration name: (field_identifier) @method)
    (type_declaration (type_spec name: (type_identifier) @type))
    (const_declaration (const_spec name: (identifier) @const))
    (var_declaration (var_spec name: (identifier) @var))
    (selector_expression operand: (identifier) @sel-ns field: (field_identifier) @sel-name)
    `
  );
  const captures = query.captures(tree.rootNode);

  const imports = [];
  const defs = [];
  const uses = [];
  const _aliasForNextPath = new Map(); // line → alias (reserved, future use)
  let pendingAlias = null;

  for (const c of captures) {
    const line = c.node.startPosition.row + 1;
    const text = c.node.text;

    if (c.name === 'alias') {
      pendingAlias = text;
    } else if (c.name === 'path-aliased') {
      const src = text.slice(1, -1);
      imports.push({ source: src, name: pendingAlias, line });
      pendingAlias = null;
    } else if (c.name === 'path') {
      const src = text.slice(1, -1);
      imports.push({ source: src, line });
    } else if (c.name === 'fn' || c.name === 'method') {
      defs.push({ name: text, kind: c.name === 'method' ? 'method' : 'func', line });
    } else if (c.name === 'type') {
      defs.push({ name: text, kind: 'type', line });
    } else if (c.name === 'const') {
      defs.push({ name: text, kind: 'const', line });
    } else if (c.name === 'var') {
      defs.push({ name: text, kind: 'var', line });
    } else if (c.name === 'sel-ns') {
      // This is the left side of `pkg.Name` — paired with next sel-name
      // Store temporarily; emit use when we see sel-name at same site.
      // tree-sitter emits captures in order; sel-ns and sel-name come paired.
      uses.push({ _nsName: text, line });
    } else if (c.name === 'sel-name') {
      const last = uses[uses.length - 1];
      if (last && last._nsName && last.line === line) {
        last.name = text;
        last.nsName = last._nsName;
        delete last._nsName;
      }
    }
  }
  // Clean up any unresolved sel-ns captures (no name paired).
  for (let i = uses.length - 1; i >= 0; i--) {
    if (uses[i]._nsName && !uses[i].name) uses.splice(i, 1);
  }

  return { imports, defs, uses, loc: src.split('\n').length };
}

const EXTRACTORS = {
  go: extractGo,
};

// ─── batch entry point ──────────────────────────────────
export async function extractTreeSitterBatch(files) {
  if (!files || files.length === 0) return new Map();
  if (!(await init())) return null;

  // Partition files by language.
  const byLang = new Map();
  for (const f of files) {
    const ext = path.extname(f);
    const langName = REGISTRY[ext];
    if (!langName) continue;
    if (!byLang.has(langName)) byLang.set(langName, []);
    byLang.get(langName).push(f);
  }

  const results = new Map();
  for (const [langName, langFiles] of byLang) {
    const lang = await loadLang(langName);
    if (!lang) continue;
    const extractor = EXTRACTORS[langName];
    if (!extractor) continue;

    const parser = new _Parser();
    parser.setLanguage(lang);

    for (const f of langFiles) {
      try {
        const src = readFileSync(f, 'utf8');
        const tree = parser.parse(src);
        if (!tree) {
          results.set(f, { error: 'parse returned null' });
          continue;
        }
        const out = extractor({ tree, lang, src });
        results.set(f, out);
      } catch (e) {
        results.set(f, { error: e.message });
      }
    }
  }
  return results;
}

// ─── Go module / import resolver ────────────────────────
export function findGoModule(startDir) {
  let dir = startDir;
  while (true) {
    const goModPath = path.join(dir, 'go.mod');
    if (existsSync(goModPath)) {
      try {
        const content = readFileSync(goModPath, 'utf8');
        const m = content.match(/^module\s+(\S+)/m);
        if (m) return { dir, moduleName: m[1] };
      } catch {
        // existsSync said the file was there but readFileSync failed —
        // most likely a race with another tool rewriting go.mod, or an
        // unreadable file (permissions). Fall through to the parent dir.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Given an import path like "example.com/mymod/pkg/sub", return the list of
// non-test .go files in that directory (Go packages are directory-level).
export function resolveGoImport(rootDir, moduleInfo, importPath) {
  if (!moduleInfo) return [];
  const { moduleName, dir: moduleDir } = moduleInfo;
  if (!importPath.startsWith(moduleName)) return []; // external / stdlib
  const rel = importPath === moduleName ? '' : importPath.slice(moduleName.length + 1);
  const pkgDir = rel ? path.join(moduleDir, rel) : moduleDir;
  if (!existsSync(pkgDir)) return [];
  let entries;
  try {
    entries = readdirSync(pkgDir);
  } catch {
    return [];
  }
  const hits = [];
  for (const entry of entries) {
    if (!entry.endsWith('.go')) continue;
    if (entry.endsWith('_test.go')) continue;
    hits.push(path.join(pkgDir, entry));
  }
  return hits;
}
