import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'runbeacon-evidence-'));
const sha = 'a'.repeat(40);
const beta = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString();
const requirements = {
  'linux-training': [
    'runnerExactlyOnce',
    'runnerRestartRecovery',
    'daemonRecovery',
    'sameWaitDaemonCrashRecovery',
    'durableCoordinatorRecovery',
    'tenMinuteEventContinuity',
    'trainingProgress',
    'verifiedCancellation',
  ],
  'mac-signing': [
    'launchAgentAqua',
    'developerIdUntimestamped',
    'developerIdTimestamped',
    'notaryProfile',
    'keychainSecretStayedLocal',
  ],
  'codex-plugin': [
    'validatePlugin',
    'quickValidateSkill',
    'marketplaceReinstall',
    'freshCodexTask',
    'jobStartWait',
  ],
};

try {
  for (const [kind, checks] of Object.entries(requirements)) {
    fs.writeFileSync(
      path.join(evidence, `${kind}.json`),
      JSON.stringify({
        schemaVersion: 1,
        kind,
        passed: true,
        commitSha: sha,
        coreVersion: '3.0.0',
        runnerVersion: '3.0.0',
        pluginVersion: '2.0.0',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        finishedAt: new Date().toISOString(),
        checks: Object.fromEntries(checks.map((check) => [check, true])),
      })
    );
  }
  const valid = spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts', 'verify-release-evidence.mjs'),
      evidence,
      sha,
      '3.0.0',
      '2.0.0',
      beta,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(valid.status, 0, valid.stderr);

  const linuxPath = path.join(evidence, 'linux-training.json');
  const linux = JSON.parse(fs.readFileSync(linuxPath, 'utf8'));
  linux.checks.verifiedCancellation = false;
  fs.writeFileSync(linuxPath, JSON.stringify(linux));
  const invalid = spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts', 'verify-release-evidence.mjs'),
      evidence,
      sha,
      '3.0.0',
      '2.0.0',
      beta,
    ],
    { encoding: 'utf8' }
  );
  assert.notEqual(invalid.status, 0, 'an incomplete acceptance report passed');
  assert.match(invalid.stderr, /verifiedCancellation/);
  process.stdout.write('Stable release evidence gates passed\n');
} finally {
  fs.rmSync(evidence, { recursive: true, force: true });
}
