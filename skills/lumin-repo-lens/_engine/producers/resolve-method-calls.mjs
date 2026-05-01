// resolve-method-calls.mjs — Method call resolution via tsc compiler API (parameterized)
// Resolves `obj.method()` calls by using the TypeScript type checker to find
// where the method is defined. Filters out node_modules and external types.
//
// Usage: node resolve-method-calls.mjs --root <repo> [--output <dir>]

import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseCliArgs } from '../lib/cli.mjs';
import { detectRepoMode } from '../lib/repo-mode.mjs';
import { buildAliasMap } from '../lib/alias-map.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { relPath, buildSubmoduleResolver } from '../lib/paths.mjs';

const cli = parseCliArgs({
  'focus-class': { type: 'string' },
});
const { root: ROOT, output, verbose } = cli;
const focusClass = cli.raw['focus-class'];

const repoMode = detectRepoMode(ROOT);
const aliasMap = buildAliasMap(ROOT, repoMode);

// Build tsc paths from aliasMap entries (filter exact only for simplicity)
const tscPaths = {};
for (const [spec, entry] of aliasMap) {
  if (entry.type === 'exact') {
    tscPaths[spec] = [path.relative(ROOT, entry.path) || entry.path];
  } else if (entry.type === 'wildcard') {
    const pkgName = spec.split('/*')[0];
    // heuristic: map '@pkg' root to main, '@pkg/*' to pattern.
    // Use the stored targetPattern for path substitution; the suffix set
    // covers `.mjs/.cjs/.js` → `.ts` / `.jsx` → `.tsx` so a package whose
    // exports point at `./dist/*.mjs` still resolves back to `src/*.ts`
    // (FP-40 class — narrow `.js$` replacement previously missed these).
    const srcPattern = entry.targetPattern
      .replace(/^\.\//, '')
      .replace(/\.(mjs|cjs|js)$/, '.ts')
      .replace(/\.jsx$/, '.tsx');
    const pat = path.relative(ROOT, path.join(entry.pkgDir, srcPattern));
    tscPaths[`${pkgName}/*`] = [pat];
  }
}

const files = collectFiles(ROOT, { includeTests: cli.includeTests, exclude: cli.exclude });
console.error(`[level2] ${files.length} files`);

// ─── compiler options ───────────────────────────────────
// v0.6.1: inherit from tsconfig.json when present. The prior hardcoded
// options missed project-specific `types` / `typeRoots` / `lib` / `jsx` /
// `paths` — causing @types/node to never load, `process.argv` to fall to
// `any`, and 40%+ of method calls to report "no-property" (undefined
// propSymbol) when in fact tsc couldn't even build a type for `process`.
//
// Strategy: load user tsconfig → override the specific options we require
// (noEmit, skipLibCheck) → fall back to defaults if no tsconfig found.
const fallbackOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  strict: false,
  esModuleInterop: true,
  noEmit: true,
  jsx: ts.JsxEmit.Preserve,
  isolatedModules: false,
  baseUrl: ROOT,
  paths: tscPaths,
  resolveJsonModule: true,
  allowJs: true,
  checkJs: false,
};

// ─── environment diagnostics (v0.6.1) ───────────────────
// Many false "BLIND any-typed" results stem from missing dependencies.
// Detect early so the user knows before the 30s program build.
import { existsSync as _existsSync } from 'node:fs';
const nmExists = _existsSync(path.join(ROOT, 'node_modules'));
const atTypesExists = _existsSync(path.join(ROOT, 'node_modules', '@types'));
const nmNodeExists = _existsSync(path.join(ROOT, 'node_modules', '@types', 'node'));
if (!nmExists) {
  console.error('');
  console.error('  ⚠  node_modules/ not found at ROOT.');
  console.error('     Without installed dependencies, tsc cannot resolve external');
  console.error('     types. Expect `BLIND any-typed` to dominate the breakdown.');
  console.error('     Run `npm install` / `pnpm install` / `yarn install` first for');
  console.error('     a meaningful resolution rate.');
  console.error('');
} else if (!atTypesExists) {
  console.error('  ⚠  node_modules/@types/ not found — @types/* packages missing.');
} else if (!nmNodeExists) {
  console.error('  ⚠  @types/node not installed — Node builtins (process, fs, path) → any-typed.');
}

