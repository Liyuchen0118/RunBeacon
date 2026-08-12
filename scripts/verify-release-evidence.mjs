#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const [evidenceDir, commitSha, coreVersion, pluginVersion, betaPublishedAt] =
  process.argv.slice(2);
assert.ok(
  evidenceDir && commitSha && coreVersion && pluginVersion && betaPublishedAt,
  'usage: verify-release-evidence <dir> <sha> <core> <plugin> <beta-published-at>'
);
assert.match(commitSha, /^[0-9a-f]{40}$/i);
const betaTime = Date.parse(betaPublishedAt);
assert.ok(Number.isFinite(betaTime), 'beta publication timestamp is invalid');
assert.ok(
  Date.now() - betaTime >= 7 * 24 * 60 * 60 * 1_000,
  'public beta has not run for seven complete days'
);

const requirements = {
  'linux-training': [
    'runnerExactlyOnce',
    'runnerRestartRecovery',
    'systemdUserService',
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

for (const [kind, checks] of Object.entries(requirements)) {
  const file = path.join(evidenceDir, `${kind}.json`);
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(report.schemaVersion, 1, `${kind}: unsupported schema`);
  assert.equal(report.kind, kind, `${kind}: wrong report kind`);
  assert.equal(report.passed, true, `${kind}: report did not pass`);
  assert.equal(
    report.commitSha,
    commitSha,
    `${kind}: commit does not match release`
  );
  assert.equal(
    report.coreVersion,
    coreVersion,
    `${kind}: core version mismatch`
  );
  assert.equal(
    report.runnerVersion,
    coreVersion,
    `${kind}: Runner version mismatch`
  );
  assert.equal(
    report.pluginVersion,
    pluginVersion,
    `${kind}: plugin version mismatch`
  );
  const started = Date.parse(report.startedAt);
  const finished = Date.parse(report.finishedAt);
  assert.ok(
    Number.isFinite(started) &&
      Number.isFinite(finished) &&
      finished >= started,
    `${kind}: invalid timestamps`
  );
  assert.ok(finished >= betaTime, `${kind}: evidence predates public beta`);
  assert.ok(
    finished <= Date.now() + 5 * 60_000,
    `${kind}: evidence is future-dated`
  );
  assert.ok(
    Date.now() - finished <= 30 * 24 * 60 * 60 * 1_000,
    `${kind}: evidence is older than 30 days`
  );
  for (const check of checks) {
    assert.equal(
      report.checks?.[check],
      true,
      `${kind}: missing check ${check}`
    );
  }
}

process.stdout.write(
  'Stable release evidence is complete and bound to this commit.\n'
);
