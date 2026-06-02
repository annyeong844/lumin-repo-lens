import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";
import { collectFiles } from "./collect-files.mjs";
import { JS_FAMILY_LANGS, SFC_FAMILY_LANGS } from "./lang.mjs";

function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

function attrsHaveSrc(attrs) {
  return srcAttrValue(attrs) !== null;
}

function srcAttrValue(attrs) {
  const match = `${attrs ?? ""}`.match(
    /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i,
  );
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function isRelativeSourceSpec(spec) {
  return (
    typeof spec === "string" &&
    (spec.startsWith("./") || spec.startsWith("../"))
  );
}

function parserLangFromAttrs(attrs) {
  const match = `${attrs ?? ""}`.match(
    /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i,
  );
  const raw = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").toLowerCase();
  if (raw === "tsx") return "tsx";
  if (raw === "jsx") return "jsx";
  if (raw === "js" || raw === "javascript") return "js";
  return "ts";
}

function parserLangFromFile(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === "tsx") return "tsx";
  if (ext === "jsx") return "jsx";
  if (ext === "js" || ext === "mjs" || ext === "cjs") return "js";
  return "ts";
}

function sfcLanguageForFile(filePath) {
  return path.extname(filePath).replace(/^\./, "").toLowerCase();
}

function stripHtmlComments(src) {
  return `${src ?? ""}`.replace(/<!--[\s\S]*?-->/g, (match) =>
    " ".repeat(match.length),
  );
}

function stripSvelteNonTemplateBlocks(src) {
  return `${src ?? ""}`.replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (match) => " ".repeat(match.length),
  );
}

function extractScriptBlocks(src, filePath) {
  const lang = sfcLanguageForFile(filePath);
  if (lang === "astro") return extractAstroFrontmatter(src);
  if (lang !== "vue" && lang !== "svelte") return [];

  const blocks = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(src))) {
    const attrs = match[1] ?? "";
    if (attrsHaveSrc(attrs)) continue;
    const contentStart = match.index + match[0].indexOf(match[2]);
    blocks.push({
      content: match[2],
      startOffset: contentStart,
      kind:
        lang === "vue" && /\bsetup\b/i.test(attrs)
          ? "vue-script-setup"
          : `${lang}-script`,
      parserLang: parserLangFromAttrs(attrs),
    });
  }
  return blocks;
}

function extractTemplateBlocks(src, filePath) {
  const lang = sfcLanguageForFile(filePath);
  if (lang === "astro") {
    const frontmatter = extractAstroFrontmatter(src)[0];
    const startOffset = frontmatter
      ? frontmatter.startOffset + frontmatter.content.length + 4
      : 0;
    return [
      {
        content: src.slice(startOffset),
        startOffset,
        kind: "astro-template",
        sfcLanguage: "astro",
      },
    ];
  }
  if (lang === "vue") {
    const blocks = [];
    const templateRe = /<template\b([^>]*)>([\s\S]*?)<\/template>/gi;
    let match;
    while ((match = templateRe.exec(src))) {
      const contentStart = match.index + match[0].indexOf(match[2]);
      blocks.push({
        content: match[2],
        startOffset: contentStart,
        kind: "vue-template",
        sfcLanguage: "vue",
      });
    }
    return blocks;
  }
  if (lang === "svelte") {
    return [
      {
        content: stripSvelteNonTemplateBlocks(src),
        startOffset: 0,
        kind: "svelte-template",
        sfcLanguage: "svelte",
      },
    ];
  }
  return [];
}

function extractScriptSrcBlocks(src, filePath) {
  const lang = sfcLanguageForFile(filePath);
  if (lang !== "vue" && lang !== "svelte") return [];

  const blocks = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(src))) {
    const attrs = match[1] ?? "";
    const fromSpec = srcAttrValue(attrs);
    if (!isRelativeSourceSpec(fromSpec)) continue;
    blocks.push({
      consumerFile: filePath,
      fromSpec,
      name: "*",
      kind: "sfc-script-src",
      typeOnly: false,
      line: lineOf(src, match.index),
      sfcBlockKind: `${lang}-script-src`,
      sfcLanguage: lang,
    });
  }
  return blocks;
}

function extractStyleBlocks(src, filePath) {
  const lang = sfcLanguageForFile(filePath);
  if (lang !== "vue" && lang !== "svelte" && lang !== "astro") return [];

  const blocks = [];
  const styleRe = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  let match;
  while ((match = styleRe.exec(src))) {
    const contentStart = match.index + match[0].indexOf(match[2]);
    blocks.push({
      content: match[2],
      startOffset: contentStart,
      kind: `${lang}-style`,
      sfcLanguage: lang,
    });
  }
  return blocks;
}

function extractAstroFrontmatter(src) {
  const open = src.match(/^---\r?\n/);
  if (!open) return [];

  const closeRe = /^---\s*$/gm;
  closeRe.lastIndex = open[0].length;
  const close = closeRe.exec(src);
  if (!close) return [];

  return [
    {
      content: src.slice(open[0].length, close.index),
      startOffset: open[0].length,
      kind: "astro-frontmatter",
      parserLang: "ts",
    },
  ];
}

function parseScriptAst(script, filePath, parserLang) {
  const candidates = [parserLang || "ts"];
  if (parserLang === "ts") candidates.push("tsx");
  if (parserLang === "js") candidates.push("jsx");
  if (!candidates.includes("ts")) candidates.push("ts");

  for (const lang of candidates) {
    if (!["ts", "tsx", "js", "jsx"].includes(lang)) continue;
    try {
      const result = parseSync(filePath, script, {
        sourceType: "module",
        lang,
      });
      if (!Array.isArray(result.errors) || result.errors.length === 0) {
        return result.program;
      }
    } catch {
      // Try the next compatible dialect before giving up on the script block.
    }
  }

  return null;
}

function isCssIdentChar(ch) {
  return /[A-Za-z0-9_-]/.test(ch);
}

function skipCssWhitespace(src, index) {
  let i = index;
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

function skipCssString(src, index) {
  const quote = src[index];
  let i = index + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

function parseCssEscapeValue(src, index) {
  if (src[index] !== "\\") return null;
  let i = index + 1;
  if (i >= src.length) return { value: "", end: i };

  if (src[i] === "\r" && src[i + 1] === "\n") return { value: "", end: i + 2 };
  if (src[i] === "\n" || src[i] === "\r" || src[i] === "\f")
    return { value: "", end: i + 1 };

  if (/[0-9A-Fa-f]/.test(src[i])) {
    let hex = "";
    while (i < src.length && hex.length < 6 && /[0-9A-Fa-f]/.test(src[i])) {
      hex += src[i];
      i++;
    }
    if (/\s/.test(src[i] ?? "")) i++;
    const codePoint = Number.parseInt(hex, 16);
    const validCodePoint =
      Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff;
    return {
      value: validCodePoint ? String.fromCodePoint(codePoint) : "\uFFFD",
      end: i,
    };
  }

  return { value: src[i], end: i + 1 };
}

function parseCssQuotedValue(src, index) {
  const quote = src[index];
  let i = index + 1;
  let value = "";
  while (i < src.length) {
    if (src[i] === "\\") {
      const escaped = parseCssEscapeValue(src, i);
      value += escaped?.value ?? "";
      i = escaped?.end ?? i + 1;
      continue;
    }
    if (src[i] === quote) return { value, end: i + 1 };
    value += src[i];
    i++;
  }
  return null;
}

function parseCssUrlFunction(src, index) {
  let i = index + 3;
  if (isCssIdentChar(src[index - 1] ?? "") || isCssIdentChar(src[i] ?? ""))
    return null;
  i = skipCssWhitespace(src, i);
  if (src[i] !== "(") return null;
  i = skipCssWhitespace(src, i + 1);

  let value = "";
  if (src[i] === '"' || src[i] === "'") {
    const parsed = parseCssQuotedValue(src, i);
    if (!parsed) return null;
    value = parsed.value;
    i = skipCssWhitespace(src, parsed.end);
    if (src[i] !== ")") return null;
    return { value: value.trim(), end: i + 1 };
  }

  while (i < src.length && src[i] !== ")") {
    if (src[i] === "\\") {
      const escaped = parseCssEscapeValue(src, i);
      value += escaped?.value ?? "";
      i = escaped?.end ?? i + 1;
      continue;
    }
    value += src[i];
    i++;
  }
  if (src[i] !== ")") return null;
  return { value: value.trim(), end: i + 1 };
}

function parseCssImportValue(src, index) {
  let i = index + "@import".length;
  if (isCssIdentChar(src[i] ?? "")) return null;
  i = skipCssWhitespace(src, i);

  if (src.slice(i, i + 3).toLowerCase() === "url") {
    const parsed = parseCssUrlFunction(src, i);
    return parsed ? { ...parsed, importSyntax: "url" } : null;
  }

  if (src[i] === '"' || src[i] === "'") {
    const parsed = parseCssQuotedValue(src, i);
    return parsed
      ? { ...parsed, value: parsed.value.trim(), importSyntax: "string" }
      : null;
  }

  return null;
}

function parseStyleAssetReferences(
  style,
  { filePath, fileSource, startOffset, blockKind, sfcLanguage },
) {
  const out = [];
  let i = 0;
  while (i < style.length) {
    if (style[i] === "/" && style[i + 1] === "*") {
      const end = style.indexOf("*/", i + 2);
      i = end >= 0 ? end + 2 : style.length;
      continue;
    }

    if (style[i] === '"' || style[i] === "'") {
      i = skipCssString(style, i);
      continue;
    }

    if (
      style[i] === "@" &&
      style.slice(i, i + "@import".length).toLowerCase() === "@import"
    ) {
      const parsed = parseCssImportValue(style, i);
      if (parsed) {
        if (isRelativeSourceSpec(parsed.value)) {
          out.push({
            consumerFile: filePath,
            fromSpec: parsed.value,
            kind: "sfc-style-import",
            source: "sfc-style-import",
            styleKind: "import",
            importSyntax: parsed.importSyntax,
            confidence: "grounded-asset-reference",
            line: lineOf(fileSource, startOffset + i),
            sfcBlockKind: blockKind,
            sfcLanguage,
          });
        }
        i = parsed.end;
        continue;
      }
    }

    if (style.slice(i, i + 3).toLowerCase() === "url") {
      const parsed = parseCssUrlFunction(style, i);
      if (parsed) {
        if (isRelativeSourceSpec(parsed.value)) {
          out.push({
            consumerFile: filePath,
            fromSpec: parsed.value,
            kind: "sfc-style-url",
            source: "sfc-style-url",
            styleKind: "url",
            confidence: "grounded-asset-reference",
            line: lineOf(fileSource, startOffset + i),
            sfcBlockKind: blockKind,
            sfcLanguage,
          });
        }
        i = parsed.end;
        continue;
      }
    }

    i++;
  }
  return out;
}

function importedName(specifier) {
  return specifier?.imported?.name ?? specifier?.imported?.value ?? null;
}

function astPropertyName(node) {
  const key = node?.key ?? node;
  if (!key) return null;
  if (typeof key.name === "string") return key.name;
  if (typeof key.value === "string") return key.value;
  return null;
}

function computedPropertySource(node, src) {
  const key = node?.key;
  if (!node?.computed || !key) return null;
  if (!Number.isFinite(key.start) || !Number.isFinite(key.end)) return null;
  return src.slice(key.start, key.end).trim() || null;
}

function parseScriptImportConsumers(
  script,
  { filePath, fileSource, startOffset, blockKind, parserLang },
) {
  const out = [];
  const program = parseScriptAst(script, filePath, parserLang);
  if (!program) return out;

  for (const node of program.body ?? []) {
    if (node?.type !== "ImportDeclaration") continue;
    const fromSpec = node.source?.value;
    if (typeof fromSpec !== "string" || fromSpec.length === 0) continue;
    const line = lineOf(fileSource, startOffset + node.start);
    const declarationTypeOnly = node.importKind === "type";
    if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) {
      out.push({
        consumerFile: filePath,
        fromSpec,
        name: "*",
        kind: "import-side-effect",
        typeOnly: false,
        line,
        sfcBlockKind: blockKind,
      });
      continue;
    }

    for (const specifier of node.specifiers) {
      if (specifier.type === "ImportDefaultSpecifier") {
        out.push({
          consumerFile: filePath,
          fromSpec,
          name: "default",
          localName: importLocalName(specifier),
          kind: "default",
          typeOnly: declarationTypeOnly,
          line,
          sfcBlockKind: blockKind,
        });
      } else if (specifier.type === "ImportNamespaceSpecifier") {
        out.push({
          consumerFile: filePath,
          fromSpec,
          name: "*",
          localName: importLocalName(specifier),
          kind: "namespace",
          typeOnly: declarationTypeOnly,
          line,
          sfcBlockKind: blockKind,
        });
      } else if (specifier.type === "ImportSpecifier") {
        const name = importedName(specifier);
        if (name) {
          out.push({
            consumerFile: filePath,
            fromSpec,
            name,
            localName: importLocalName(specifier),
            kind: "import",
            typeOnly: declarationTypeOnly || specifier.importKind === "type",
            line,
            sfcBlockKind: blockKind,
          });
        }
      }
    }
  }

  return out;
}

function importLocalName(specifier) {
  return specifier?.local?.name ?? null;
}

function literalStringValue(node) {
  return node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : null;
}

function identifierName(node) {
  return node?.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : null;
}

function memberPropertyName(node) {
  if (node?.type !== "MemberExpression") return null;
  if (node.computed) return literalStringValue(node.property);
  return identifierName(node.property);
}

function traverseAst(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) {
      for (const item of value) traverseAst(item, visit);
    } else if (
      value &&
      typeof value === "object" &&
      typeof value.type === "string"
    ) {
      traverseAst(value, visit);
    }
  }
}

