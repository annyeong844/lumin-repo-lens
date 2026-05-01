// Line-offset lookup: O(L) once + O(log L) per query.
//
// oxc-parser returns AST nodes with byte-offset positions (`node.start`)
// but not line numbers. Computing lines naively — scanning `\n` from 0
// on every query — degrades to O(N × avg_offset) per file, which is
// O(L²) in the worst case. For a 3k-LOC file with hundreds of AST
// nodes we measured tens of millions of inner-loop iterations.
//
// This helper builds a `lineStarts` array once and does binary search
// on it. Same interface is used by build-symbol-graph.mjs,
// check-barrel-discipline.mjs, and (future) any other parse-and-walk
// consumer.
//
// Usage:
//   const starts = computeLineStarts(src);
//   const line = lineOf(starts, node.start);

export function computeLineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    // charCodeAt is ~3x faster than indexing+compare in V8 for ASCII-heavy
    // source files and is correct for all UTF-8 — \n is 0x0A in all cases.
    if (src.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

export function lineOf(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
