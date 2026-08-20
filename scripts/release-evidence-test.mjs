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
const originalGitHubSha = process.env.GITHUB_SHA;
const originalAcceptanceMode = process.env.RUNBEACON_ACCEPTANCE_MODE;
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
    'temporaryNotaryAccepted',
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
assert.match(
  acceptanceWorkflow,
  /mode:[\s\S]*?default:\s*rehearsal[\s\S]*?options:[\s\S]*?- rehearsal[\s\S]*?- beta/
);
assert.match(
  acceptanceWorkflow,
  /case "\$ACCEPTANCE_MODE" in[\s\S]*?rehearsal\)[\s\S]*?beta\)[\s\S]*?releases\/tags\/\$BETA_TAG/
);

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
const macAcceptance = fs.readFileSync(
  path.join(root, 'scripts', 'acceptance', 'mac-signing.mjs'),
  'utf8'
);
assert.match(macAcceptance, /notarytool submit[\s\S]*?--wait/);
assert.match(macAcceptance, /RUNBEACON_NOTARY_ACCEPTED/);
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
  process.env.GITHUB_SHA = sha;
  process.env.RUNBEACON_ACCEPTANCE_MODE = 'rehearsal';
  const { writeAcceptanceReport } = await import('./acceptance/report.mjs');
  const generatedPath = path.join(evidence, 'generated-rehearsal.json');
  const generatedRehearsal = writeAcceptanceReport({
    kind: 'generated-rehearsal',
    output: generatedPath,
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    checks: { sample: true },
  });
  assert.equal(generatedRehearsal.schemaVersion, 2);
  assert.equal(generatedRehearsal.acceptanceMode, 'rehearsal');
  assert.equal(generatedRehearsal.stableEligible, false);

  process.env.RUNBEACON_ACCEPTANCE_MODE = 'beta';
  const generatedBeta = writeAcceptanceReport({
    kind: 'generated-beta',
    output: path.join(evidence, 'generated-beta.json'),
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    checks: { sample: true },
  });
  assert.equal(generatedBeta.acceptanceMode, 'beta');
  assert.equal(generatedBeta.stableEligible, true);

  for (const [kind, checks] of Object.entries(requirements)) {
    fs.writeFileSync(
      path.join(evidence, `${kind}.json`),
      JSON.stringify({
        schemaVersion: 2,
        kind,
        acceptanceMode: 'beta',
        stableEligible: true,
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

  const macPath = path.join(evidence, 'mac-signing.json');
  const mac = JSON.parse(fs.readFileSync(macPath, 'utf8'));
  mac.acceptanceMode = 'rehearsal';
  mac.stableEligible = false;
  fs.writeFileSync(macPath, JSON.stringify(mac));
  const rehearsal = spawnSync(
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
  assert.notEqual(
    rehearsal.status,
    0,
    'rehearsal evidence was accepted for Stable'
  );
  assert.match(rehearsal.stderr, /rehearsal evidence/);
  mac.acceptanceMode = 'beta';
  mac.stableEligible = true;
  fs.writeFileSync(macPath, JSON.stringify(mac));

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
  if (originalGitHubSha === undefined) delete process.env.GITHUB_SHA;
  else process.env.GITHUB_SHA = originalGitHubSha;
  if (originalAcceptanceMode === undefined) {
    delete process.env.RUNBEACON_ACCEPTANCE_MODE;
  } else {
    process.env.RUNBEACON_ACCEPTANCE_MODE = originalAcceptanceMode;
  }
  fs.rmSync(evidence, { recursive: true, force: true });
}