function traverseAstWithAncestors(node, visit, ancestors = []) {
  if (!node || typeof node !== "object") return;
  visit(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        traverseAstWithAncestors(item, visit, nextAncestors);
      }
    } else if (
      value &&
      typeof value === "object" &&
      typeof value.type === "string"
    ) {
      traverseAstWithAncestors(value, visit, nextAncestors);
    }
  }
}

function isFunctionScopeNode(node) {
  return (
    node?.type === "Program" ||
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}

function collectPatternBindingNames(pattern, out) {
  const name = identifierName(pattern);
  if (name) {
    out.add(name);
    return;
  }

  if (pattern?.type === "AssignmentPattern") {
    collectPatternBindingNames(pattern.left, out);
    return;
  }

  if (pattern?.type === "RestElement") {
    collectPatternBindingNames(pattern.argument, out);
    return;
  }

  if (pattern?.type === "ArrayPattern") {
    for (const element of pattern.elements ?? []) {
      collectPatternBindingNames(element, out);
    }
    return;
  }

  if (pattern?.type !== "ObjectPattern") return;
  for (const property of pattern.properties ?? []) {
    if (property?.type === "RestElement") {
      collectPatternBindingNames(property.argument, out);
      continue;
    }
    collectPatternBindingNames(property?.value, out);
  }
}

function nearestAstScope(ancestors, scopes) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (scopes.has(ancestors[i])) return ancestors[i];
  }
  return null;
}

function addPatternBindingsToScope(scopes, scope, pattern) {
  if (!scope) return;
  let names = scopes.get(scope);
  if (!names) {
    names = new Set();
    scopes.set(scope, names);
  }
  collectPatternBindingNames(pattern, names);
}

function collectSvelteScriptBindingScopes(program) {
  const scopes = new Map([[program, new Set()]]);
  traverseAstWithAncestors(program, (node, ancestors) => {
    if (isFunctionScopeNode(node) && !scopes.has(node)) {
      scopes.set(node, new Set());
    }

    if (node?.type === "ImportDeclaration") {
      const scope = nearestAstScope(ancestors, scopes);
      for (const specifier of node.specifiers ?? []) {
        addPatternBindingsToScope(scopes, scope, specifier.local);
      }
      return;
    }

    if (node?.type === "VariableDeclarator") {
      addPatternBindingsToScope(
        scopes,
        nearestAstScope(ancestors, scopes),
        node.id,
      );
      return;
    }

    if (node?.type === "FunctionDeclaration") {
      addPatternBindingsToScope(
        scopes,
        nearestAstScope(ancestors, scopes),
        node.id,
      );
      for (const param of node.params ?? []) {
        addPatternBindingsToScope(scopes, node, param);
      }
      return;
    }

    if (
      node?.type === "FunctionExpression" ||
      node?.type === "ArrowFunctionExpression"
    ) {
      if (node.type === "FunctionExpression") {
        addPatternBindingsToScope(scopes, node, node.id);
      }
      for (const param of node.params ?? []) {
        addPatternBindingsToScope(scopes, node, param);
      }
      return;
    }

    if (node?.type === "CatchClause") {
      addPatternBindingsToScope(
        scopes,
        nearestAstScope(ancestors, scopes),
        node.param,
      );
    }
  });
  return scopes;
}

function isSvelteDollarIdentifierShadowed(name, ancestors, scopes) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (scopes.get(ancestors[i])?.has(name)) return true;
  }
  return false;
}

function isNonReferenceIdentifier(node, ancestors) {
  const parent = ancestors.at(-1);
  if (!parent) return false;
  if (
    parent.type === "MemberExpression" &&
    parent.property === node &&
    !parent.computed
  ) {
    return true;
  }
  if (parent.type === "Property" && parent.key === node && !parent.computed) {
    return parent.value !== node;
  }
  if (parent.type === "LabeledStatement" && parent.label === node) return true;
  if (
    (parent.type === "BreakStatement" || parent.type === "ContinueStatement") &&
    parent.label === node
  ) {
    return true;
  }
  return false;
}

const VUE_APP_FACTORY_NAMES = new Set(["createApp", "createSSRApp"]);
const VUE_APP_RETURNING_METHODS = new Set([
  "component",
  "directive",
  "mixin",
  "provide",
  "use",
]);

function isVueAppFactoryCall(node) {
  if (node?.type !== "CallExpression") return false;
  const callee = node.callee;
  const directName = identifierName(callee);
  if (directName && VUE_APP_FACTORY_NAMES.has(directName)) return true;
  const memberName = memberPropertyName(callee);
  return !!memberName && VUE_APP_FACTORY_NAMES.has(memberName);
}

function isVueAppReturningExpression(node) {
  if (isVueAppFactoryCall(node)) return true;
  if (node?.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee?.type !== "MemberExpression") return false;
  const methodName = memberPropertyName(callee);
  if (!methodName || !VUE_APP_RETURNING_METHODS.has(methodName)) return false;
  return isVueAppReturningExpression(callee.object);
}

function functionLikeFirstParamName(node) {
  const params = node?.params;
  if (!Array.isArray(params) || params.length === 0) return null;
  return identifierName(params[0]);
}

function collectVueComponentReceivers(program) {
  const out = new Set();
  traverseAst(program, (node) => {
    if (
      node?.type === "VariableDeclarator" &&
      isVueAppReturningExpression(node.init)
    ) {
      const name = identifierName(node.id);
      if (name) out.add(name);
      return;
    }

    if (
      node?.type === "FunctionDeclaration" &&
      identifierName(node.id) === "install"
    ) {
      const name = functionLikeFirstParamName(node);
      if (name) out.add(name);
      return;
    }

    if (node?.type === "Property" && astPropertyName(node) === "install") {
      const value = node.value;
      if (
        value?.type === "FunctionExpression" ||
        value?.type === "ArrowFunctionExpression"
      ) {
        const name = functionLikeFirstParamName(value);
        if (name) out.add(name);
      }
    }
  });
  return out;
}

function collectImportBindings(program, src) {
  const out = new Map();
  for (const node of program.body ?? []) {
    if (node?.type !== "ImportDeclaration") continue;
    const fromSpec = node.source?.value;
    if (typeof fromSpec !== "string" || fromSpec.length === 0) continue;
    if (node.importKind === "type") continue;
    for (const specifier of node.specifiers ?? []) {
      if (specifier.importKind === "type") continue;
      const bindingName = importLocalName(specifier);
      if (!bindingName) continue;
      if (
        specifier.type !== "ImportDefaultSpecifier" &&
        specifier.type !== "ImportSpecifier"
      ) {
        continue;
      }
      out.set(bindingName, {
        bindingName,
        bindingSource: fromSpec,
        bindingKind:
          specifier.type === "ImportDefaultSpecifier" ? "default" : "named",
        importedName:
          specifier.type === "ImportDefaultSpecifier"
            ? "default"
            : importedName(specifier),
        line: lineOf(src, node.start),
      });
    }
  }
  return out;
}

function isFunctionLikeValue(node) {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression"
  );
}

function collectLocalSvelteActionBindings(
  program,
  src,
  startOffset,
  filePath,
  blockKind,
) {
  const out = new Map();
  for (const node of program.body ?? []) {
    if (node?.type === "FunctionDeclaration") {
      const bindingName = identifierName(node.id);
      if (!bindingName) continue;
      out.set(bindingName, {
        bindingName,
        bindingSource: filePath,
        bindingKind: "local-function",
        line: lineOf(src, startOffset + (node.start ?? 0)),
        sfcBlockKind: blockKind,
      });
      continue;
    }

    if (node?.type !== "VariableDeclaration" || node.kind !== "const") {
      continue;
    }
    for (const declaration of node.declarations ?? []) {
      const bindingName = identifierName(declaration.id);
      if (!bindingName || !isFunctionLikeValue(declaration.init)) continue;
      out.set(bindingName, {
        bindingName,
        bindingSource: filePath,
        bindingKind: "local-const-function",
        line: lineOf(src, startOffset + (declaration.start ?? node.start ?? 0)),
        sfcBlockKind: blockKind,
      });
    }
  }
  return out;
}

