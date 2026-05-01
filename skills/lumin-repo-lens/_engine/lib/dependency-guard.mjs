import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const NODE_ENGINE = '^20.19.0 || >=22.12.0';
const REQUIRED_PACKAGES = [
  '@vscode/tree-sitter-wasm',
  'oxc-parser',
  'typescript',
  'web-tree-sitter',
];

class RuntimeSetupError extends Error {
  constructor(message, { exitCode = 2, details = [] } = {}) {
    super(message);
    this.name = 'RuntimeSetupError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

function parseNodeVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return { major, minor, patch };
}

function isSupportedNodeVersion(version = process.versions.node) {
  const { major, minor } = parseNodeVersion(version);
  if (major === 20) return minor >= 19;
  if (major === 22) return minor >= 12;
  return major > 22;
}

function readPackageJson(packageRoot) {
  try {
    return JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function findRuntimePackageRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    const pkg = readPackageJson(current);
    const deps = pkg?.dependencies ?? {};
    if (
      pkg &&
      REQUIRED_PACKAGES.every((name) => Object.hasOwn(deps, name))
    ) {
      return { packageRoot: current, packageJson: pkg };
    }

    const parent = path.dirname(current);
    if (parent === current) return { packageRoot: null, packageJson: null };
    current = parent;
  }
}

async function checkPackageAvailability(packageRoot) {
  const requireFromRoot = createRequire(path.join(packageRoot, 'package.json'));
  const missing = [];

  for (const spec of REQUIRED_PACKAGES) {
    try {
      requireFromRoot.resolve(spec);
    } catch (error) {
      missing.push({ spec, reason: error?.message ?? 'not resolvable' });
    }
  }

  if (!missing.some((entry) => entry.spec === 'oxc-parser')) {
    try {
      const oxc = await import(pathToFileURL(requireFromRoot.resolve('oxc-parser')).href);
      if (typeof oxc.parseSync !== 'function') {
        missing.push({ spec: 'oxc-parser', reason: 'parseSync export missing' });
      }
    } catch (error) {
      missing.push({ spec: 'oxc-parser', reason: error?.message ?? 'native binding unavailable' });
    }
  }

  return missing;
}

function npmInvocation(args) {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm', ...args],
    };
  }
  return { command: 'npm', args };
}

function installArgsFor(packageJson) {
  if (isGeneratedSkillPackage(packageJson)) {
    return ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--fund=false'];
  }
  return ['ci'];
}

function isGeneratedSkillPackage(packageJson) {
  return packageJson?.luminRepoLens?.distribution === 'skill' ||
    packageJson?.name === 'lumin-repo-lens-skill';
}

function quotePathForDisplay(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function setupCommandFor(packageRoot, packageJson) {
  return [
    `cd ${quotePathForDisplay(packageRoot)}`,
    `npm ${installArgsFor(packageJson).join(' ')}`,
  ];
}

function formatMissing(missing) {
  return missing
    .map((entry) => `  - ${entry.spec}: ${String(entry.reason).split('\n')[0]}`)
    .join('\n');
}

function autoInstallDisabledBy() {
  if (process.env.LUMIN_REPO_LENS_NO_AUTO_INSTALL === '1') {
    return 'LUMIN_REPO_LENS_NO_AUTO_INSTALL';
  }
  return null;
}

function shouldAutoInstall() {
  return autoInstallDisabledBy() === null;
}

function runNpmInstall(packageRoot, packageJson, commandName) {
  const args = installArgsFor(packageJson);
  const setupKind = isGeneratedSkillPackage(packageJson)
    ? 'first-run skill setup'
    : 'runtime setup';
  process.stderr.write(
    `[${commandName}] ${setupKind}: installing parser dependencies with npm ${args.join(' ')}.\n` +
    `[${commandName}] This runs locally in ${packageRoot}. ` +
    'Set LUMIN_REPO_LENS_NO_AUTO_INSTALL=1 to skip and run setup manually.\n',
  );
  const npm = npmInvocation(args);
  const result = spawnSync(npm.command, npm.args, {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) {
    throw new RuntimeSetupError(
      `[${commandName}] could not start npm: ${result.error.message}`,
      { details: setupCommandFor(packageRoot, packageJson) },
    );
  }

  if (result.status !== 0) {
    throw new RuntimeSetupError(
      `[${commandName}] dependency install failed with exit ${result.status}`,
      { details: setupCommandFor(packageRoot, packageJson) },
    );
  }
}

export function formatRuntimeSetupError(error) {
  const details = Array.isArray(error?.details) ? error.details : [];
  const suffix = details.length > 0
    ? `\n\nRun:\n${details.map((line) => `  ${line}`).join('\n')}`
    : '';
  return `${error.message}${suffix}`;
}

export async function assertRuntimeSetup({ startDir, commandName = 'audit-repo' } = {}) {
  if (!isSupportedNodeVersion()) {
    throw new RuntimeSetupError(
      `[${commandName}] Node ${process.versions.node} is not supported; requires ${NODE_ENGINE}`,
      { details: ['Install Node ^20.19.0 or >=22.12.0, then retry.'] },
    );
  }

  const { packageRoot, packageJson } = findRuntimePackageRoot(startDir ?? process.cwd());
  if (!packageRoot || !packageJson) {
    throw new RuntimeSetupError(
      `[${commandName}] could not find package.json with lumin-repo-lens runtime dependencies`,
    );
  }

  let missing = await checkPackageAvailability(packageRoot);
  if (missing.length === 0) return;

  if (shouldAutoInstall()) {
    runNpmInstall(packageRoot, packageJson, commandName);
    missing = await checkPackageAvailability(packageRoot);
    if (missing.length === 0) return;
  }

  throw new RuntimeSetupError(
    [
      `[${commandName}] setup required: runtime dependencies are not ready.`,
      formatMissing(missing),
    ].join('\n'),
    { details: setupCommandFor(packageRoot, packageJson) },
  );
}