let compilerOptions = { ...fallbackOptions };
let tsconfigFileNames = [];
const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json');
if (configPath) {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (!configFile.error && configFile.config) {
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath)
    );
    if (parsed.errors && parsed.errors.length > 0 && verbose) {
      for (const e of parsed.errors.slice(0, 3)) {
        console.error(`[level2] tsconfig parse warning: ${e.messageText}`);
      }
    }
    // Merge: project options win for `lib`/`types`/`paths`/`jsx`/etc.,
    // but enforce our runtime-only settings.
    compilerOptions = {
      ...fallbackOptions,
      ...parsed.options,
      // Non-negotiable overrides for audit run:
      noEmit: true,
      skipLibCheck: true,
      // v1.3.0: ensure JS files get parsed even if tsconfig omits allowJs.
      // We collect .js / .mjs / .cjs alongside .ts — they must be part of
      // the program or `propSymbol.declarations` comes back empty.
      allowJs: true,
      checkJs: false,
      // Declaration emission / composite references break createProgram on
      // some monorepos — disable here; tsc still resolves types fine.
      declaration: false,
      composite: false,
      incremental: false,
      // Preserve user's moduleResolution when set; otherwise our default.
      moduleResolution: parsed.options.moduleResolution ?? fallbackOptions.moduleResolution,
    };
    tsconfigFileNames = parsed.fileNames ?? [];
    console.error(`[level2] tsconfig.json loaded from ${path.relative(ROOT, configPath) || configPath}`);
  } else if (configFile.error) {
    console.error(`[level2] tsconfig.json read error; falling back: ${configFile.error.messageText ?? 'unknown'}`);
  }
} else {
  console.error('[level2] no tsconfig.json found at root; using fallback compilerOptions');
}

// Merge scan files with tsconfig-declared files (union, dedup). This ensures
// tsc sees both our walked TS sources AND the .d.ts / types/ declaration
// files the project lists via `include` / `files`.
const programFiles = [...new Set([...files, ...tsconfigFileNames])];