function collectLocalSvelteStoreBindings(
  program,
  src,
  startOffset,
  filePath,
  blockKind,
  imports,
) {
  const factoryBindings = new Set();
  for (const record of imports?.values?.() ?? []) {
    if (
      record.bindingSource === "svelte/store" &&
      SVELTE_STORE_FACTORY_IMPORTS.has(record.importedName ?? record.bindingName)
    ) {
      factoryBindings.add(record.bindingName);
    }
  }
  if (factoryBindings.size === 0) return new Map();

  const out = new Map();
  for (const node of program.body ?? []) {
    if (node?.type !== "VariableDeclaration" || node.kind !== "const") {
      continue;
    }
    for (const declaration of node.declarations ?? []) {
      const bindingName = identifierName(declaration.id);
      const calleeName =
        declaration.init?.type === "CallExpression"
          ? identifierName(declaration.init.callee)
          : null;
      if (!bindingName || !calleeName || !factoryBindings.has(calleeName)) {
        continue;
      }
      out.set(bindingName, {
        bindingName,
        bindingSource: filePath,
        bindingKind: "local-store-factory",
        line: lineOf(src, startOffset + (declaration.start ?? node.start ?? 0)),
        sfcBlockKind: blockKind,
      });
    }
  }
  return out;
}

function kebabFromPascal(value) {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(value)) return null;
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

function normalizedGlobalComponentNames(componentName) {
  const names = [];
  if (componentName) names.push(componentName);
  const pascal = pascalFromKebab(componentName);
  if (pascal) names.push(pascal);
  const kebab = kebabFromPascal(componentName);
  if (kebab) names.push(kebab);
  return [...new Set(names)];
}

function globalRegistrationRecord({
  filePath,
  api,
  componentName = null,
  binding = null,
  fromSpec = null,
  factoryKind = null,
  ambiguityKey = null,
  line,
  status = "registration-syntax",
  reason = null,
}) {
  const explicitFromSpec = binding?.bindingSource ?? fromSpec;
  return {
    registrationFile: filePath,
    framework: "vue",
    api,
    ...(componentName
      ? {
          componentName,
          normalizedTagNames: normalizedGlobalComponentNames(componentName),
        }
      : {}),
    ...(binding
      ? {
          bindingName: binding.bindingName,
          bindingSource: binding.bindingSource,
          fromSpec: explicitFromSpec,
          bindingKind: binding.bindingKind,
          ...(binding.importedName
            ? { importedName: binding.importedName }
            : {}),
        }
      : explicitFromSpec
        ? { fromSpec: explicitFromSpec }
        : {}),
    source: "sfc-global-component-registration",
    status,
    confidence: status === "muted" ? "muted-review" : "registration-review",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    ...(reason ? { reason } : {}),
    ...(factoryKind ? { factoryKind } : {}),
    ...(ambiguityKey ? { ambiguityKey } : {}),
    line,
  };
}

function importExpressionLiteralSource(node) {
  if (node?.type !== "ImportExpression") return null;
  return literalStringValue(node.source);
}

function asyncLoaderImportSource(node) {
  if (
    node?.type !== "ArrowFunctionExpression" &&
    node?.type !== "FunctionExpression"
  ) {
    return null;
  }
  const direct = importExpressionLiteralSource(node.body);
  if (direct) return direct;
  if (node.body?.type !== "BlockStatement") return null;
  for (const statement of node.body.body ?? []) {
    if (statement?.type !== "ReturnStatement") continue;
    const returned = importExpressionLiteralSource(statement.argument);
    if (returned) return returned;
  }
  return null;
}

function defineAsyncComponentFactory(node) {
  if (node?.type !== "CallExpression") return null;
  if (identifierName(node.callee) !== "defineAsyncComponent") return null;
  return {
    factoryKind: "defineAsyncComponent",
    fromSpec: asyncLoaderImportSource(node.arguments?.[0]),
  };
}

function markDuplicateGlobalRegistrations(records) {
  const byName = new Map();
  for (const record of records) {
    if (!record.componentName) continue;
    if (!record.bindingName && !record.fromSpec) continue;
    const key = `${record.api}:${record.componentName}`;
    const group = byName.get(key) ?? [];
    group.push(record);
    byName.set(key, group);
  }
  const duplicateRecords = new Set(
    [...byName.entries()]
      .filter(([, group]) => group.length > 1)
      .flatMap(([, group]) => group.map((record) => record)),
  );
  if (duplicateRecords.size === 0) return records;
  return records.map((record) => {
    if (!duplicateRecords.has(record)) return record;
    if (!record.bindingName && !record.fromSpec) return record;
    return {
      ...record,
      status: "muted",
      confidence: "muted-review",
      reason: "sfc-global-component-duplicate-registration",
      ambiguityKey: record.componentName,
    };
  });
}

const GENERATED_COMPONENT_MANIFESTS = Object.freeze([
  {
    relPath: "components.d.ts",
    manifestKind: "unplugin-vue-components-dts",
  },
  {
    relPath: ".nuxt/components.d.ts",
    manifestKind: "nuxt-components-dts",
  },
]);

const NUXT_COMPONENTS_ALIAS_SPEC = "#components";
const NUXT_COMPONENTS_ALIAS_SOURCE =
  "sfc-framework-nuxt-components-alias";
const NUXT_COMPONENTS_ALIAS_MANIFEST_REASON =
  "sfc-framework-nuxt-components-alias-manifest";
const NUXT_COMPONENTS_ALIAS_UNRESOLVED_REASON =
  "sfc-framework-nuxt-components-alias-unresolved";
const NUXT_COMPONENTS_ALIAS_HELPER_EXPORTS = new Set(["componentNames"]);
const NUXT_COMPONENTS_DIR_CONFIG_REASON =
  "sfc-framework-nuxt-components-dir-config";
const NUXT_CUSTOM_RESOLVER_UNAVAILABLE_REASON =
  "sfc-framework-nuxt-custom-resolver-unavailable";
const NUXT_LAYER_EXTENDS_UNAVAILABLE_REASON =
  "sfc-framework-nuxt-layer-extends-unavailable";
const NUXT_MODULE_PACKAGE_UNAVAILABLE_REASON =
  "sfc-framework-nuxt-module-package-unavailable";
const SVELTE_STORE_SUBSCRIPTION_REASON =
  "sfc-framework-svelte-store-subscription";
const SVELTE_STORE_FACTORY_IMPORTS = new Set(["writable", "readable", "derived"]);
const NUXT_CUSTOM_RESOLVER_HOOKS = new Set([
  "components:dirs",
  "components:extend",
]);

const NUXT_ROOT_CONFIGS = Object.freeze([
  "nuxt.config.ts",
  "nuxt.config.mts",
  "nuxt.config.cts",
  "nuxt.config.js",
  "nuxt.config.mjs",
  "nuxt.config.cjs",
]);

const NUXT_COMPONENT_CONVENTION_ROOTS = Object.freeze([
  {
    relPath: "components",
    conventionKind: "nuxt-components-directory",
    reason: "sfc-framework-nuxt-fs-convention",
  },
  {
    relPath: "app/components",
    conventionKind: "nuxt-app-components-directory",
    reason: "sfc-framework-nuxt-app-dir-convention",
    requiresAppSrcDirSignal: true,
  },
]);

const UNPLUGIN_COMPONENT_CONFIGS = Object.freeze([
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "webpack.config.ts",
  "webpack.config.mts",
  "webpack.config.cts",
  "webpack.config.js",
  "webpack.config.mjs",
  "webpack.config.cjs",
]);

function packageJsonNuxtDependencyRange(root) {
  const filePath = path.join(root, "package.json");
  if (!existsSync(filePath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(filePath, "utf8"));
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      if (pkg?.[field]?.nuxt) return pkg[field].nuxt;
    }
  } catch {
    return null;
  }
  return null;
}

function packageJsonHasNuxtDependency(root) {
  return typeof packageJsonNuxtDependencyRange(root) === "string";
}

function isNuxtFourDependencyRange(value) {
  if (typeof value !== "string") return false;
  const spec = value.trim().replace(/^npm:nuxt@/, "");
  const match = spec.match(/(?:^|[^\d])([0-9]+)(?:\b|[.\-xX*])/);
  return match ? Number(match[1]) >= 4 : false;
}

function packageJsonHasNuxtFourDependency(root) {
  return isNuxtFourDependencyRange(packageJsonNuxtDependencyRange(root));
}

function isNuxtAppSrcDirValue(value) {
  if (typeof value !== "string") return false;
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  return normalized === "app";
}

function nuxtConfigHasAppSrcDir(root) {
  for (const rel of NUXT_ROOT_CONFIGS) {
    const filePath = path.join(root, rel);
    if (!existsSync(filePath)) continue;
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const program = parseScriptAst(src, filePath, parserLangFromFile(filePath));
    if (!program) continue;
    let found = false;
    traverseAst(program, (node) => {
      if (found) return;
      if (node?.type !== "Property") return;
      if (node.computed) return;
      if (astPropertyName(node) !== "srcDir") return;
      if (isNuxtAppSrcDirValue(literalStringValue(node.value))) found = true;
    });
    if (found) return true;
  }
  return false;
}

function hasNuxtConventionSignal(root) {
  if (existsSync(path.join(root, ".nuxt", "components.d.ts"))) return true;
  if (NUXT_ROOT_CONFIGS.some((rel) => existsSync(path.join(root, rel)))) {
    return true;
  }
  return packageJsonHasNuxtDependency(root);
}

function hasNuxtAppDirConventionSignal(root) {
  return packageJsonHasNuxtFourDependency(root) || nuxtConfigHasAppSrcDir(root);
}

function nuxtConfigObjectExpression(node) {
  if (node?.type === "ObjectExpression") return node;
  if (
    node?.type === "CallExpression" &&
    identifierName(node.callee) === "defineNuxtConfig" &&
    node.arguments?.[0]?.type === "ObjectExpression"
  ) {
    return node.arguments[0];
  }
  return null;
}

function nuxtConfigRootObjectExpressions(program) {
  const out = [];
  for (const node of program?.body ?? []) {
    if (node?.type === "ExportDefaultDeclaration") {
      const configObject = nuxtConfigObjectExpression(node.declaration);
      if (configObject) out.push(configObject);
      continue;
    }
    const expr = node?.type === "ExpressionStatement" ? node.expression : null;
    if (
      expr?.type === "AssignmentExpression" &&
      expr.operator === "=" &&
      expr.left?.type === "MemberExpression" &&
      identifierName(expr.left.object) === "module" &&
      memberPropertyName(expr.left) === "exports"
    ) {
      const configObject = nuxtConfigObjectExpression(expr.right);
      if (configObject) out.push(configObject);
    }
  }
  return out;
}

function nuxtConfigSrcDirValue(configObject) {
  for (const property of configObject?.properties ?? []) {
    if (property?.type !== "Property" || property.computed) continue;
    if (astPropertyName(property) !== "srcDir") continue;
    return literalStringValue(property.value);
  }
  return null;
}

function nuxtRootRelativePath(root, configuredPath) {
  if (typeof configuredPath !== "string" || configuredPath.length === 0) {
    return null;
  }
  const normalized = configuredPath.replace(/\\/g, "/");
  if (path.isAbsolute(normalized)) return normalized;
  return path.join(root, normalized);
}

function nuxtConfigSrcDirRoot(root, configObject) {
  const srcDir = nuxtConfigSrcDirValue(configObject);
  if (srcDir) return nuxtRootRelativePath(root, srcDir);
  if (packageJsonHasNuxtFourDependency(root)) return path.join(root, "app");
  return root;
}

