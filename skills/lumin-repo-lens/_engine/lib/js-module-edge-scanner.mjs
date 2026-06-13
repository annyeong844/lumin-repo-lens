export const MODULE_EDGE_SCANNER_POLICY_VERSION = 'module-edge-scanner-v1';

const STRING_PLACEHOLDER_RE = /__STR(\d+)__/;

function createLineLookup(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return function lineAtIndex(index) {
    let lo = 0;
    let hi = starts.length - 1;
    const target = Math.max(0, Math.min(index, source.length));
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= target) lo = mid + 1;
      else hi = mid - 1;
    }
    return hi + 1;
  };
}

function previousNonSpace(out) {
  for (let i = out.length - 1; i >= 0; i--) {
    const ch = out[i];
    if (!/\s/.test(ch)) return ch;
  }
  return '';
}

function looksLikeRegexStart(out) {
  const prev = previousNonSpace(out);
  return !prev || /[=(:,[!&|?{};]/.test(prev);
}

function readQuoted(source, start, quote) {
  let value = '';
  let escaped = false;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      value += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === quote) {
      return { end: i + 1, value };
    }
    value += ch;
  }
  return null;
}

function skipRegex(source, start) {
  let escaped = false;
  let inClass = false;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === ']') {
      inClass = false;
      continue;
    }
    if (ch === '/' && !inClass) {
      let end = i + 1;
      while (/[A-Za-z]/.test(source[end] ?? '')) end++;
      return end;
    }
    if (ch === '\n' || ch === '\r') break;
  }
  return null;
}

function readTemplate(source, start) {
  let escaped = false;
  let interpolated = false;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '$' && source[i + 1] === '{') {
      interpolated = true;
      i++;
      continue;
    }
    if (ch === '`') {
      return { end: i + 1, interpolated };
    }
  }
  return null;
}

function addNewlines(out, chunk) {
  return out + String(chunk ?? '').replace(/[^\r\n]/g, ' ');
}

function tokenizeForModuleScanner(source, sourceLineAt) {
  const strings = [];
  const templates = [];
  const risk = new Set();
  let out = '';

  for (let i = 0; i < source.length;) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      if (end < 0) break;
      out = addNewlines(out, source.slice(i, end));
      i = end;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) {
        risk.add('scanner-state-ambiguous');
        break;
      }
      out = addNewlines(out, source.slice(i, end + 2));
      i = end + 2;
      continue;
    }

    if ((ch === '"' || ch === "'")) {
      const read = readQuoted(source, i, ch);
      if (!read) {
        risk.add('scanner-state-ambiguous');
        break;
      }
      const id = strings.length;
      strings.push({ value: read.value, line: sourceLineAt(i) });
      out += `__STR${id}__`;
      i = read.end;
      continue;
    }

    if (ch === '`') {
      const read = readTemplate(source, i);
      if (!read) {
        risk.add('scanner-state-ambiguous');
        break;
      }
      const id = templates.length;
      templates.push({ interpolated: read.interpolated, line: sourceLineAt(i) });
      out += `__TPL${id}__`;
      i = read.end;
      continue;
    }

    if (ch === '/' && looksLikeRegexStart(out)) {
      const end = skipRegex(source, i);
      if (end !== null) {
        out = addNewlines(out, source.slice(i, end)) + '__REGEX__';
        i = end;
        continue;
      }
    }

    if (ch === '<' && /[A-Za-z]/.test(next ?? '')) {
      risk.add('unsupported-syntax');
    }

    out += ch;
    i++;
  }

  return { code: out, strings, templates, risk };
}

function placeholderValue(strings, token) {
  const id = Number(STRING_PLACEHOLDER_RE.exec(token)?.[1]);
  return Number.isInteger(id) ? strings[id]?.value : undefined;
}

function pushEdge(edges, strings, lineAtIndex, matchIndex, token, flags = {}) {
  const source = placeholderValue(strings, token);
  if (typeof source !== 'string') return;
  edges.push({
    source,
    typeOnly: !!flags.typeOnly,
    reExport: !!flags.reExport,
    dynamic: !!flags.dynamic,
    line: lineAtIndex(matchIndex),
  });
}

