import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verify } from 'sigstore';

const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const RELEASE_WORKFLOW_IDENTITY =
  '^https://github\\.com/Liyuchen0118/RunBeacon/\\.github/workflows/release\\.yml@refs/heads/main$';

export async function verifyRunnerAsset({
  name,
  asset,
  sumsPath,
  bundlePath,
  verifier = verify,
}) {
  if (!/^runbeacon-runner-(?:linux|darwin)-(?:x64|arm64)$/.test(name)) {
    throw new Error('Invalid Runner asset name');
  }
  const binary = readFileSync(asset);
  const sums = readFileSync(sumsPath, 'utf8');
  const entries = sums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((entry) => entry.at(-1) === name);
  if (entries.length !== 1 || !/^[0-9a-f]{64}$/i.test(entries[0][0])) {
    throw new Error(`Expected exactly one SHA256 entry for ${name}`);
  }
  const actual = createHash('sha256').update(binary).digest('hex');
  if (actual.toLowerCase() !== entries[0][0].toLowerCase()) {
    throw new Error(`SHA256 verification failed for ${name}`);
  }
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  } catch {
    throw new Error(`Missing or invalid Sigstore bundle for ${name}`);
  }
  await verifier(bundle, binary, {
    certificateIssuer: GITHUB_OIDC_ISSUER,
    certificateIdentityURI: RELEASE_WORKFLOW_IDENTITY,
    ctLogThreshold: 1,
    tlogThreshold: 1,
  });
  return binary;
}