function nuxtConfigPath(root, configFile, srcDirRoot, configuredPath) {
  if (typeof configuredPath !== "string" || configuredPath.length === 0) {
    return null;
  }
  const normalized = configuredPath.replace(/\\/g, "/");
  if (normalized.startsWith("~/") || normalized.startsWith("@/")) {
    return path.join(srcDirRoot || root, normalized.slice(2));
  }
  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return path.resolve(path.dirname(configFile), normalized);
  }
  if (path.isAbsolute(normalized)) return normalized;
  return path.join(root, normalized);
}

function nuxtComponentsDirConfigRecord({
  root,
  configFile,
  srcDirRoot,
  componentDir,
  prefix = null,
  pathPrefix = null,
  global = null,
  line,
}) {
  const resolved = nuxtConfigPath(root, configFile, srcDirRoot, componentDir);
  return {
    framework: "nuxt",
    conventionKind: "nuxt-components-dir-config",
    configFile,
    componentDir,
    ...(resolved && existsSync(resolved) ? { resolvedDir: resolved } : {}),
    ...(typeof prefix === "string" && prefix.length > 0 ? { prefix } : {}),
    ...(typeof pathPrefix === "boolean" || typeof pathPrefix === "string"
      ? { pathPrefix }
      : {}),
    ...(typeof global === "boolean" ? { global } : {}),
    source: NUXT_COMPONENTS_DIR_CONFIG_REASON,
    confidence: "framework-convention-observed",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    status: "muted",
    reason: NUXT_COMPONENTS_DIR_CONFIG_REASON,
    ...(Number.isFinite(line) ? { line } : {}),
  };
}

function nuxtCustomResolverUnavailableRecord({ configFile, hookName, line }) {
  return {
    framework: "nuxt",
    conventionKind: "nuxt-custom-resolver-unavailable",
    configFile,
    hookName,
    configShape: "hooks",
    source: NUXT_CUSTOM_RESOLVER_UNAVAILABLE_REASON,
    confidence: "framework-convention-observed",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    status: "unavailable",
    reason: NUXT_CUSTOM_RESOLVER_UNAVAILABLE_REASON,
    ...(Number.isFinite(line) ? { line } : {}),
  };
}

function nuxtLayerExtendsUnavailableRecord({
  configFile,
  extendsSource = null,
  extendsSourceKind,
  line,
}) {
  return {
    framework: "nuxt",
    conventionKind: "nuxt-layer-extends-unavailable",
    configFile,
    configProperty: "extends",
    configShape: "extends",
    ...(typeof extendsSource === "string" && extendsSource.length > 0
      ? { extendsSource }
      : {}),
    extendsSourceKind,
    source: NUXT_LAYER_EXTENDS_UNAVAILABLE_REASON,
    confidence: "framework-convention-observed",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    status: "unavailable",
    reason: NUXT_LAYER_EXTENDS_UNAVAILABLE_REASON,
    ...(Number.isFinite(line) ? { line } : {}),
  };
}

function nuxtModulePackageUnavailableRecord({
  configFile,
  moduleSource = null,
  moduleSourceKind,
  line,
}) {
  return {
    framework: "nuxt",
    conventionKind: "nuxt-module-package-unavailable",
    configFile,
    configProperty: "modules",
    configShape: "modules",
    ...(typeof moduleSource === "string" && moduleSource.length > 0
      ? { moduleSource }
      : {}),
    moduleSourceKind,
    source: NUXT_MODULE_PACKAGE_UNAVAILABLE_REASON,
    confidence: "framework-convention-observed",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    status: "unavailable",
    reason: NUXT_MODULE_PACKAGE_UNAVAILABLE_REASON,
    ...(Number.isFinite(line) ? { line } : {}),
  };
}

function booleanLiteralValue(node) {
  return node?.type === "Literal" && typeof node.value === "boolean"
    ? node.value
    : null;
}

function nuxtComponentsDirObjectRecord({ root, configFile, srcDirRoot, node, src }) {
  let componentDir = null;
  let prefix = null;
  let pathPrefix = null;
  let global = null;
  for (const property of node?.properties ?? []) {
    if (property?.type !== "Property" || property.computed) continue;
    const name = astPropertyName(property);
    if (name === "path") componentDir = literalStringValue(property.value);
    if (name === "prefix") prefix = literalStringValue(property.value);
    if (name === "pathPrefix") {
      pathPrefix =
        booleanLiteralValue(property.value) ?? literalStringValue(property.value);
    }
    if (name === "global") global = booleanLiteralValue(property.value);
  }
  if (!componentDir) return null;
  return nuxtComponentsDirConfigRecord({
    root,
    configFile,
    srcDirRoot,
    componentDir,
    prefix,
    pathPrefix,
    global,
    line: lineOf(src, node.start),
  });
}

function nuxtComponentsDirConfigRecordsFromValue({
  root,
  configFile,
  srcDirRoot,
  value,
  src,
}) {
  const out = [];
  const stringValue = literalStringValue(value);
  if (stringValue) {
    out.push(
      nuxtComponentsDirConfigRecord({
        root,
        configFile,
        srcDirRoot,
        componentDir: stringValue,
        line: lineOf(src, value.start),
      }),
    );
    return out;
  }
  if (value?.type === "ArrayExpression") {
    for (const element of value.elements ?? []) {
      if (!element) continue;
      out.push(
        ...nuxtComponentsDirConfigRecordsFromValue({
          root,
          configFile,
          srcDirRoot,
          value: element,
          src,
        }),
      );
    }
    return out;
  }
  if (value?.type === "ObjectExpression") {
    const direct = nuxtComponentsDirObjectRecord({
      root,
      configFile,
      srcDirRoot,
      node: value,
      src,
    });
    if (direct) out.push(direct);
    for (const property of value.properties ?? []) {
      if (property?.type !== "Property" || property.computed) continue;
      if (astPropertyName(property) !== "dirs") continue;
      out.push(
        ...nuxtComponentsDirConfigRecordsFromValue({
          root,
          configFile,
          srcDirRoot,
          value: property.value,
          src,
        }),
      );
    }
  }
  return out;
}

function collectSfcNuxtComponentsDirConfigConventions({ root }) {
  if (!hasNuxtConventionSignal(root)) return [];
  const out = [];
  for (const rel of NUXT_ROOT_CONFIGS) {
    const filePath = path.join(root, rel);
    if (!existsSync(filePath)) continue;
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const program = parseScriptAst(src, filePath, parserLangFromFile(filePath));
    if (!program) continue;
    for (const configObject of nuxtConfigRootObjectExpressions(program)) {
      const srcDirRoot = nuxtConfigSrcDirRoot(root, configObject);
      for (const property of configObject.properties ?? []) {
        if (property?.type !== "Property" || property.computed) continue;
        if (astPropertyName(property) !== "components") continue;
        out.push(
          ...nuxtComponentsDirConfigRecordsFromValue({
            root,
            configFile: filePath,
            srcDirRoot,
            value: property.value,
            src,
          }),
        );
      }
    }
  }
  return out;
}

