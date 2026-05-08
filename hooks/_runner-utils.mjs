import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');

export function readJsonFromStdin() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return null;
  }
  if (raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function emitHookOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return;
  writeFileSync(1, `${JSON.stringify(output)}\n`);
}

export async function importEngineModule(name) {
  const candidates = [
    path.join(PLUGIN_ROOT, '_lib', name),
    path.join(PLUGIN_ROOT, 'skills', 'lumin-repo-lens', '_engine', 'lib', name),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    return import(pathToFileURL(file).href);
  }
  throw new Error(`engine module not found: ${name}`);
}

export async function runHookMain(fn) {
  try {
    await fn();
  } catch {
    // Hooks are advisory. Unexpected failures must not block the host action.
  } finally {
    process.exitCode = 0;
  }
}
