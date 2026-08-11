import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyRunnerAsset } from '../packages/runner-installer/verify.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runbeacon-runner-verify-'));
const name = 'runbeacon-runner-linux-x64';
const asset = path.join(root, name);
const sumsPath = path.join(root, 'SHA256SUMS');
const bundlePath = `${asset}.sigstore.json`;
const payload = Buffer.from('signed-runbeacon-runner-fixture');

try {
  fs.writeFileSync(asset, payload);
  fs.writeFileSync(
    sumsPath,
    `${createHash('sha256').update(payload).digest('hex')}  ${name}\n`
  );
  fs.writeFileSync(bundlePath, JSON.stringify({ mediaType: 'test-bundle' }));
  let verification;
  const verified = await verifyRunnerAsset({
    name,
    asset,
    sumsPath,
    bundlePath,
    verifier: async (bundle, data, options) => {
      verification = { bundle, data: Buffer.from(data), options };
    },
  });
  assert.deepEqual(verified, payload);
  assert.deepEqual(verification.data, payload);
  assert.equal(
    verification.options.certificateIssuer,
    'https://token.actions.githubusercontent.com'
  );
  assert.equal(
    verification.options.certificateIdentityURI,
    '^https://github\\.com/Liyuchen0118/RunBeacon/\\.github/workflows/release\\.yml@refs/heads/main$'
  );
  assert.equal(verification.options.ctLogThreshold, 1);
  assert.equal(verification.options.tlogThreshold, 1);
  const identityPattern = new RegExp(
    verification.options.certificateIdentityURI
  );
  assert.equal(
    identityPattern.test(
      'https://github.com/Liyuchen0118/RunBeacon/.github/workflows/release.yml@refs/heads/main'
    ),
    true
  );
  assert.equal(
    identityPattern.test(
      'https://githubXcom/Liyuchen0118/RunBeacon/.github/workflows/release-yml@refs/heads/main'
    ),
    false
  );

  fs.writeFileSync(sumsPath, `${'0'.repeat(64)}  ${name}\n`);
  await assert.rejects(
    verifyRunnerAsset({
      name,
      asset,
      sumsPath,
      bundlePath,
      verifier: async () => undefined,
    }),
    /SHA256 verification failed/
  );
  process.stdout.write('Runner installer SHA256 and Sigstore policy passed\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