function isFunctionLikeExpression(node) {
  return (
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}

function collectSfcNuxtCustomResolverUnavailableConventions({ root }) {
  if (!hasNuxtConventionSignal(root)) return [];
  const out = [];
  for (const rel of NUXT_ROOT_CONFIGS) {
    const filePath = path.join(root, rel);
    if (!existsSync(filePath)) continue;
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const program = parseScriptAst(src, filePath, parserLangFromFile(filePath));
    if (!program) continue;
    for (const configObject of nuxtConfigRootObjectExpressions(program)) {
      for (const property of configObject.properties ?? []) {
        if (property?.type !== "Property" || property.computed) continue;
        if (astPropertyName(property) !== "hooks") continue;
        if (property.value?.type !== "ObjectExpression") continue;
        for (const hookProperty of property.value.properties ?? []) {
          if (hookProperty?.type !== "Property" || hookProperty.computed) {
            continue;
          }
          const hookName = astPropertyName(hookProperty);
          if (!NUXT_CUSTOM_RESOLVER_HOOKS.has(hookName)) continue;
          if (!isFunctionLikeExpression(hookProperty.value)) continue;
          out.push(
            nuxtCustomResolverUnavailableRecord({
              configFile: filePath,
              hookName,
              line: lineOf(src, hookProperty.start ?? property.start),
            }),
          );
        }
      }
    }
  }
  return out;
}

function nuxtLayerExtendsRecordsFromValue({ configFile, value, src }) {
  const out = [];
  const stringValue = literalStringValue(value);
  if (stringValue) {
    out.push(
      nuxtLayerExtendsUnavailableRecord({
        configFile,
        extendsSource: stringValue,
        extendsSourceKind: "literal",
        line: lineOf(src, value.start),
      }),
    );
    return out;
  }
  if (value?.type === "ArrayExpression") {
    for (const element of value.elements ?? []) {
      if (!element) continue;
      out.push(
        ...nuxtLayerExtendsRecordsFromValue({
          configFile,
          value: element,
          src,
        }),
      );
    }
    return out;
  }
  out.push(
    nuxtLayerExtendsUnavailableRecord({
      configFile,
      extendsSourceKind: "nonliteral",
      line: lineOf(src, value?.start),
    }),
  );
  return out;
}

function collectSfcNuxtLayerExtendsUnavailableConventions({ root }) {
  if (!hasNuxtConventionSignal(root)) return [];
  const out = [];
  for (const rel of NUXT_ROOT_CONFIGS) {
    const filePath = path.join(root, rel);
    if (!existsSync(filePath)) continue;
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const program = parseScriptAst(src, filePath, parserLangFromFile(filePath));
    if (!program) continue;
    for (const configObject of nuxtConfigRootObjectExpressions(program)) {
      for (const property of configObject.properties ?? []) {
        if (property?.type !== "Property" || property.computed) continue;
        if (astPropertyName(property) !== "extends") continue;
        out.push(
          ...nuxtLayerExtendsRecordsFromValue({
            configFile: filePath,
            value: property.value,
            src,
          }),
        );
      }
    }
  }
  return out;
}

function nuxtModulePackageRecordFromEntry({ configFile, value, src }) {
  const entry =
    value?.type === "ArrayExpression" ? (value.elements ?? [])[0] : value;
  const stringValue = literalStringValue(entry);
  if (stringValue) {
    return nuxtModulePackageUnavailableRecord({
      configFile,
      moduleSource: stringValue,
      moduleSourceKind: "literal",
      line: lineOf(src, entry.start),
    });
  }
  return nuxtModulePackageUnavailableRecord({
    configFile,
    moduleSourceKind: "nonliteral",
    line: lineOf(src, entry?.start ?? value?.start),
  });
}

function nuxtModulePackageRecordsFromValue({ configFile, value, src }) {
  if (value?.type !== "ArrayExpression") {
    return [nuxtModulePackageRecordFromEntry({ configFile, value, src })];
  }
  const out = [];
  for (const element of value.elements ?? []) {
    if (!element) continue;
    out.push(nuxtModulePackageRecordFromEntry({ configFile, value: element, src }));
  }
  return out;
}

function collectSfcNuxtModulePackageUnavailableConventions({ root }) {
  if (!hasNuxtConventionSignal(root)) return [];
  const out = [];
  for (const rel of NUXT_ROOT_CONFIGS) {
    const filePath = path.join(root, rel);
    if (!existsSync(filePath)) continue;
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const program = parseScriptAst(src, filePath, parserLangFromFile(filePath));
    if (!program) continue;
    for (const configObject of nuxtConfigRootObjectExpressions(program)) {
      for (const property of configObject.properties ?? []) {
        if (property?.type !== "Property" || property.computed) continue;
        if (astPropertyName(property) !== "modules") continue;
        out.push(
          ...nuxtModulePackageRecordsFromValue({
            configFile: filePath,
            value: property.value,
            src,
          }),
        );
      }
    }
  }
  return out;
}

function stripNuxtComponentModeSuffix(value) {
  return `${value ?? ""}`.replace(/\.(client|server|global)$/i, "");
}

function pascalFromNuxtConventionSegment(value) {
  const cleaned = stripNuxtComponentModeSuffix(value);
  const parts = cleaned.split(/[-_\s.]+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts
    .map((part) => `${part[0] ?? ""}`.toUpperCase() + part.slice(1))
    .join("");
}

function pathInsideRoot(rootRel, conventionRootRelPath) {
  const rootParts = conventionRootRelPath.split("/").filter(Boolean);
  const fileParts = rootRel.split(path.sep).filter(Boolean);
  if (fileParts.length < rootParts.length) return false;
  return rootParts.every((part, index) => fileParts[index] === part);
}

function nuxtConventionRootDir(root, conventionRoot) {
  return path.join(root, ...conventionRoot.relPath.split("/").filter(Boolean));
}

function nuxtConventionRootForRelPath(rootRel) {
  return NUXT_COMPONENT_CONVENTION_ROOTS.find((conventionRoot) =>
    pathInsideRoot(rootRel, conventionRoot.relPath),
  );
}

function nuxtConventionPathSegments({ root, filePath, conventionRoot }) {
  return path
    .relative(nuxtConventionRootDir(root, conventionRoot), filePath)
    .split(path.sep)
    .filter(Boolean)
    .map((segment) =>
      stripNuxtComponentModeSuffix(segment.replace(/\.[^.]+$/, "")),
    );
}

function nuxtConventionComponentName({ root, filePath, conventionRoot }) {
  const parts = nuxtConventionPathSegments({ root, filePath, conventionRoot })
    .map((segment) => pascalFromNuxtConventionSegment(segment))
    .filter(Boolean);
  const deduped = [];
  for (const part of parts) {
    if (deduped.at(-1)?.toLowerCase() === part.toLowerCase()) continue;
    deduped.push(part);
  }
  return deduped.join("");
}

function nuxtConventionRecord({ root, filePath, conventionRoot }) {
  const componentName = nuxtConventionComponentName({
    root,
    filePath,
    conventionRoot,
  });
  return {
    framework: "nuxt",
    conventionKind: conventionRoot.conventionKind,
    componentName,
    normalizedTagNames: normalizedGlobalComponentNames(componentName),
    sourceFile: filePath,
    resolvedFile: filePath,
    source: conventionRoot.reason,
    confidence: "framework-convention-observed",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    status: "muted",
    reason: conventionRoot.reason,
    componentPathSegments: nuxtConventionPathSegments({
      root,
      filePath,
      conventionRoot,
    }),
  };
}

function generatedManifestTargetFile(manifest) {
  const fromSpec = manifest?.bindingSource ?? manifest?.fromSpec;
  if (!isRelativeSourceSpec(fromSpec)) return null;
  const target = path.resolve(path.dirname(manifest.manifestFile), fromSpec);
  return existsSync(target) ? target : null;
}

function nuxtGeneratedManifestLookup(root) {
  const byName = new Map();
  for (const record of collectSfcGeneratedComponentManifests({ root })) {
    if (record.manifestKind !== "nuxt-components-dts") continue;
    if (record.status === "skipped") continue;
    const names = [
      record.componentName,
      ...(Array.isArray(record.normalizedTagNames)
        ? record.normalizedTagNames
        : []),
    ].filter(Boolean);
    for (const name of names) byName.set(name, record);
  }
  return byName;
}

function nuxtComponentsAliasRecord({ use, manifest = null }) {
  const resolvedFile = manifest ? generatedManifestTargetFile(manifest) : null;
  const status = manifest && resolvedFile ? "muted" : "unresolved";
  const reason =
    status === "muted"
      ? NUXT_COMPONENTS_ALIAS_MANIFEST_REASON
      : NUXT_COMPONENTS_ALIAS_UNRESOLVED_REASON;
  const componentName = manifest?.componentName ?? use.name;
  return {
    framework: "nuxt",
    conventionKind: "nuxt-components-alias-import",
    consumerFile: use.consumerFile,
    componentName,
    normalizedTagNames:
      manifest?.normalizedTagNames ?? normalizedGlobalComponentNames(componentName),
    bindingName: use.localName ?? use.name,
    importedName: use.name,
    ...(manifest
      ? {
          manifestFile: manifest.manifestFile,
          manifestKind: manifest.manifestKind,
          bindingSource: manifest.bindingSource ?? manifest.fromSpec,
        }
      : {}),
    fromSpec: NUXT_COMPONENTS_ALIAS_SPEC,
    ...(resolvedFile ? { resolvedFile } : {}),
    source: NUXT_COMPONENTS_ALIAS_SOURCE,
    confidence: manifest
      ? "generated-manifest-availability"
      : "framework-convention-observed",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    status,
    reason,
    ...(use.sfcBlockKind ? { sfcBlockKind: use.sfcBlockKind } : {}),
    ...(Number.isFinite(use.line) ? { line: use.line } : {}),
  };
}

function collectSfcNuxtComponentsAliasConventions({
  root,
  includeTests = true,
  exclude = [],
}) {
  if (!hasNuxtConventionSignal(root)) return [];
  const out = [];
  const manifestByName = nuxtGeneratedManifestLookup(root);
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: SFC_FAMILY_LANGS,
  });

  for (const filePath of files) {
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const use of parseSfcImportConsumers(src, filePath)) {
      if (use.fromSpec !== NUXT_COMPONENTS_ALIAS_SPEC) continue;
      if (use.kind !== "import" || use.typeOnly) continue;
      if (NUXT_COMPONENTS_ALIAS_HELPER_EXPORTS.has(use.name)) continue;
      out.push(
        nuxtComponentsAliasRecord({
          use,
          manifest: manifestByName.get(use.name) ?? null,
        }),
      );
    }
  }

  return out;
}

function isUnpluginVueComponentsSpec(fromSpec) {
  return (
    typeof fromSpec === "string" &&
    (fromSpec === "unplugin-vue-components" ||
      fromSpec.startsWith("unplugin-vue-components/"))
  );
}

function unpluginRequireSource(node) {
  if (node?.type !== "CallExpression") return null;
  if (identifierName(node.callee) !== "require") return null;
  const fromSpec = literalStringValue(node.arguments?.[0]);
  return isUnpluginVueComponentsSpec(fromSpec) ? fromSpec : null;
}

function unpluginConfigRecord({ filePath, pluginName, fromSpec, line }) {
  return {
    framework: "unplugin-vue-components",
    conventionKind: "auto-import-plugin-config",
    configFile: filePath,
    pluginName,
    fromSpec,
    source: "sfc-framework-auto-import-plugin-config",
    confidence: "framework-convention-observed",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    status: "muted",
    reason: "sfc-framework-auto-import-plugin-config",
    line,
  };
}

function astroClientDirectiveName(attrs) {
  const match = `${attrs ?? ""}`.match(
    /(?:^|\s)(client:[A-Za-z][A-Za-z0-9_-]*)(?=\s|=|\/|$)/,
  );
  return match?.[1] ?? null;
}

function astroClientDirectiveRecord({
  filePath,
  tagName,
  normalizedTagName,
  directiveName,
  binding,
  line,
  blockKind,
}) {
  return {
    framework: "astro",
    conventionKind: "client-directive",
    consumerFile: filePath,
    tagName,
    normalizedTagName,
    directiveName,
    bindingName: binding.bindingName,
    bindingSource: binding.bindingSource,
    fromSpec: binding.bindingSource,
    bindingKind: binding.bindingKind,
    ...(binding.importedName ? { importedName: binding.importedName } : {}),
    source: "sfc-framework-astro-client-directive",
    confidence: "framework-convention-observed",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    status: "muted",
    reason: "sfc-framework-astro-client-directive",
    line,
    sfcBlockKind: blockKind,
  };
}

function svelteActionDirectiveRecord({
  filePath,
  tagName,
  directiveName,
  actionName,
  binding,
  line,
  blockKind,
}) {
  return {
    framework: "svelte",
    conventionKind: "action-directive",
    consumerFile: filePath,
    tagName,
    directiveName,
    actionName,
    bindingName: binding.bindingName,
    bindingSource: binding.bindingSource,
    fromSpec: binding.bindingSource,
    bindingKind: binding.bindingKind,
    ...(binding.importedName ? { importedName: binding.importedName } : {}),
    source: "sfc-framework-svelte-action-directive",
    confidence: "framework-convention-observed",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    status: "muted",
    reason: "sfc-framework-svelte-action-directive",
    line,
    sfcBlockKind: blockKind,
  };
}

function svelteStoreSubscriptionRecord({
  filePath,
  subscriptionName,
  storeName,
  binding,
  line,
  blockKind,
}) {
  return {
    framework: "svelte",
    conventionKind: "store-auto-subscription",
    consumerFile: filePath,
    subscriptionName,
    storeName,
    bindingName: binding.bindingName,
    bindingSource: binding.bindingSource,
    fromSpec: binding.bindingSource,
    bindingKind: binding.bindingKind,
    ...(binding.importedName ? { importedName: binding.importedName } : {}),
    source: SVELTE_STORE_SUBSCRIPTION_REASON,
    confidence: "framework-convention-observed",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    status: "muted",
    reason: SVELTE_STORE_SUBSCRIPTION_REASON,
    line,
    sfcBlockKind: blockKind,
  };
}

function vueMacroRegistrationRecord({
  filePath,
  macroName,
  componentName,
  binding,
  line,
  blockKind,
}) {
  return {
    framework: "vue",
    conventionKind: "macro-registration",
    consumerFile: filePath,
    macroName,
    componentName,
    normalizedTagNames: normalizedGlobalComponentNames(componentName),
    bindingName: binding.bindingName,
    bindingSource: binding.bindingSource,
    fromSpec: binding.bindingSource,
    bindingKind: binding.bindingKind,
    ...(binding.importedName ? { importedName: binding.importedName } : {}),
    source: "sfc-framework-vue-macro-registration",
    confidence: "framework-convention-observed",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    status: "muted",
    reason: "sfc-framework-vue-macro-registration",
    line,
    sfcBlockKind: blockKind,
  };
}

function vueOptionsRegistrationRecord({
  filePath,
  componentName,
  binding,
  line,
  blockKind,
}) {
  return {
    framework: "vue",
    conventionKind: "options-registration",
    consumerFile: filePath,
    optionName: "components",
    componentName,
    normalizedTagNames: normalizedGlobalComponentNames(componentName),
    bindingName: binding.bindingName,
    bindingSource: binding.bindingSource,
    fromSpec: binding.bindingSource,
    bindingKind: binding.bindingKind,
    ...(binding.importedName ? { importedName: binding.importedName } : {}),
    source: "sfc-framework-vue-options-registration",
    confidence: "framework-convention-observed",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    status: "muted",
    reason: "sfc-framework-vue-options-registration",
    line,
    sfcBlockKind: blockKind,
  };
}

