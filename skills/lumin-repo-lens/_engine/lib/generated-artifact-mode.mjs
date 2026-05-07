export const GENERATED_ARTIFACT_MODES = new Set(['default', 'present', 'prepared']);

export function normalizeGeneratedArtifactsMode(value = 'default') {
  const mode = String(value ?? 'default').trim() || 'default';
  if (!GENERATED_ARTIFACT_MODES.has(mode)) {
    throw new Error(`unsupported --generated-artifacts mode: ${mode}. Use default|present|prepared.`);
  }
  return mode;
}