function collectRisk(code) {
  const risk = new Set();
  if (/\brequire\s*\.\s*context\s*\(/.test(code)) risk.add('require-context');
  if (/\brequire\s*\(/.test(code)) risk.add('require-call');
  if (/\bimport\s*\.\s*meta\s*\.\s*glob\s*\(/.test(code)) risk.add('import-meta-glob');
  if (/\bimport\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(/.test(code)) risk.add('ts-import-equals');
  if (/\bexport\s*=/.test(code)) risk.add('ts-export-assignment');
  if (/\bdeclare\s+module\s+__STR\d+__/.test(code)) risk.add('ts-ambient-module');
  if (/(^|\n)\s*@|Reflect\s*\.\s*metadata\s*\(/.test(code)) risk.add('decorator-or-reflect');
  return risk;
}

function collectDynamicImportEdges({ code, strings, edges, risk, lineAtIndex }) {
  const dynamicRe = /\bimport\s*\(\s*([^)\s,]+)(\s*,)?/g;
  for (const match of code.matchAll(dynamicRe)) {
    const arg = match[1];
    if (match[2]) {
      risk.add('dynamic-import-options');
      continue;
    }
    if (/^__STR\d+__$/.test(arg)) {
      pushEdge(edges, strings, lineAtIndex, match.index ?? 0, arg, { dynamic: true });
      continue;
    }
    if (/^__TPL\d+__$/.test(arg)) {
      risk.add('template-dynamic-import');
      continue;
    }
    risk.add('non-literal-dynamic-import');
  }
}

function collectImportEdges({ code, strings, edges, lineAtIndex }) {
  const importRe = /\bimport\s+(type\s+)?(?:(?:[^;]*?)\s+from\s+)?(__STR\d+__)\s*(?:with\s*\{[\s\S]*?\}|assert\s*\{[\s\S]*?\})?\s*;?/g;
  for (const match of code.matchAll(importRe)) {
    const before = code.slice(Math.max(0, (match.index ?? 0) - 2), match.index ?? 0);
    if (before.endsWith('.') || before.endsWith('(')) continue;
    pushEdge(edges, strings, lineAtIndex, match.index ?? 0, match[2], {
      typeOnly: !!match[1],
    });
  }
}

function allExportSpecifiersTypeOnly(specifierText) {
  const body = String(specifierText ?? '').trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return false;
  return body.slice(1, -1)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .every((item) => item.startsWith('type '));
}

function collectExportEdges({ code, strings, edges, lineAtIndex }) {
  const exportRe = /\bexport\s+(type\s+)?((?:\*)|(?:\{[\s\S]*?\}))\s+from\s+(__STR\d+__)\s*(?:with\s*\{[\s\S]*?\}|assert\s*\{[\s\S]*?\})?\s*;?/g;
  for (const match of code.matchAll(exportRe)) {
    const typeOnly = !!match[1] || allExportSpecifiersTypeOnly(match[2]);
    pushEdge(edges, strings, lineAtIndex, match.index ?? 0, match[3], {
      typeOnly,
      reExport: true,
    });
  }
}

export function scanJsModuleEdgesFast(source, options = {}) {
  const src = String(source ?? '');
  const sourceLineAt = createLineLookup(src);
  const { code, strings, risk } = tokenizeForModuleScanner(src, sourceLineAt);
  const codeLineAt = createLineLookup(code);
  for (const item of collectRisk(code)) risk.add(item);

  const edges = [];
  collectDynamicImportEdges({ code, strings, edges, risk, lineAtIndex: codeLineAt });
  collectImportEdges({ code, strings, edges, lineAtIndex: codeLineAt });
  collectExportEdges({ code, strings, edges, lineAtIndex: codeLineAt });

  if (risk.size > 0) {
    return {
      ok: false,
      mode: 'fallback-required',
      policyVersion: MODULE_EDGE_SCANNER_POLICY_VERSION,
      loc: src.split(/\r?\n/).length,
      edges: [],
      risk: [...risk].sort(),
      ...(options.filename ? { filename: options.filename } : {}),
    };
  }

  return {
    ok: true,
    mode: 'fast-module-edge',
    policyVersion: MODULE_EDGE_SCANNER_POLICY_VERSION,
    loc: src.split(/\r?\n/).length,
    edges,
    risk: [],
    ...(options.filename ? { filename: options.filename } : {}),
  };
}
