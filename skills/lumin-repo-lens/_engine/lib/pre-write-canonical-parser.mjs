// Recognized-schema parser for `canonical/*.md` owner tables.
//
// Consumed by:
//   - pre-write name lookup (canonical-first source, per
//     canonical/pre-write-gate.md §8 + maintainer history notes §5.3)
//   - pre-write drift warning (maintainer history notes §5.9)
//
// Scope is deliberately narrow. Generic markdown owner-table parsing
// would produce false-positive drift on free-form canonical files.
// This parser only trusts tables inside files that carry the generated-
// canon header signature — specifically the one produced by (future)
// `generate-canon-draft.mjs` per maintainer spec notes §6. Anything
// else yields `{ recognized: false }` and the caller skips canonical-
// based evidence entirely.
//
// Inputs:  absolute file path to a canonical markdown file.
// Outputs: { recognized, ownerTables, reason }
//   recognized:  boolean — did this file carry a generated-canon header?
//   ownerTables: Array<{ file, section, rows: Array<{ name, ownerFile, line }> }>
//                 where `line` is the 1-based source line of the row
//   reason:      string — present when recognized === false
//
// All functions are pure — no I/O other than the single `readFileSync`
// on the top-level entry. Unit-tested in tests/test-pre-write-canonical-parser.mjs.

import { readFileSync, existsSync } from 'node:fs';

// Header signature: either a draft-status line or a generated-canon
// source attribution. Matches the maintainer spec notes §6 emission
// pattern exactly. Anything else is treated as free-form canonical.
//
// Using multi-line literal match rather than regex-with-context so a
// comment containing one of these phrases doesn't accidentally qualify.
const HEADER_STATUS_RE = /^>\s*\*\*Status:\*\*\s+draft(,|\s)/m;
const HEADER_SOURCE_RE = /^>\s*\*\*Source:\*\*\s+`?_lib\/extract-ts\.mjs`?\s+pass/m;
const CURRENT_TYPE_OWNERSHIP_DRAFT_RE = /^#\s+Type ownership draft\s*$/m;
const CURRENT_GENERATED_RE = /^Generated:\s+\S+/m;
const CURRENT_SOURCE_RE = /^Source:\s+\S+/m;

function hasGeneratedCanonHeader(text) {
  return HEADER_STATUS_RE.test(text) ||
         HEADER_SOURCE_RE.test(text) ||
         (
           CURRENT_TYPE_OWNERSHIP_DRAFT_RE.test(text) &&
           CURRENT_GENERATED_RE.test(text) &&
           CURRENT_SOURCE_RE.test(text)
         );
}

// Section header pattern — `### 2.1 Single owner (strong)` and siblings.
// We match the broader shape `### <number> <title>` and narrow by title
// keywords that the generator reliably emits.
const SECTION_HEADER_RE = /^###\s+\d+(?:\.\d+)*\s+(.+?)\s*$/;

