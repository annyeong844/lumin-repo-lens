import { readFileSync } from "node:fs";
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
  line,
  status = "registration-syntax",
  reason = null,
}) {
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
          fromSpec: binding.bindingSource,
          bindingKind: binding.bindingKind,
          ...(binding.importedName
            ? { importedName: binding.importedName }
            : {}),
        }
      : {}),
    source: "sfc-global-component-registration",
    status,
    confidence: status === "muted" ? "muted-review" : "registration-review",
    eligibleForFanIn: false,
    eligibleForSafeFix: false,
    ...(reason ? { reason } : {}),
    line,
  };
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

  return out;
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
  }

  return { imports, namespaceImports, exposedNames };
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
    out.push(...parseSfcImportConsumers(src, filePath));
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