function componentsObjectFromDefineOptions(node) {
  if (node?.type !== "CallExpression") return null;
  if (identifierName(node.callee) !== "defineOptions") return null;
  const options = node.arguments?.[0];
  if (options?.type !== "ObjectExpression") return null;
  for (const property of options.properties ?? []) {
    if (property?.type !== "Property") continue;
    if (property.computed) continue;
    if (astPropertyName(property) !== "components") continue;
    return property.value?.type === "ObjectExpression" ? property.value : null;
  }
  return null;
}

function componentsObjectFromVueDefaultExport(node) {
  if (node?.type !== "ExportDefaultDeclaration") return null;
  const declaration = node.declaration;
  if (declaration?.type !== "ObjectExpression") return null;
  for (const property of declaration.properties ?? []) {
    if (property?.type !== "Property") continue;
    if (property.computed) continue;
    if (astPropertyName(property) !== "components") continue;
    return property.value?.type === "ObjectExpression" ? property.value : null;
  }
  return null;
}

function parseVueMacroRegistrations(
  script,
  { filePath, fileSource, startOffset, blockKind, parserLang },
) {
  const out = [];
  if (blockKind !== "vue-script-setup") return out;
  const program = parseScriptAst(script, filePath, parserLang);
  if (!program) return out;
  const imports = collectImportBindings(program, fileSource);

  traverseAst(program, (node) => {
    const components = componentsObjectFromDefineOptions(node);
    if (!components) return;
    for (const property of components.properties ?? []) {
      if (property?.type !== "Property") continue;
      if (property.computed) continue;
      const componentName = astPropertyName(property);
      const bindingName = identifierName(property.value);
      const binding = bindingName ? imports.get(bindingName) : null;
      if (!componentName || !binding) continue;
      out.push(
        vueMacroRegistrationRecord({
          filePath,
          macroName: "defineOptions",
          componentName,
          binding,
          line: lineOf(
            fileSource,
            startOffset + (property.start ?? node.start),
          ),
          blockKind,
        }),
      );
    }
  });

  return out;
}

function parseVueOptionsRegistrations(
  script,
  { filePath, fileSource, startOffset, blockKind, parserLang },
) {
  const out = [];
  if (blockKind !== "vue-script") return out;
  const program = parseScriptAst(script, filePath, parserLang);
  if (!program) return out;
  const imports = collectImportBindings(program, fileSource);

  for (const node of program.body ?? []) {
    const components = componentsObjectFromVueDefaultExport(node);
    if (!components) continue;
    for (const property of components.properties ?? []) {
      if (property?.type !== "Property") continue;
      if (property.computed) continue;
      const componentName = astPropertyName(property);
      const bindingName = identifierName(property.value);
      const binding = bindingName ? imports.get(bindingName) : null;
      if (!componentName || !binding) continue;
      out.push(
        vueOptionsRegistrationRecord({
          filePath,
          componentName,
          binding,
          line: lineOf(
            fileSource,
            startOffset + (property.start ?? node.start),
          ),
          blockKind,
        }),
      );
    }
  }

  return out;
}

function parseAstroClientDirectiveTags(
  template,
  { filePath, fileSource, startOffset, blockKind, bindings },
) {
  const out = [];
  const cleaned = stripHtmlComments(template);
  const tagRe = /<\s*([A-Za-z][A-Za-z0-9.:-]*)([^<>]*?)(?:\/?)>/g;
  let match;
  while ((match = tagRe.exec(cleaned))) {
    const tagName = match[1];
    if (tagName.includes(".")) continue;
    const attrs = match[2] ?? "";
    const directiveName = astroClientDirectiveName(attrs);
    if (!directiveName) continue;
    const line = lineOf(fileSource, startOffset + match.index);

    for (const candidate of templateTagCandidates(tagName)) {
      const binding = bindings.exposedNames.get(candidate);
      if (!binding) continue;
      out.push(
        astroClientDirectiveRecord({
          filePath,
          tagName,
          normalizedTagName: candidate,
          directiveName,
          binding,
          line,
          blockKind,
        }),
      );
      break;
    }
  }
  return out;
}

function parseSvelteActionDirectiveTags(
  template,
  { filePath, fileSource, startOffset, blockKind, bindings },
) {
  const out = [];
  const cleaned = stripHtmlComments(template);
  const tagRe = /<\s*([A-Za-z][A-Za-z0-9.:-]*)([^<>]*?)(?:\/?)>/g;
  let match;
  while ((match = tagRe.exec(cleaned))) {
    const tagName = match[1];
    const attrs = match[2] ?? "";
    const line = lineOf(fileSource, startOffset + match.index);
    const actionRe = /(?:^|\s)(use:([A-Za-z_$][\w$]*))(?=\s|=|\/|$)/g;
    let actionMatch;
    while ((actionMatch = actionRe.exec(attrs))) {
      const directiveName = actionMatch[1];
      const actionName = actionMatch[2];
      const binding =
        bindings.localActions?.get(actionName) ??
        bindings.exposedNames.get(actionName) ??
        bindings.imports.get(actionName);
      if (!binding) continue;
      out.push(
        svelteActionDirectiveRecord({
          filePath,
          tagName,
          directiveName,
          actionName,
          binding,
          line,
          blockKind,
        }),
      );
    }
  }
  return out;
}

function svelteStoreBindingForName(storeName, bindings) {
  const binding =
    bindings.localStores?.get(storeName) ??
    bindings.exposedNames.get(storeName) ??
    bindings.imports.get(storeName);
  if (
    binding?.bindingSource === "svelte/store" &&
    SVELTE_STORE_FACTORY_IMPORTS.has(binding.importedName ?? binding.bindingName)
  ) {
    return null;
  }
  return binding ?? null;
}

function pushSvelteStoreSubscription({
  out,
  seen,
  storeName,
  binding,
  filePath,
  line,
  blockKind,
}) {
  if (!storeName || !binding || !Number.isFinite(line)) return;
  const subscriptionName = `$${storeName}`;
  const key = `${filePath}|${subscriptionName}|${line}|${blockKind}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(
    svelteStoreSubscriptionRecord({
      filePath,
      subscriptionName,
      storeName,
      binding,
      line,
      blockKind,
    }),
  );
}

function parseSvelteStoreSubscriptionsInScript(
  script,
  { filePath, fileSource, startOffset, blockKind, parserLang, bindings, seen },
) {
  const out = [];
  const program = parseScriptAst(script, filePath, parserLang);
  if (!program) return out;
  const scopes = collectSvelteScriptBindingScopes(program);
  traverseAstWithAncestors(program, (node, ancestors) => {
    const name = identifierName(node);
    if (!name || !name.startsWith("$") || name.startsWith("$$")) return;
    if (
      isNonReferenceIdentifier(node, ancestors) ||
      isSvelteDollarIdentifierShadowed(name, ancestors, scopes)
    ) {
      return;
    }
    const storeName = name.slice(1);
    const binding = svelteStoreBindingForName(storeName, bindings);
    pushSvelteStoreSubscription({
      out,
      seen,
      storeName,
      binding,
      filePath,
      line: lineOf(fileSource, startOffset + (node.start ?? 0)),
      blockKind,
    });
  });
  return out;
}

function parseSvelteStoreSubscriptionsInTemplate(
  template,
  { filePath, fileSource, startOffset, blockKind, bindings, seen },
) {
  const out = [];
  const cleaned = stripHtmlComments(template);
  const expressionRe = /\{([^{}]*)\}/g;
  let expressionMatch;
  while ((expressionMatch = expressionRe.exec(cleaned))) {
    const expression = expressionMatch[1] ?? "";
    const storeRe = /\$(?!\$)([A-Za-z_$][\w$]*)/g;
    let storeMatch;
    while ((storeMatch = storeRe.exec(expression))) {
      const storeName = storeMatch[1];
      const binding = svelteStoreBindingForName(storeName, bindings);
      pushSvelteStoreSubscription({
        out,
        seen,
        storeName,
        binding,
        filePath,
        line: lineOf(
          fileSource,
          startOffset + expressionMatch.index + 1 + storeMatch.index,
        ),
        blockKind,
      });
    }
  }
  return out;
}

function parseUnpluginVueComponentsConfig(src, filePath) {
  const program = parseScriptAst(src, filePath, parserLangFromFile(filePath));
  if (!program) return [];

  const bindings = new Map();
  for (const node of program.body ?? []) {
    if (node?.type !== "ImportDeclaration") continue;
    const fromSpec = node.source?.value;
    if (!isUnpluginVueComponentsSpec(fromSpec)) continue;
    if (node.importKind === "type") continue;
    for (const specifier of node.specifiers ?? []) {
      if (specifier.importKind === "type") continue;
      if (
        specifier.type !== "ImportDefaultSpecifier" &&
        specifier.type !== "ImportSpecifier"
      ) {
        continue;
      }
      const pluginName = importLocalName(specifier);
      if (pluginName) bindings.set(pluginName, fromSpec);
    }
  }
  for (const node of program.body ?? []) {
    if (node?.type !== "VariableDeclaration") continue;
    for (const declaration of node.declarations ?? []) {
      const pluginName = identifierName(declaration.id);
      if (!pluginName) continue;
      const fromSpec = unpluginRequireSource(declaration.init);
      if (fromSpec) bindings.set(pluginName, fromSpec);
    }
  }
  const out = [];
  const seen = new Set();
  traverseAst(program, (node) => {
    if (node?.type !== "CallExpression") return;
    const directRequireSpec = unpluginRequireSource(node.callee);
    const pluginName = directRequireSpec
      ? "require"
      : identifierName(node.callee);
    const fromSpec = directRequireSpec ?? bindings.get(pluginName);
    if (!pluginName || !fromSpec) return;
    const key = `${pluginName}|${node.start ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(
      unpluginConfigRecord({
        filePath,
        pluginName,
        fromSpec,
        line: lineOf(src, node.start ?? 0),
      }),
    );
  });

  return out;
}

function collectUnpluginVueComponentsConfigs(root) {
  const out = [];
  for (const relPath of UNPLUGIN_COMPONENT_CONFIGS) {
    const filePath = path.join(root, relPath);
    if (!existsSync(filePath)) continue;
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    out.push(...parseUnpluginVueComponentsConfig(src, filePath));
  }
  return out;
}

function generatedManifestImportSource(node) {
  const annotation = node?.typeAnnotation?.typeAnnotation;
  if (annotation?.type !== "TSIndexedAccessType") return null;

  const indexLiteral = annotation.indexType?.literal;
  if (indexLiteral?.type !== "Literal" || indexLiteral.value !== "default") {
    return null;
  }

  const objectType = annotation.objectType;
  const importType =
    objectType?.type === "TSTypeQuery" ? objectType.exprName : null;
  const source = importType?.type === "TSImportType" ? importType.source : null;
  return typeof source?.value === "string" ? source.value : null;
}

function generatedManifestRawImportSource(node) {
  const annotation = node?.typeAnnotation?.typeAnnotation;
  if (annotation?.type !== "TSIndexedAccessType") return null;
  const objectType = annotation.objectType;
  const importType =
    objectType?.type === "TSTypeQuery" ? objectType.exprName : null;
  const source = importType?.type === "TSImportType" ? importType.source : null;
  return typeof source?.value === "string" ? source.value : null;
}

