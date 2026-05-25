import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import { collectFiles } from './collect-files.mjs';
import { SFC_FAMILY_LANGS } from './lang.mjs';

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
  const match = `${attrs ?? ''}`.match(
    /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i,
  );
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? '';
}

function isRelativeSourceSpec(spec) {
  return typeof spec === 'string' &&
    (spec.startsWith('./') || spec.startsWith('../'));
}

function parserLangFromAttrs(attrs) {
  const match = `${attrs ?? ''}`.match(/\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i);
  const raw = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').toLowerCase();
  if (raw === 'tsx') return 'tsx';
  if (raw === 'jsx') return 'jsx';
  if (raw === 'js' || raw === 'javascript') return 'js';
  return 'ts';
}

function sfcLanguageForFile(filePath) {
  return path.extname(filePath).replace(/^\./, '').toLowerCase();
}

function extractScriptBlocks(src, filePath) {
  const lang = sfcLanguageForFile(filePath);
  if (lang === 'astro') return extractAstroFrontmatter(src);
  if (lang !== 'vue' && lang !== 'svelte') return [];

  const blocks = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(src))) {
    const attrs = match[1] ?? '';
    if (attrsHaveSrc(attrs)) continue;
    const contentStart = match.index + match[0].indexOf(match[2]);
    blocks.push({
      content: match[2],
      startOffset: contentStart,
      kind: lang === 'vue' && /\bsetup\b/i.test(attrs)
        ? 'vue-script-setup'
        : `${lang}-script`,
      parserLang: parserLangFromAttrs(attrs),
    });
  }
  return blocks;
}

