import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+codex\.([0-9A-Za-z.-]+))?$/;

export function readPluginBuildVersion(moduleUrl: string): string {
  const override = process.env.RJM_BUILD_VERSION?.trim();
  if (override) return validateBuildVersion(override);
  const manifestPath = fileURLToPath(
    new URL('../../.codex-plugin/plugin.json', moduleUrl)
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    version?: unknown;
  };
  return validateBuildVersion(String(manifest.version ?? ''));
}

export function validateBuildVersion(value: string): string {
  const version = value.trim();
  if (!VERSION_PATTERN.test(version) || version.length > 128) {
    throw new Error(
      `Invalid RunBeacon build version: ${version.slice(0, 128)}`
    );
  }
  return version;
}

export function compareBuildVersions(left: string, right: string): number {
  if (left === right) return 0;
  const leftParts = parseBuildVersion(left);
  const rightParts = parseBuildVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts.core[index] - rightParts.core[index];
    if (difference !== 0) return Math.sign(difference);
  }
  const prerelease = compareOptionalIdentifier(
    leftParts.prerelease,
    rightParts.prerelease,
    true
  );
  if (prerelease !== 0) return prerelease;
  return compareOptionalIdentifier(
    leftParts.cachebuster,
    rightParts.cachebuster,
    false
  );
}

function parseBuildVersion(value: string) {
  const match = VERSION_PATTERN.exec(validateBuildVersion(value));
  if (!match) throw new Error('Invalid RunBeacon build version');
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4],
    cachebuster: match[5],
  };
}

function compareOptionalIdentifier(
  left: string | undefined,
  right: string | undefined,
  missingIsNewer: boolean
): number {
  if (left === right) return 0;
  if (!left) return missingIsNewer ? 1 : -1;
  if (!right) return missingIsNewer ? -1 : 1;
  return Math.sign(
    left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' })
  );
}
