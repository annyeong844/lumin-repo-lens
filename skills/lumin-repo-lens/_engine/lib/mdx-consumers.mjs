import { readFileSync } from 'node:fs';
import { collectFiles } from './collect-files.mjs';

function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}

function splitNamedSpecifiers(namedBlock) {
  return namedBlock
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function importedNameFromSpecifier(specifier) {
  const clean = specifier.replace(/^type\s+/, '').trim();
  const match = clean.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?$/);
  return match?.[1] ?? null;
}

function blankExceptNewlines(text) {
  return text.replace(/[^\n]/g, ' ');
}

function maskFencedCodeBlocks(src) {
  let out = '';
  let offset = 0;
  let fence = null;

  while (offset < src.length) {
    const newline = src.indexOf('\n', offset);
    const end = newline === -1 ? src.length : newline + 1;
    const line = src.slice(offset, end);
    const body = line.replace(/\r?\n$/, '');
    const marker = body.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    let mask = false;

    if (fence) {
      mask = true;
      const close = body.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null;
      }
    } else if (marker) {
      mask = true;
      fence = { char: marker[1][0], length: marker[1].length };
    }

    out += mask ? blankExceptNewlines(line) : line;
    offset = end;
  }

  return out;
}

function namespaceImportMatch(runtimeClause) {
  return runtimeClause.match(/(?:^|,\s*)\*\s+as\s+[A-Za-z_$][\w$]*/);
}

function defaultImportName(runtimeClause, namedMatch, namespaceMatch) {
  const cutPoints = [namedMatch?.index, namespaceMatch?.index]
    .filter((i) => Number.isInteger(i));
  const end = cutPoints.length > 0 ? Math.min(...cutPoints) : runtimeClause.length;
  const candidate = runtimeClause.slice(0, end).replace(/,\s*$/, '').trim();
  return /^[A-Za-z_$][\w$]*$/.test(candidate) ? candidate : null;
}

export function parseMdxImportConsumers(src, filePath = '<mdx>') {
  const out = [];
  const importRe = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  let match;
  const importSource = maskFencedCodeBlocks(src);

  while ((match = importRe.exec(importSource))) {
    const clause = match[1].trim();
    const fromSpec = match[2];
    const line = lineOf(src, match.index);
    if (!clause || !fromSpec) continue;

    const isTypeOnly = clause.startsWith('type ');
    const runtimeClause = clause.replace(/^type\s+/, '').trim();
    const namedMatch = runtimeClause.match(/\{([\s\S]*?)\}/);
    const namespaceMatch = namespaceImportMatch(runtimeClause);
    const defaultName = defaultImportName(runtimeClause, namedMatch, namespaceMatch);

    if (defaultName) {
      out.push({
        consumerFile: filePath,
        fromSpec,
        name: 'default',
        kind: 'default',
        typeOnly: isTypeOnly,
        line,
      });
    }

    if (namespaceMatch) {
      out.push({
        consumerFile: filePath,
        fromSpec,
        name: '*',
        kind: 'namespace',
        typeOnly: isTypeOnly,
        line,
      });
    }

    if (namedMatch) {
      for (const specifier of splitNamedSpecifiers(namedMatch[1])) {
        const name = importedNameFromSpecifier(specifier);
        if (!name) continue;
        out.push({
          consumerFile: filePath,
          fromSpec,
          name,
          kind: 'import',
          typeOnly: isTypeOnly || specifier.trim().startsWith('type '),
          line,
        });
      }
    }
  }

  return out;
}

export function collectMdxImportConsumers({ root, includeTests = true, exclude = [] }) {
  const out = [];
  const files = collectFiles(root, {
    includeTests,
    exclude,
    languages: ['mdx'],
  });

  for (const filePath of files) {
    let src;
    try { src = readFileSync(filePath, 'utf8'); } catch { continue; }
    out.push(...parseMdxImportConsumers(src, filePath));
  }

  return out;
}
