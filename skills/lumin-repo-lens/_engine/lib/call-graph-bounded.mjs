function nameOfId(node) {
  return node?.name ?? node?.value ?? null;
}

export function staticMemberPropertyName(node) {
  const property = node?.property ?? node?.key;
  if (!property) return null;
  if (!node?.computed) return nameOfId(property);
  return typeof property.value === 'string' ? property.value : null;
}

function bindingName(pattern) {
  return pattern?.type === 'Identifier' ? pattern.name : null;
}

function isFunctionExpression(node) {
  return node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression';
}

function collectLocalFunctionNames(program) {
  const out = new Set();
  for (const node of program.body ?? []) {
    const declaration = node.type === 'ExportNamedDeclaration' && node.declaration
      ? node.declaration
      : node;

    if (declaration?.type === 'FunctionDeclaration' && declaration.id?.name) {
      out.add(declaration.id.name);
      continue;
    }

    if (declaration?.type !== 'VariableDeclaration') continue;
    for (const decl of declaration.declarations ?? []) {
      const name = bindingName(decl.id);
      if (name && isFunctionExpression(decl.init)) out.add(name);
    }
  }
  return out;
}

function objectPropertyCallee(prop, localFunctionNames) {
  if (prop?.type !== 'Property' || prop.kind !== 'init') return null;
  const propertyName = staticMemberPropertyName(prop);
  if (!propertyName) return null;

  const value = prop.value;
  if (value?.type === 'Identifier' && localFunctionNames.has(value.name)) {
    return { name: propertyName, calleeName: value.name, kind: 'identifier' };
  }
  if (isFunctionExpression(value)) {
    return { name: propertyName, calleeName: propertyName, kind: 'inline-function' };
  }
  return null;
}

function objectMapFromExpression(expr, localFunctionNames) {
  if (expr?.type !== 'ObjectExpression') return null;
  const out = new Map();
  for (const prop of expr.properties ?? []) {
    const entry = objectPropertyCallee(prop, localFunctionNames);
    if (entry) out.set(entry.name, entry);
  }
  return out.size > 0 ? out : null;
}

function collectLocalObjectMaps(program, localFunctionNames) {
  const out = new Map();
  for (const node of program.body ?? []) {
    const declaration = node.type === 'ExportNamedDeclaration' && node.declaration
      ? node.declaration
      : node;
    if (declaration?.type !== 'VariableDeclaration') continue;
    for (const decl of declaration.declarations ?? []) {
      const name = bindingName(decl.id);
      const objectMap = objectMapFromExpression(decl.init, localFunctionNames);
      if (name && objectMap) out.set(name, objectMap);
    }
  }
  return out;
}

export function buildExportedObjectMaps(program) {
  const localFunctionNames = collectLocalFunctionNames(program);
  const localObjects = collectLocalObjectMaps(program, localFunctionNames);
  const out = new Map();

  for (const node of program.body ?? []) {
    if (node.type === 'ExportDefaultDeclaration') {
      const objectMap = objectMapFromExpression(node.declaration, localFunctionNames);
      if (objectMap) out.set('default', objectMap);
      continue;
    }

    if (node.type !== 'ExportNamedDeclaration' || node.source) continue;

    if (node.declaration?.type === 'VariableDeclaration') {
      for (const decl of node.declaration.declarations ?? []) {
        const name = bindingName(decl.id);
        const objectMap = objectMapFromExpression(decl.init, localFunctionNames);
        if (name && objectMap) out.set(name, objectMap);
      }
      continue;
    }

    for (const spec of node.specifiers ?? []) {
      if (spec.type !== 'ExportSpecifier') continue;
      const exportedName = nameOfId(spec.exported) ?? nameOfId(spec.local);
      const localName = nameOfId(spec.local) ?? exportedName;
      const objectMap = localObjects.get(localName);
      if (exportedName && objectMap) out.set(exportedName, objectMap);
    }
  }

  return out;
}