function extractScriptSrcBlocks(src, filePath) {
  const lang = sfcLanguageForFile(filePath);
  if (lang !== 'vue' && lang !== 'svelte') return [];

  const blocks = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(src))) {
    const attrs = match[1] ?? '';
    const fromSpec = srcAttrValue(attrs);
    if (!isRelativeSourceSpec(fromSpec)) continue;
    blocks.push({
      consumerFile: filePath,
      fromSpec,
      name: '*',
      kind: 'sfc-script-src',
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
  if (lang !== 'vue' && lang !== 'svelte' && lang !== 'astro') return [];

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

  return [{
    content: src.slice(open[0].length, close.index),
    startOffset: open[0].length,
    kind: 'astro-frontmatter',
    parserLang: 'ts',
  }];
}

function parseScriptAst(script, filePath, parserLang) {
  const candidates = [parserLang || 'ts'];
  if (parserLang === 'ts') candidates.push('tsx');
  if (parserLang === 'js') candidates.push('jsx');
  if (!candidates.includes('ts')) candidates.push('ts');

  for (const lang of candidates) {
    if (!['ts', 'tsx', 'js', 'jsx'].includes(lang)) continue;
    try {
      const result = parseSync(filePath, script, {
        sourceType: 'module',
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
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

function parseCssQuotedValue(src, index) {
  const quote = src[index];
  let i = index + 1;
  let value = '';
  while (i < src.length) {
    if (src[i] === '\\') {
      if (i + 1 < src.length) value += src[i + 1];
      i += 2;
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
  if (isCssIdentChar(src[index - 1] ?? '') || isCssIdentChar(src[i] ?? '')) return null;
  i = skipCssWhitespace(src, i);
  if (src[i] !== '(') return null;
  i = skipCssWhitespace(src, i + 1);

  let value = '';
  if (src[i] === '"' || src[i] === "'") {
    const parsed = parseCssQuotedValue(src, i);
    if (!parsed) return null;
    value = parsed.value;
    i = skipCssWhitespace(src, parsed.end);
    if (src[i] !== ')') return null;
    return { value: value.trim(), end: i + 1 };
  }

  while (i < src.length && src[i] !== ')') {
    value += src[i];
    i++;
  }
  if (src[i] !== ')') return null;
  return { value: value.trim(), end: i + 1 };
}

function parseCssImportValue(src, index) {
  let i = index + '@import'.length;
  if (isCssIdentChar(src[i] ?? '')) return null;
  i = skipCssWhitespace(src, i);

  if (src.slice(i, i + 3).toLowerCase() === 'url') {
    const parsed = parseCssUrlFunction(src, i);
    return parsed ? { ...parsed, importSyntax: 'url' } : null;
  }

  if (src[i] === '"' || src[i] === "'") {
    const parsed = parseCssQuotedValue(src, i);
    return parsed ? { ...parsed, value: parsed.value.trim(), importSyntax: 'string' } : null;
  }

  return null;
}

function parseStyleAssetReferences(style, {
  filePath,
  fileSource,
  startOffset,
  blockKind,
  sfcLanguage,
}) {
  const out = [];
  let i = 0;
  while (i < style.length) {
    if (style[i] === '/' && style[i + 1] === '*') {
      const end = style.indexOf('*/', i + 2);
      i = end >= 0 ? end + 2 : style.length;
      continue;
    }

    if (style[i] === '"' || style[i] === "'") {
      i = skipCssString(style, i);
      continue;
    }

    if (style[i] === '@' && style.slice(i, i + '@import'.length).toLowerCase() === '@import') {
      const parsed = parseCssImportValue(style, i);
      if (parsed) {
        if (isRelativeSourceSpec(parsed.value)) {
          out.push({
            consumerFile: filePath,
            fromSpec: parsed.value,
            kind: 'sfc-style-import',
            source: 'sfc-style-import',
            styleKind: 'import',
            importSyntax: parsed.importSyntax,
            confidence: 'grounded-asset-reference',
            line: lineOf(fileSource, startOffset + i),
            sfcBlockKind: blockKind,
            sfcLanguage,
          });
        }
        i = parsed.end;
        continue;
      }
    }

    if (style.slice(i, i + 3).toLowerCase() === 'url') {
      const parsed = parseCssUrlFunction(style, i);
      if (parsed) {
        if (isRelativeSourceSpec(parsed.value)) {
          out.push({
            consumerFile: filePath,
            fromSpec: parsed.value,
            kind: 'sfc-style-url',
            source: 'sfc-style-url',
            styleKind: 'url',
            confidence: 'grounded-asset-reference',
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

function parseScriptImportConsumers(script, {
  filePath,
  fileSource,
  startOffset,
  blockKind,
  parserLang,
}) {
  const out = [];
  const program = parseScriptAst(script, filePath, parserLang);
  if (!program) return out;

  for (const node of program.body ?? []) {
    if (node?.type !== 'ImportDeclaration') continue;
    const fromSpec = node.source?.value;
    if (typeof fromSpec !== 'string' || fromSpec.length === 0) continue;
    const line = lineOf(fileSource, startOffset + node.start);
    const declarationTypeOnly = node.importKind === 'type';
    if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) {
      out.push({
        consumerFile: filePath,
        fromSpec,
        name: '*',
        kind: 'import-side-effect',
        typeOnly: false,
        line,
        sfcBlockKind: blockKind,
      });
      continue;
    }

    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportDefaultSpecifier') {
        out.push({
          consumerFile: filePath,
          fromSpec,
          name: 'default',
          kind: 'default',
          typeOnly: declarationTypeOnly,
          line,
          sfcBlockKind: blockKind,
        });
      } else if (specifier.type === 'ImportNamespaceSpecifier') {
        out.push({
          consumerFile: filePath,
          fromSpec,
          name: '*',
          kind: 'namespace',
          typeOnly: declarationTypeOnly,
          line,
          sfcBlockKind: blockKind,
        });
      } else if (specifier.type === 'ImportSpecifier') {
        const name = importedName(specifier);
        if (name) {
          out.push({
            consumerFile: filePath,
            fromSpec,
            name,
            kind: 'import',
            typeOnly: declarationTypeOnly || specifier.importKind === 'type',
            line,
            sfcBlockKind: blockKind,
          });
        }
      }
    }
  }

  return out;
}

export function parseSfcImportConsumers(src, filePath = '<sfc>') {
  const out = [];
  for (const block of extractScriptBlocks(src, filePath)) {
    out.push(...parseScriptImportConsumers(block.content, {
      filePath,
      fileSource: src,
      startOffset: block.startOffset,
      blockKind: block.kind,
      parserLang: block.parserLang,
    }));
  }
  return out;
}

export function parseSfcScriptSources(src, filePath = '<sfc>') {
  return extractScriptSrcBlocks(src, filePath);
}

export function parseSfcStyleAssetReferences(src, filePath = '<sfc>') {
  const out = [];
  for (const block of extractStyleBlocks(src, filePath)) {
    out.push(...parseStyleAssetReferences(block.content, {
      filePath,
      fileSource: src,
      startOffset: block.startOffset,
      blockKind: block.kind,
      sfcLanguage: block.sfcLanguage,
    }));
  }
  return out;
}

export function collectSfcImportConsumers({ root, includeTests = true, exclude = [] }) {
  const out = [];
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: SFC_FAMILY_LANGS,
  });

  for (const filePath of files) {
    let src;
    try { src = readFileSync(filePath, 'utf8'); } catch { continue; }
    out.push(...parseSfcImportConsumers(src, filePath));
  }

  return out;
}

export function collectSfcStyleAssetReferences({ root, includeTests = true, exclude = [] }) {
  const out = [];
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: SFC_FAMILY_LANGS,
  });

  for (const filePath of files) {
    let src;
    try { src = readFileSync(filePath, 'utf8'); } catch { continue; }
    out.push(...parseSfcStyleAssetReferences(src, filePath));
  }

  return out;
}

export function collectSfcScriptSources({ root, includeTests = true, exclude = [] }) {
  const out = [];
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: SFC_FAMILY_LANGS,
  });

  for (const filePath of files) {
    let src;
    try { src = readFileSync(filePath, 'utf8'); } catch { continue; }
    out.push(...parseSfcScriptSources(src, filePath));
  }

  return out;
}
