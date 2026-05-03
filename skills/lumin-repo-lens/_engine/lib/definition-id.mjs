// Canonical definition identity shared by producers.
//
// The id intentionally uses byte offsets instead of line numbers so multiple
// declarations on one line or minified-ish source cannot collide.

function makeDefinitionId(file, nodeKind, startOffset, endOffset) {
  const normalizedFile = String(file ?? '').replace(/\\/g, '/');
  return `${normalizedFile}#${nodeKind}:${startOffset}-${endOffset}`;
}

export function definitionIdFromOxcNode(file, node) {
  if (!node || typeof node.type !== 'string') return null;
  if (typeof node.start !== 'number' || typeof node.end !== 'number') return null;
  return makeDefinitionId(file, node.type, node.start, node.end);
}
