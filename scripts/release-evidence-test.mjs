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

const releaseWorkflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'release.yml'),
  'utf8'
);
assert.match(
  releaseWorkflow,
  /attest:\s*[\s\S]*?permissions:\s*[\s\S]*?id-token:\s*write[\s\S]*?attestations:\s*write[\s\S]*?actions\/attest-build-provenance@v2/,
  'Runner provenance job is missing write permissions'
);
assert.match(
  releaseWorkflow,
  /manifest_version=.*\.codex-plugin\/plugin\.json[\s\S]*?PLUGIN_VERSION\+codex\./,
  'Release gate does not bind the Codex manifest to plugin_version'
);
const provenancePermissionContract =
  /attest:\s*[\s\S]*?permissions:\s*[\s\S]*?id-token:\s*write[\s\S]*?attestations:\s*write[\s\S]*?actions\/attest-build-provenance@v2/;
assert.doesNotMatch(
  releaseWorkflow.replace('attestations: write', 'attestations: read'),
  provenancePermissionContract,
  'Release evidence test accepted read-only attestation permissions'
);
const pluginVersionContract =
  /manifest_version=.*\.codex-plugin\/plugin\.json[\s\S]*?PLUGIN_VERSION\+codex\./;
assert.doesNotMatch(
  releaseWorkflow.replace('PLUGIN_VERSION+codex.', 'VERSION+codex.'),
  pluginVersionContract,
  'Release evidence test accepted an unbound plugin manifest version'
);
const acceptanceWorkflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'acceptance.yml'),
  'utf8'
);
assert.match(acceptanceWorkflow, /actions\/setup-python@v5/);
assert.match(acceptanceWorkflow, /PyYAML==6\.0\.2/);

const codexPluginAcceptance = fs.readFileSync(
  path.join(root, 'scripts', 'acceptance', 'codex-plugin.mjs'),
  'utf8'
);
assert.match(codexPluginAcceptance, /buildCodexAcceptanceArgs\(prompt\)/);
assert.doesNotMatch(codexPluginAcceptance, /'--sandbox'/);
const linuxAcceptance = fs.readFileSync(
  path.join(root, 'scripts', 'acceptance', 'linux-training.mjs'),
  'utf8'
);
for (const role of ['linux-training', 'mac-signing', 'codex-plugin']) {
  assert.match(
    acceptanceWorkflow,
    new RegExp(`machine-preflight\\.mjs ${role}`),
    `${role} machine preflight is not required by acceptance`
  );
}
assert.match(acceptanceWorkflow, /PyYAML==6\.0\.2/);
assert.match(linuxAcceptance, /runnerServiceStopped = true/);
assert.match(
  linuxAcceptance,
  /if \(runnerInstalled && runnerServiceStopped\)[\s\S]*?'start',[\s\S]*?'runbeacon-runner\.service'/,
  'Linux acceptance must recover a service that it stopped before failing'
);

const operatorGuide = fs.readFileSync(
  path.join(root, 'docs', 'SELF_HOSTED_ACCEPTANCE.md'),
  'utf8'
);
for (const label of [
  'runbeacon-training',
  'runbeacon-signing',
  'runbeacon-codex',
]) {
  assert.match(operatorGuide, new RegExp(label));
}

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