function generatedComponentManifestRecord({
  manifestFile,
  manifestKind,
  componentName,
  fromSpec,
  status = null,
  reason = null,
  normalizedTagNames = null,
  computedKeySource = null,
  line,
}) {
  return {
    manifestFile,
    manifestKind,
    componentName,
    normalizedTagNames:
      normalizedTagNames ?? normalizedGlobalComponentNames(componentName),
    ...(fromSpec ? { bindingSource: fromSpec, fromSpec } : {}),
    ...(computedKeySource ? { computedKeySource } : {}),
    source: "sfc-framework-generated-manifest",
    confidence: "generated-manifest-availability",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    ...(status ? { status } : {}),
    ...(reason ? { reason } : {}),
    line,
  };
}

function parseGeneratedComponentManifestInterface(
  node,
  { manifestFile, manifestKind, fileSource },
) {
  const out = [];
  if (node?.type !== "TSInterfaceDeclaration") return out;
  if (identifierName(node.id) !== "GlobalComponents") return out;

  for (const property of node.body?.body ?? []) {
    if (property?.type !== "TSPropertySignature") continue;
    const propertyName = astPropertyName(property);
    const componentName =
      propertyName ?? (property.computed ? "[computed]" : null);
    if (!componentName) continue;
    const fromSpec = generatedManifestImportSource(property);
    const rawFromSpec = fromSpec ?? generatedManifestRawImportSource(property);
    if (rawFromSpec && !isRelativeSourceSpec(rawFromSpec)) continue;
    if (property.computed || !fromSpec) {
      out.push(
        generatedComponentManifestRecord({
          manifestFile,
          manifestKind,
          componentName,
          fromSpec: rawFromSpec,
          status: "skipped",
          reason: "sfc-framework-generated-manifest-nonliteral",
          normalizedTagNames: [],
          computedKeySource: computedPropertySource(property, fileSource),
          line: lineOf(fileSource, property.start ?? 0),
        }),
      );
      continue;
    }
    if (!isRelativeSourceSpec(fromSpec)) continue;
    out.push(
      generatedComponentManifestRecord({
        manifestFile,
        manifestKind,
        componentName,
        fromSpec,
        line: lineOf(fileSource, property.start ?? 0),
      }),
    );
  }

  return out;
}

function parseGeneratedComponentManifestProgram(
  program,
  { manifestFile, manifestKind, fileSource },
) {
  const out = [];
  for (const node of program.body ?? []) {
    if (node?.type !== "TSModuleDeclaration") continue;
    const moduleName =
      node.id?.type === "Literal" && typeof node.id.value === "string"
        ? node.id.value
        : identifierName(node.id);
    if (moduleName !== "vue") continue;
    traverseAst(node.body, (candidate) => {
      if (candidate?.type === "TSInterfaceDeclaration") {
        out.push(
          ...parseGeneratedComponentManifestInterface(candidate, {
            manifestFile,
            manifestKind,
            fileSource,
          }),
        );
      }
    });
  }
  return out;
}

function parseGlobalComponentRegistrations(program, { filePath, fileSource }) {
  const out = [];
  const imports = collectImportBindings(program, fileSource);
  const receivers = collectVueComponentReceivers(program);
  if (receivers.size === 0) return out;

  traverseAst(program, (node) => {
    if (node?.type !== "CallExpression") return;
    const callee = node.callee;
    if (callee?.type !== "MemberExpression") return;
    if (memberPropertyName(callee) !== "component") return;
    const receiverName = identifierName(callee.object);
    if (!receiverName || !receivers.has(receiverName)) return;

    const args = node.arguments ?? [];
    const componentName = literalStringValue(args[0]);
    const asyncFactory = defineAsyncComponentFactory(args[1]);
    const bindingName = identifierName(args[1]);
    const binding = bindingName ? imports.get(bindingName) : null;
    const line = lineOf(fileSource, node.start);
    const api = `${receiverName}.component`;

    if (!componentName) {
      if (!binding) return;
      out.push(
        globalRegistrationRecord({
          filePath,
          api,
          binding,
          line,
          status: "muted",
          reason: "sfc-global-component-name-dynamic",
        }),
      );
      return;
    }

    if (asyncFactory) {
      out.push(
        globalRegistrationRecord({
          filePath,
          api,
          componentName,
          fromSpec: asyncFactory.fromSpec,
          factoryKind: asyncFactory.factoryKind,
          line,
          status: "muted",
          reason: asyncFactory.fromSpec
            ? "sfc-global-component-async-factory"
            : "sfc-global-component-async-factory-nonliteral",
        }),
      );
      return;
    }

    if (!binding) {
      out.push(
        globalRegistrationRecord({
          filePath,
          api,
          componentName,
          line,
          status: "muted",
          reason: "sfc-global-component-value-unsupported",
        }),
      );
      return;
    }

    out.push(
      globalRegistrationRecord({
        filePath,
        api,
        componentName,
        binding,
        line,
      }),
    );
  });

  return markDuplicateGlobalRegistrations(out);
}

function collectComponentRegistrations(program) {
  const out = new Map();
  for (const node of program.body ?? []) {
    if (node?.type !== "ExportDefaultDeclaration") continue;
    const declaration = node.declaration;
    if (declaration?.type !== "ObjectExpression") continue;
    for (const prop of declaration.properties ?? []) {
      if (prop?.type !== "Property") continue;
      if (astPropertyName(prop) !== "components") continue;
      if (prop.value?.type !== "ObjectExpression") continue;
      for (const componentProp of prop.value.properties ?? []) {
        if (componentProp?.type !== "Property") continue;
        const tagName = astPropertyName(componentProp);
        const bindingName =
          componentProp.value?.type === "Identifier"
            ? componentProp.value.name
            : null;
        if (tagName && bindingName) out.set(tagName, bindingName);
      }
    }
  }
  return out;
}

function collectScriptComponentBindings(src, filePath) {
  const imports = new Map();
  const namespaceImports = new Map();
  const exposedNames = new Map();
  const localActions = new Map();
  const localStores = new Map();
  const lang = sfcLanguageForFile(filePath);

  for (const block of extractScriptBlocks(src, filePath)) {
    const program = parseScriptAst(block.content, filePath, block.parserLang);
    if (!program) continue;
    const blockImports = new Map();
    const blockNamespaceImports = new Map();

    for (const node of program.body ?? []) {
      if (node?.type !== "ImportDeclaration") continue;
      const fromSpec = node.source?.value;
      if (typeof fromSpec !== "string" || fromSpec.length === 0) continue;
      if (node.importKind === "type") continue;
      for (const specifier of node.specifiers ?? []) {
        if (specifier.importKind === "type") continue;
        const bindingName = importLocalName(specifier);
        if (!bindingName) continue;
        if (specifier.type === "ImportNamespaceSpecifier") {
          const record = {
            bindingName,
            bindingSource: fromSpec,
            bindingKind: "namespace",
            line: lineOf(src, block.startOffset + node.start),
            sfcBlockKind: block.kind,
          };
          namespaceImports.set(bindingName, record);
          blockNamespaceImports.set(bindingName, record);
          continue;
        }
        if (
          specifier.type !== "ImportDefaultSpecifier" &&
          specifier.type !== "ImportSpecifier"
        ) {
          continue;
        }
        const record = {
          bindingName,
          bindingSource: fromSpec,
          bindingKind:
            specifier.type === "ImportDefaultSpecifier" ? "default" : "named",
          importedName:
            specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : importedName(specifier),
          line: lineOf(src, block.startOffset + node.start),
          sfcBlockKind: block.kind,
        };
        imports.set(bindingName, record);
        blockImports.set(bindingName, record);
      }
    }

    if (lang === "vue" && !block.kind.includes("setup")) {
      const registrations = collectComponentRegistrations(program);
      for (const [tagName, bindingName] of registrations) {
        const record = blockImports.get(bindingName);
        if (record) exposedNames.set(tagName, record);
      }
    } else {
      for (const [bindingName, record] of blockImports) {
        exposedNames.set(bindingName, record);
      }
    }

    for (const [bindingName, record] of blockNamespaceImports) {
      namespaceImports.set(bindingName, record);
    }

    if (lang === "svelte") {
      for (const [bindingName, record] of collectLocalSvelteActionBindings(
        program,
        src,
        block.startOffset,
        filePath,
        block.kind,
      )) {
        localActions.set(bindingName, record);
      }
      for (const [bindingName, record] of collectLocalSvelteStoreBindings(
        program,
        src,
        block.startOffset,
        filePath,
        block.kind,
        blockImports,
      )) {
        localStores.set(bindingName, record);
      }
    }
  }

  return { imports, namespaceImports, exposedNames, localActions, localStores };
}

function pascalFromKebab(value) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(value)) return null;
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function isPascalTag(value) {
  return /^[A-Z][A-Za-z0-9]*$/.test(value);
}

function templateTagCandidates(tagName) {
  if (isPascalTag(tagName)) return [tagName];
  const pascal = pascalFromKebab(tagName);
  return pascal ? [pascal, tagName] : [];
}

function dynamicTemplateBindingName(tagName, attrs) {
  const tag = `${tagName ?? ""}`.toLowerCase();
  if (tag === "component") {
    const match = `${attrs ?? ""}`.match(
      /(?:^|\s)(?::is|v-bind:is)\s*=\s*(?:"([^"]+)"|'([^']+)')/i,
    );
    const value = match?.[1] ?? match?.[2] ?? "";
    return /^[A-Za-z_$][\w$]*$/.test(value) ? value : null;
  }
  if (tag === "svelte:component") {
    const match = `${attrs ?? ""}`.match(
      /\bthis\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/i,
    );
    return match?.[1] ?? null;
  }
  return null;
}

function templateRefRecord({
  filePath,
  tagName,
  normalizedTagName,
  binding,
  line,
  blockKind,
  sfcLanguage,
  templateKind,
  status = "binding",
  reason = null,
  extra = {},
}) {
  return {
    consumerFile: filePath,
    tagName,
    normalizedTagName,
    bindingName: binding.bindingName,
    bindingSource: binding.bindingSource,
    fromSpec: binding.bindingSource,
    bindingKind: binding.bindingKind,
    ...(binding.importedName ? { importedName: binding.importedName } : {}),
    source: "sfc-template-component-ref",
    language: sfcLanguage,
    templateKind,
    confidence: status === "muted" ? "muted-review" : "binding-review",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    status,
    ...(reason ? { reason } : {}),
    line,
    sfcBlockKind: blockKind,
    ...extra,
  };
}