console.error(`[level2] creating program (${programFiles.length} files, tsconfig ${configPath ? 'inherited' : 'fallback'}) ...`);
const t0 = Date.now();
const program = ts.createProgram(programFiles, compilerOptions);
const checker = program.getTypeChecker();
console.error(`[level2] program created in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ─── 각 source file 순회 ─────────────────────────────────
// v0.6.1: 5-bucket honesty reporting. The legacy "resolvedMethodCalls"
// counted ONLY internal targets — making external-heavy repos look like
// 97% blind when tsc had actually resolved them (correctly) to
// node_modules / lib.d.ts. Breakdown now tracks where each call went.
let totalMethodCalls = 0;
let resolvedInternal = 0;   // tsc resolved, declaration in-scan (counts as edge)
let resolvedNodeModules = 0; // tsc resolved, declaration in node_modules/
let resolvedLibDts = 0;      // tsc resolved, declaration in TypeScript lib.d.ts (Array/String/Promise…)
let resolvedOtherExt = 0;    // tsc resolved, but outside ROOT (monorepo siblings? global types?)
let anyTyped = 0;            // objType was `any` or undefined — no property lookup possible
let trulyUnresolved = 0;     // tsc attempted lookup but propSymbol = null / declarations empty
let crossFileMethodCalls = 0;
const methodCallEdges = new Map(); // "fromFile→toFile→ClassName.method" -> count
const methodCallsByTarget = new Map(); // "toFile::ClassName.method" -> count
const _unresolvedSamples = [];

const t1 = Date.now();

for (const f of files) {
  const sourceFile = program.getSourceFile(f);
  if (!sourceFile) continue;

  ts.forEachChild(sourceFile, function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      // obj.method(...) 형태
      totalMethodCalls++;
      const expr = node.expression;
      const propName = expr.name.text;
      const objExpr = expr.expression;

      // v0.6.1 5-bucket classification:
      //   anyTyped           → objType is `any` / undefined / has no properties
      //   trulyUnresolved    → objType present but propSymbol lookup fails
      //   resolvedLibDts     → declaration in tsc's lib.*.d.ts (Array/String/Promise…)
      //   resolvedNodeModules → declaration inside a node_modules path
      //   resolvedOtherExt   → declaration outside ROOT but not node_modules (monorepo sibling etc.)
      //   resolvedInternal   → declaration within ROOT and not node_modules → tracked as edge
      const objType = checker.getTypeAtLocation(objExpr);
      if (!objType) {
        anyTyped++;
        return ts.forEachChild(node, visit);
      }

      // Detect `any`-typed receivers (most common blind source)
      if (
        (objType.flags & ts.TypeFlags.Any) ||
        (objType.flags & ts.TypeFlags.Unknown)
      ) {
        anyTyped++;
        return ts.forEachChild(node, visit);
      }

      const propSymbol = checker.getPropertyOfType(objType, propName);
      if (!propSymbol) {
        trulyUnresolved++;
        return ts.forEachChild(node, visit);
      }

      const decls = propSymbol.declarations;
      if (!decls || decls.length === 0) {
        trulyUnresolved++;
        return ts.forEachChild(node, visit);
      }

      const decl = decls[0];
      const declFile = decl.getSourceFile().fileName;
      const declFileNorm = declFile.replace(/\\/g, '/');
      const rootNorm = ROOT.replace(/\\/g, '/');
      const isLibDts = /\/lib\.[^/]+\.d\.ts$/.test(declFileNorm);

      if (isLibDts) {
        resolvedLibDts++;
        return ts.forEachChild(node, visit);
      }
      if (declFileNorm.includes('/node_modules/')) {
        resolvedNodeModules++;
        return ts.forEachChild(node, visit);
      }
      // v1.3.0: guard prefix match with trailing slash so `/repo` does not
      // spuriously match `/repo-other/...`. Equality case (declFile is
      // exactly the root) stays accepted.
      const rootPrefix = rootNorm.endsWith('/') ? rootNorm : rootNorm + '/';
      if (declFileNorm !== rootNorm && !declFileNorm.startsWith(rootPrefix)) {
        resolvedOtherExt++;
        return ts.forEachChild(node, visit);
      }

      resolvedInternal++;

      // 정의 클래스/interface 이름 얻기
      let declOwner = '<top>';
      let cur = decl.parent;
      while (cur) {
        if (
          ts.isClassDeclaration(cur) ||
          ts.isInterfaceDeclaration(cur) ||
          ts.isTypeAliasDeclaration(cur)
        ) {
          declOwner = cur.name?.text ?? '<anon>';
          break;
        }
        if (ts.isModuleDeclaration(cur) || ts.isSourceFile(cur)) break;
        cur = cur.parent;
      }

      const edgeKey = `${f}→${declFile}→${declOwner}.${propName}`;
      methodCallEdges.set(edgeKey, (methodCallEdges.get(edgeKey) || 0) + 1);

      if (f !== declFile) {
        crossFileMethodCalls++;
      }

      const tgtKey = `${declFile}::${declOwner}.${propName}`;
      methodCallsByTarget.set(tgtKey, (methodCallsByTarget.get(tgtKey) || 0) + 1);
    }

    ts.forEachChild(node, visit);
  });
}

const t2 = Date.now();
console.log(`[visit] ${((t2 - t1) / 1000).toFixed(1)}s\n`);

// ─── 5-bucket honesty breakdown (v0.6.1) ────────────────
// Prior versions reported only "resolved" (== resolvedInternal) and left
// the rest uncounted as "blind" — misleading since tsc actually resolved
// most external calls correctly. The breakdown below distinguishes:
//   - true blind signals (anyTyped + trulyUnresolved)
//   - correctly resolved but filtered externals (lib.d.ts + node_modules + other-ext)
//   - the tracked internal edges (resolvedInternal)
const _resolvedExternal = resolvedLibDts + resolvedNodeModules + resolvedOtherExt;
const blindCount = anyTyped + trulyUnresolved;
const pct = (n) => totalMethodCalls > 0 ? ((n / totalMethodCalls) * 100).toFixed(1) : '0.0';

console.log(`[method call] total ${totalMethodCalls}`);
console.log(`  resolved-internal:      ${resolvedInternal.toString().padStart(5)} (${pct(resolvedInternal)}%)   ← tracked as edges`);
console.log(`  resolved-lib.d.ts:      ${resolvedLibDts.toString().padStart(5)} (${pct(resolvedLibDts)}%)   ← Array / String / Promise / etc.`);
console.log(`  resolved-node_modules:  ${resolvedNodeModules.toString().padStart(5)} (${pct(resolvedNodeModules)}%)   ← correctly resolved external`);
console.log(`  resolved-other-ext:     ${resolvedOtherExt.toString().padStart(5)} (${pct(resolvedOtherExt)}%)   ← outside ROOT (monorepo sibling?)`);
console.log(`  BLIND any-typed:        ${anyTyped.toString().padStart(5)} (${pct(anyTyped)}%)   ← objType = any (tsconfig / @types issue?)`);
console.log(`  BLIND unresolved:       ${trulyUnresolved.toString().padStart(5)} (${pct(trulyUnresolved)}%)   ← tsc could not locate property`);
console.log(`  ───────────────────────────────`);
console.log(`  true blind:             ${blindCount.toString().padStart(5)} (${pct(blindCount)}%)`);
console.log(`  effective rate (non-lib, non-external): ` +
  `${resolvedInternal}/${resolvedInternal + blindCount} = ` +
  `${resolvedInternal + blindCount > 0
    ? ((resolvedInternal / (resolvedInternal + blindCount)) * 100).toFixed(1)
    : '0.0'}% internal of internal-candidates`);
console.log(`  cross-file resolved:    ${crossFileMethodCalls}`);
if (anyTyped > totalMethodCalls * 0.15) {
  console.log(`  ⚠ any-typed share > 15% — likely tsconfig or @types missing; check compilerOptions inheritance`);
}

// ─── Top 25 method callees ───────────────────────────────
console.log(`\n════════ Top 25 method callees ════════`);
const topMethods = [...methodCallsByTarget.entries()]
  .map(([k, n]) => {
    const [file, sig] = k.split('::');
    return { file: relPath(ROOT, file), sig, count: n };
  })
  .sort((a, b) => b.count - a.count);
for (const m of topMethods.slice(0, 25)) {
  console.log(`  ${m.count.toString().padStart(4)}  ${m.sig.padEnd(48)}  ${m.file}`);
}

// ─── 통합: Level 1 + Level 2 Top callees ────────────────
// v0.6.1: load call-graph.json from the same output dir (not hardcoded
// absolute path from original Geulbat environment). Optional — if absent,
// combined top-callees section is skipped.
const level1Path = path.join(output, 'call-graph.json');
const level1Top = new Map();
try {
  const level1 = JSON.parse(readFileSync(level1Path, 'utf8'));
  for (const c of (level1.topCallees ?? [])) {
    level1Top.set(`${c.file}::${c.name}`, c.count);
  }
} catch {
  if (verbose) console.error(`[level2] call-graph.json not found at ${level1Path} — combined top skipped`);
}

// 통합 top: Level 1 function call + Level 2 method call
const combined = new Map();
for (const [k, n] of level1Top) combined.set(k, { count: n, kind: 'function' });
for (const m of topMethods) {
  const k = `${m.file}::${m.sig}`;
  combined.set(k, { count: m.count, kind: 'method' });
}

const combinedSorted = [...combined.entries()]
  .map(([k, v]) => {
    const [file, sig] = k.split('::');
    return { file, sig, count: v.count, kind: v.kind };
  })
  .sort((a, b) => b.count - a.count);

console.log(`\n════════ 통합 Top 30 (function + method) ════════`);
for (const c of combinedSorted.slice(0, 30)) {
  console.log(
    `  ${c.count.toString().padStart(4)}  [${c.kind.padEnd(8)}]  ${c.sig.padEnd(42)}  ${c.file}`,
  );
}

// ─── 특정 클래스의 메서드 사용 분포 (opt-in) ─────────────
// v0.6.8 fix: previously hardcoded to `RunChannelClient` (an artifact of
// one specific audit target). Now gated on `--focus-class <name>` — no
// output at all unless the caller explicitly requests a class drilldown.
// v1.3.0: compute once so the structured JSON artifact can expose it too.
const focusMethods = focusClass
  ? topMethods.filter((m) => m.sig.startsWith(`${focusClass}.`))
  : [];
if (focusClass) {
  console.log(`\n════════ ${focusClass} method 사용 실태 ════════`);
  for (const m of focusMethods) {
    console.log(`  ${m.count.toString().padStart(3)}  ${m.sig}  ${m.file}`);
  }
  console.log(
    `  총 ${focusMethods.length}개 method, 총 호출 ${focusMethods.reduce((a, m) => a + m.count, 0)}회`,
  );
}

// ─── 통합 cross-submodule method edge ──────────────────────
const submoduleOf = buildSubmoduleResolver(ROOT, repoMode);

const crossPkgMethod = new Map();
for (const [k, n] of methodCallEdges) {
  const [from, to] = k.split('→');
  const fp = submoduleOf(from);
  const tp = submoduleOf(to);
  if (fp === tp) continue;
  const key = `${fp} → ${tp}`;
  crossPkgMethod.set(key, (crossPkgMethod.get(key) || 0) + n);
}
console.log(`\n════════ Cross-submodule method call (Level 2) ════════`);
for (const [k, n] of [...crossPkgMethod.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${n.toString().padStart(4)}  ${k}`);
}

