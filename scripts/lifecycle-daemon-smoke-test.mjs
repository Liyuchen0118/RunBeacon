import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '../dist/lifecycle/DaemonClient.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryData = fs.mkdtempSync(
  path.join(os.tmpdir(), 'remote-job-monitor-daemon-')
);
const originalBuildVersion = '1.0.0+codex.20260805000001';
const upgradedBuildVersion = '1.0.0+codex.20260805000002';
const daemonEntry = path.join(
  root,
  'dist',
  'daemon',
  `lifecycle-daemon.smoke-${process.pid}.js`
);
fs.copyFileSync(
  path.join(root, 'dist', 'daemon', 'lifecycle-daemon.js'),
  daemonEntry
);
const firstClient = new DaemonClient(temporaryData, daemonEntry, {
  buildVersion: originalBuildVersion,
});
let daemonReady = false;

try {
  await firstClient.ensureReady();
  daemonReady = true;
  const started = await firstClient.start({
    command: process.execPath,
    args: [
      '-e',
      "console.log('20% daemon'); setTimeout(() => { console.log('100% daemon'); process.exit(0) }, 150)",
    ],
    shell: false,
    label: 'daemon-survival-smoke',
  });

  // A fresh client simulates a restarted MCP shim attaching to the resident daemon.
  const secondClient = new DaemonClient(temporaryData, daemonEntry, {
    buildVersion: originalBuildVersion,
  });
  await secondClient.ensureReady();
  const visible = await secondClient.list(5);
  assert.ok(visible.some((job) => job.id === started.id));

  const completed = await secondClient.waitForTerminal(started.id, 10_000, 30);
  assert.equal(completed.timedOut, false);
  assert.equal(completed.job.state, 'succeeded');
  assert.equal(completed.job.progress?.percentage, 100);

  const cancellable = await secondClient.start({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.exit(0), 5000)'],
    shell: false,
    label: 'abort-propagation-smoke',
    idempotencyKey: 'daemon-smoke-abort-propagation',
  });
  const originalStatus = await secondClient.status();
  fs.appendFileSync(daemonEntry, '\n// daemon-build-upgrade-smoke\n');
  const upgradedClient = new DaemonClient(temporaryData, daemonEntry, {
    buildVersion: upgradedBuildVersion,
  });
  await assert.rejects(upgradedClient.ensureReady(), /job\(s\) are active/);
  const controller = new AbortController();
  const abandonedWait = secondClient.waitForTerminal(
    cancellable.id,
    10_000,
    10,
    controller.signal
  );
  controller.abort();
  await assert.rejects(abandonedWait, /aborted/);
  await secondClient.cancel(cancellable.id);
  const cancelled = await secondClient.waitForTerminal(
    cancellable.id,
    10_000,
    10
  );
  assert.equal(cancelled.job.state, 'cancelled');

  await upgradedClient.ensureReady();
  const upgradedStatus = await upgradedClient.status();
  assert.notEqual(upgradedStatus.pid, originalStatus.pid);
  assert.notEqual(upgradedStatus.buildId, originalStatus.buildId);
  assert.equal(upgradedStatus.buildVersion, upgradedBuildVersion);

  await assert.rejects(
    firstClient.ensureReady(),
    /newer RunBeacon daemon build/
  );
  const downgradeProtectedStatus = await upgradedClient.status();
  assert.equal(downgradeProtectedStatus.pid, upgradedStatus.pid);
  assert.equal(downgradeProtectedStatus.buildId, upgradedStatus.buildId);

  process.stdout.write(
    `${JSON.stringify({
      residentDaemon: 'passed',
      secondClientReattach: 'passed',
      eventWait: 'passed',
      abortPropagation: 'passed',
      daemonBuildUpgrade: 'passed',
      daemonDowngradeProtection: 'passed',
    })}\n`
  );
} finally {
  if (daemonReady) {
    try {
      await firstClient.shutdown();
    } catch {
      // The daemon may already have stopped after a failed assertion.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  fs.rmSync(temporaryData, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
  fs.rmSync(daemonEntry, { force: true });
}