function parseTemplateTags(
  template,
  { filePath, fileSource, startOffset, blockKind, sfcLanguage, bindings },
) {
  const out = [];
  const cleaned = stripHtmlComments(template);
  const tagRe = /<\s*([A-Za-z][A-Za-z0-9.:-]*)([^<>]*?)(?:\/?)>/g;
  let match;
  while ((match = tagRe.exec(cleaned))) {
    const tagName = match[1];
    const attrs = match[2] ?? "";
    const line = lineOf(fileSource, startOffset + match.index);

    const dynamicName = dynamicTemplateBindingName(tagName, attrs);
    if (dynamicName) {
      const binding =
        bindings.imports.get(dynamicName) ??
        bindings.exposedNames.get(dynamicName);
      if (binding) {
        out.push(
          templateRefRecord({
            filePath,
            tagName,
            normalizedTagName: dynamicName,
            binding,
            line,
            blockKind,
            sfcLanguage,
            templateKind: "dynamic-component",
            status: "muted",
            reason: "sfc-template-dynamic-component",
          }),
        );
      }
      continue;
    }

    if (tagName.includes(".")) {
      const [namespaceName, memberName] = tagName.split(".", 2);
      const binding = bindings.namespaceImports.get(namespaceName);
      if (binding && memberName) {
        out.push(
          templateRefRecord({
            filePath,
            tagName,
            normalizedTagName: tagName,
            binding,
            line,
            blockKind,
            sfcLanguage,
            templateKind: "namespace-component-tag",
            status: "muted",
            reason: "sfc-template-namespace-component",
            extra: { memberName },
          }),
        );
      }
      continue;
    }

    for (const candidate of templateTagCandidates(tagName)) {
      const binding = bindings.exposedNames.get(candidate);
      if (!binding) continue;
      out.push(
        templateRefRecord({
          filePath,
          tagName,
          normalizedTagName: candidate,
          binding,
          line,
          blockKind,
          sfcLanguage,
          templateKind: "component-tag",
        }),
      );
      break;
    }
  }
  return out;
}

export function parseSfcImportConsumers(src, filePath = "<sfc>") {
  const out = [];
  for (const block of extractScriptBlocks(src, filePath)) {
    out.push(
      ...parseScriptImportConsumers(block.content, {
        filePath,
        fileSource: src,
        startOffset: block.startOffset,
        blockKind: block.kind,
        parserLang: block.parserLang,
      }),
    );
  }
  return out;
}

export function parseSfcTemplateComponentRefs(src, filePath = "<sfc>") {
  const out = [];
  const bindings = collectScriptComponentBindings(src, filePath);
  for (const block of extractTemplateBlocks(src, filePath)) {
    out.push(
      ...parseTemplateTags(block.content, {
        filePath,
        fileSource: src,
        startOffset: block.startOffset,
        blockKind: block.kind,
        sfcLanguage: block.sfcLanguage,
        bindings,
      }),
    );
  }
  return out;
}

export function parseSfcGlobalComponentRegistrations(
  src,
  filePath = "<source>",
) {
  const program = parseScriptAst(src, filePath, parserLangFromFile(filePath));
  if (!program) return [];
  return parseGlobalComponentRegistrations(program, {
    filePath,
    fileSource: src,
  });
}

export function parseSfcGeneratedComponentManifests(
  src,
  filePath = "<manifest>",
  manifestKind = "unplugin-vue-components-dts",
) {
  const program = parseScriptAst(src, filePath, "ts");
  if (!program) return [];
  return parseGeneratedComponentManifestProgram(program, {
    manifestFile: filePath,
    manifestKind,
    fileSource: src,
  });
}

export function parseSfcScriptSources(src, filePath = "<sfc>") {
  return extractScriptSrcBlocks(src, filePath);
}

export function parseSfcStyleAssetReferences(src, filePath = "<sfc>") {
  const out = [];
  for (const block of extractStyleBlocks(src, filePath)) {
    out.push(
      ...parseStyleAssetReferences(block.content, {
        filePath,
        fileSource: src,
        startOffset: block.startOffset,
        blockKind: block.kind,
        sfcLanguage: block.sfcLanguage,
      }),
    );
  }
  return out;
}

export function collectSfcImportConsumers({
  root,
  includeTests = true,
  exclude = [],
}) {
  const out = [];
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: SFC_FAMILY_LANGS,
  });

  for (const filePath of files) {
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    out.push(
      ...parseSfcImportConsumers(src, filePath).filter(
        (record) => record.fromSpec !== NUXT_COMPONENTS_ALIAS_SPEC,
      ),
    );
  }

  return out;
}

export function collectSfcTemplateComponentRefs({
  root,
  includeTests = true,
  exclude = [],
}) {
  const out = [];
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: SFC_FAMILY_LANGS,
  });

  for (const filePath of files) {
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    out.push(...parseSfcTemplateComponentRefs(src, filePath));
  }

  return out;
}

export function collectSfcGlobalComponentRegistrations({
  root,
  includeTests = true,
  exclude = [],
}) {
  const out = [];
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: JS_FAMILY_LANGS,
  });

  for (const filePath of files) {
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    out.push(...parseSfcGlobalComponentRegistrations(src, filePath));
  }

  return out;
}

export function collectSfcGeneratedComponentManifests({ root }) {
  const out = [];
  for (const manifest of GENERATED_COMPONENT_MANIFESTS) {
    const filePath = path.join(root, manifest.relPath);
    if (!existsSync(filePath)) continue;
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    out.push(
      ...parseSfcGeneratedComponentManifests(
        src,
        filePath,
        manifest.manifestKind,
      ),
    );
  }
  return out;
}

export function collectSfcFrameworkConventionComponents({
  root,
  includeTests = true,
  exclude = [],
}) {
  const out = [];
  const resolvedRoot = path.resolve(root);
  out.push(...collectUnpluginVueComponentsConfigs(resolvedRoot));
  out.push(
    ...collectSfcAstroClientDirectiveConventions({
      root: resolvedRoot,
      includeTests,
      exclude,
    }),
  );
  out.push(
    ...collectSfcSvelteActionDirectiveConventions({
      root: resolvedRoot,
      includeTests,
      exclude,
    }),
  );
  out.push(
    ...collectSfcSvelteStoreSubscriptionConventions({
      root: resolvedRoot,
      includeTests,
      exclude,
    }),
  );
  out.push(
    ...collectSfcVueMacroRegistrationConventions({
      root: resolvedRoot,
      includeTests,
      exclude,
    }),
  );
  out.push(
    ...collectSfcVueOptionsRegistrationConventions({
      root: resolvedRoot,
      includeTests,
      exclude,
    }),
  );
  out.push(
    ...collectSfcNuxtComponentsAliasConventions({
      root: resolvedRoot,
      includeTests,
      exclude,
    }),
  );
  out.push(...collectSfcNuxtComponentsDirConfigConventions({ root: resolvedRoot }));
  out.push(
    ...collectSfcNuxtCustomResolverUnavailableConventions({
      root: resolvedRoot,
    }),
  );
  out.push(
    ...collectSfcNuxtLayerExtendsUnavailableConventions({
      root: resolvedRoot,
    }),
  );
  out.push(
    ...collectSfcNuxtModulePackageUnavailableConventions({
      root: resolvedRoot,
    }),
  );

  if (hasNuxtConventionSignal(resolvedRoot)) {
    const hasAppDirConventionSignal =
      hasNuxtAppDirConventionSignal(resolvedRoot);
    const files = collectFiles(resolvedRoot, {
      includeTests,
      exclude,
      languages: ["vue"],
    });

    for (const filePath of files) {
      const rel = path.relative(resolvedRoot, filePath);
      const conventionRoot = nuxtConventionRootForRelPath(rel);
      if (!conventionRoot) continue;
      if (
        conventionRoot.requiresAppSrcDirSignal &&
        !hasAppDirConventionSignal
      ) {
        continue;
      }
      out.push(
        nuxtConventionRecord({
          root: resolvedRoot,
          filePath,
          conventionRoot,
        }),
      );
    }
  }

  return out;
}

function collectSfcVueOptionsRegistrationConventions({
  root,
  includeTests = true,
  exclude = [],
}) {
  const out = [];
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: ["vue"],
  });

  for (const filePath of files) {
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const block of extractScriptBlocks(src, filePath)) {
      out.push(
        ...parseVueOptionsRegistrations(block.content, {
          filePath,
          fileSource: src,
          startOffset: block.startOffset,
          blockKind: block.kind,
          parserLang: block.parserLang,
        }),
      );
    }
  }

  return out;
}

function collectSfcVueMacroRegistrationConventions({
  root,
  includeTests = true,
  exclude = [],
}) {
  const out = [];
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: ["vue"],
  });

  for (const filePath of files) {
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const block of extractScriptBlocks(src, filePath)) {
      out.push(
        ...parseVueMacroRegistrations(block.content, {
          filePath,
          fileSource: src,
          startOffset: block.startOffset,
          blockKind: block.kind,
          parserLang: block.parserLang,
        }),
      );
    }
  }

  return out;
}

function collectSfcSvelteActionDirectiveConventions({
  root,
  includeTests = true,
  exclude = [],
}) {
  const out = [];
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: ["svelte"],
  });

  for (const filePath of files) {
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const bindings = collectScriptComponentBindings(src, filePath);
    for (const block of extractTemplateBlocks(src, filePath)) {
      if (block.sfcLanguage !== "svelte") continue;
      out.push(
        ...parseSvelteActionDirectiveTags(block.content, {
          filePath,
          fileSource: src,
          startOffset: block.startOffset,
          blockKind: block.kind,
          bindings,
        }),
      );
    }
  }

  return out;
}

function collectSfcSvelteStoreSubscriptionConventions({
  root,
  includeTests = true,
  exclude = [],
}) {
  const out = [];
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: ["svelte"],
  });

  for (const filePath of files) {
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const bindings = collectScriptComponentBindings(src, filePath);
    const seen = new Set();
    for (const block of extractScriptBlocks(src, filePath)) {
      if (!block.kind.startsWith("svelte-")) continue;
      out.push(
        ...parseSvelteStoreSubscriptionsInScript(block.content, {
          filePath,
          fileSource: src,
          startOffset: block.startOffset,
          blockKind: block.kind,
          parserLang: block.parserLang,
          bindings,
          seen,
        }),
      );
    }
    for (const block of extractTemplateBlocks(src, filePath)) {
      if (block.sfcLanguage !== "svelte") continue;
      out.push(
        ...parseSvelteStoreSubscriptionsInTemplate(block.content, {
          filePath,
          fileSource: src,
          startOffset: block.startOffset,
          blockKind: block.kind,
          bindings,
          seen,
        }),
      );
    }
  }

  return out;
}

function collectSfcAstroClientDirectiveConventions({
  root,
  includeTests = true,
  exclude = [],
}) {
  const out = [];
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: ["astro"],
  });

  for (const filePath of files) {
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const bindings = collectScriptComponentBindings(src, filePath);
    for (const block of extractTemplateBlocks(src, filePath)) {
      if (block.sfcLanguage !== "astro") continue;
      out.push(
        ...parseAstroClientDirectiveTags(block.content, {
          filePath,
          fileSource: src,
          startOffset: block.startOffset,
          blockKind: block.kind,
          bindings,
        }),
      );
    }
  }

  return out;
}

export function collectSfcStyleAssetReferences({
  root,
  includeTests = true,
  exclude = [],
}) {
  const out = [];
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: SFC_FAMILY_LANGS,
  });

  for (const filePath of files) {
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    out.push(...parseSfcStyleAssetReferences(src, filePath));
  }

  return out;
}

export function collectSfcScriptSources({
  root,
  includeTests = true,
  exclude = [],
}) {
  const out = [];
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: SFC_FAMILY_LANGS,
  });

  for (const filePath of files) {
    let src;
    try {
      src = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    out.push(...parseSfcScriptSources(src, filePath));
  }

  return out;
}