// ─── 저장 ────────────────────────────────────────────────
const outPath = path.join(output, 'level2-methods.json');
writeFileSync(outPath, JSON.stringify({
  meta: {
    generated: new Date().toISOString(),
    root: ROOT,
    tool: 'resolve-method-calls.mjs',
    tsconfigInherited: !!configPath,
    tsconfigPath: configPath ?? null,
    // Environment preconditions — explains high any-typed rates.
    envDiagnostic: {
      nodeModulesInstalled: nmExists,
      atTypesInstalled: atTypesExists,
      atTypesNodeInstalled: nmNodeExists,
      // Epistemic note for downstream reporters: anyTyped dominant combined
      // with nodeModulesInstalled=false means the L2 "blind" reading is
      // an artifact of missing deps, not of tsc capability. Re-run after
      // `pnpm install` for a grounded verdict.
      epistemicNote: !nmExists
        ? 'L2 resolution unreliable until node_modules is installed — anyTyped rate reflects missing deps, not code quality'
        : (!nmNodeExists
          ? 'Node builtins resolve as any — install @types/node for accurate classification'
          : 'environment ok'),
    },
  },
  totalMethodCalls,
  // v0.6.1: full breakdown. The legacy `resolvedMethodCalls` is kept as an
  // alias for `resolvedInternal` for backward compat; it equals the tracked
  // edge count. True blind rate is `blind.total / totalMethodCalls`.
  resolvedMethodCalls: resolvedInternal,
  resolutionRate: totalMethodCalls > 0
    ? ((resolvedInternal / totalMethodCalls) * 100).toFixed(1) + '%'
    : 'n/a',
  breakdown: {
    resolvedInternal,
    resolvedLibDts,
    resolvedNodeModules,
    resolvedOtherExt,
    anyTyped,
    trulyUnresolved,
    blind: { total: anyTyped + trulyUnresolved, anyTyped, trulyUnresolved },
    effectiveInternalRate: (resolvedInternal + anyTyped + trulyUnresolved) > 0
      ? +(resolvedInternal / (resolvedInternal + anyTyped + trulyUnresolved)).toFixed(3)
      : null,
  },
  crossFileMethodCalls,
  uniqueEdges: methodCallEdges.size,
  topMethods: topMethods.slice(0, 100),
  crossSubmoduleMethod: Object.fromEntries(crossPkgMethod),
  focusClassReport: focusClass
    ? {
        className: focusClass,
        methods: focusMethods,
        totalCalls: focusMethods.reduce((a, m) => a + m.count, 0),
      }
    : null,
}, null, 2));
console.log(`[level2] tracked-internal edges: ${resolvedInternal}/${totalMethodCalls} (${totalMethodCalls > 0 ? ((resolvedInternal / totalMethodCalls) * 100).toFixed(1) : 0}%)`);
console.log(`[level2] true-blind rate: ${totalMethodCalls > 0 ? ((anyTyped + trulyUnresolved) / totalMethodCalls * 100).toFixed(1) : 0}%`);
console.log(`[level2] saved → ${outPath}`);