// Rows we care about start with `| ` and are followed by a backticked
// type name. Example:
//
//   | `SessionId` | `src/protocol/ids.ts` | TSTypeAliasDeclaration | 14 | 8 | ... |
//
// Strict regex on the first two cells so free-form markdown tables don't
// accidentally parse as owner rows.
//
// Capture groups: (typeName)(ownerFile)
const OWNER_ROW_RE = /^\|\s*`([^`|]+)`\s*\|\s*`([^`|]+)`\s*\|/;
const FLAT_OWNER_STATUSES = new Set([
  'single-owner-strong',
  'single-owner-weak',
  'zero-internal-fan-in',
  'low-signal-type-name',
  'severely-any-contaminated',
]);

// The generator's Single-owner tables all start inside sections whose
// heading contains "Single owner" or "severely-any-contaminated". We
// refuse to read rows from DUPLICATE tables (those are group-level, not
// owner-level) or LOCAL_COMMON_NAME (not canon-worthy).
function isOwnerSectionTitle(title) {
  return /\bSingle owner\b/i.test(title) ||
         /severely-any-contaminated/i.test(title);
}

function splitTableRow(line) {
  if (!line.trimStart().startsWith('|')) return null;
  const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
  return cells.length > 0 ? cells : null;
}

function isSeparatorRow(line) {
  return /^\s*\|[\s:|\-]+\|\s*$/.test(line);
}

function stripBackticks(cell) {
  return String(cell ?? '').replace(/^`+|`+$/g, '').trim();
}

function flatTypeOwnershipColumns(cells) {
  if (!Array.isArray(cells)) return null;
  const index = Object.fromEntries(cells.map((cell, i) => [cell, i]));
  const required = ['Name', 'Identity', 'Owner', 'Fan-in', 'Status', 'Tags'];
  if (!required.every((column) => Object.hasOwn(index, column))) return null;
  return index;
}

function ownerFileFromIdentity(identity) {
  const parts = String(identity ?? '').split('::');
  if (parts.length < 2) return null;
  parts.pop();
  return parts.join('::') || null;
}

function buildFlatOwnerClaim(cells, columns, lineNumber) {
  const name = stripBackticks(cells[columns.Name]);
  const identity = stripBackticks(cells[columns.Identity]);
  const status = stripBackticks(cells[columns.Status]).split(/\s+/)[0] ?? '';
  if (!FLAT_OWNER_STATUSES.has(status)) return null;
  const ownerFile = ownerFileFromIdentity(identity);
  if (!name || !ownerFile) return null;
  return { name, ownerFile, line: lineNumber };
}

/**
 * Parse a single canonical markdown file.
 *
 * @param {string} filePath  absolute path to canonical file
 * @returns {{
 *   recognized: boolean,
 *   ownerTables: Array<{
 *     file: string,
 *     section: string,
 *     rows: Array<{ name: string, ownerFile: string, line: number }>
 *   }>,
 *   reason?: string
 * }}
 */
export function parseCanonicalFile(filePath) {
  if (!existsSync(filePath)) {
    return {
      recognized: false,
      ownerTables: [],
      reason: `canonical/${filePath.split(/[\\/]/).pop()} absent`,
    };
  }

  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (e) {
    return {
      recognized: false,
      ownerTables: [],
      reason: `read failed: ${e.message}`,
    };
  }

  if (!hasGeneratedCanonHeader(text)) {
    return {
      recognized: false,
      ownerTables: [],
      reason: 'free-form canon: generated-canon header signature absent',
    };
  }

  const lines = text.split('\n');
  const ownerTables = [];
  let currentSection = null;
  let currentRows = null;
  let flatTable = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (flatTable) {
      if (isSeparatorRow(line)) continue;
      const cells = splitTableRow(line);
      if (!cells) {
        if (flatTable.rows.length > 0) {
          ownerTables.push({
            file: flatTable.file,
            section: flatTable.section,
            rows: flatTable.rows,
          });
        }
        flatTable = null;
      } else {
        const row = buildFlatOwnerClaim(cells, flatTable.columns, i + 1);
        if (row) flatTable.rows.push(row);
      }
      continue;
    }

    const sectionMatch = line.match(SECTION_HEADER_RE);
    if (sectionMatch) {
      if (currentRows && currentRows.length > 0) {
        ownerTables.push({
          file: filePath,
          section: currentSection,
          rows: currentRows,
        });
      }
      const title = sectionMatch[1];
      if (isOwnerSectionTitle(title)) {
        currentSection = title;
        currentRows = [];
      } else {
        currentSection = null;
        currentRows = null;
      }
      continue;
    }

    const flatColumns = flatTypeOwnershipColumns(splitTableRow(line));
    if (flatColumns) {
      if (currentRows && currentRows.length > 0) {
        ownerTables.push({
          file: filePath,
          section: currentSection,
          rows: currentRows,
        });
      }
      currentSection = null;
      currentRows = null;
      flatTable = {
        file: filePath,
        section: 'Type ownership table',
        columns: flatColumns,
        rows: [],
      };
      continue;
    }

    if (!currentRows) continue;

    const rowMatch = line.match(OWNER_ROW_RE);
    if (!rowMatch) continue;

    // Skip the header separator row (| Type | Owner | ...) and the
    // markdown alignment row (|---|---|). Both fail `[^`|]+` matching
    // in the first capture because they don't start with a backticked
    // cell, so they fall out naturally.
    currentRows.push({
      name: rowMatch[1],
      ownerFile: rowMatch[2],
      line: i + 1,
    });
  }

  if (currentRows && currentRows.length > 0) {
    ownerTables.push({
      file: filePath,
      section: currentSection,
      rows: currentRows,
    });
  }
  if (flatTable && flatTable.rows.length > 0) {
    ownerTables.push({
      file: flatTable.file,
      section: flatTable.section,
      rows: flatTable.rows,
    });
  }

  return { recognized: true, ownerTables };
}

/**
 * Find a name in all parsed owner tables, returning the first match.
 * Canonical-first lookup consumer (pre-write name lookup step 2).
 *
 * @param {Array<{file, section, rows}>} ownerTables
 * @param {string} name
 * @returns {{ ownerFile: string, line: number, file: string, section: string } | null}
 */
export function findCanonicalOwnerClaim(ownerTables, name) {
  for (const table of ownerTables) {
    for (const row of table.rows) {
      if (row.name === name) {
        return {
          ownerFile: row.ownerFile,
          line: row.line,
          file: table.file,
          section: table.section,
        };
      }
    }
  }
  return null;
}
