import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '../dist/lifecycle/DaemonClient.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonEntry = path.join(root, 'dist', 'daemon', 'lifecycle-daemon.js');
const temporaryData = fs.mkdtempSync(
  path.join(os.tmpdir(), 'remote-job-monitor-daemon-')
);
const firstClient = new DaemonClient(temporaryData, daemonEntry);
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
  const secondClient = new DaemonClient(temporaryData, daemonEntry);
  await secondClient.ensureReady();
  const visible = await secondClient.list(5);
  assert.ok(visible.some((job) => job.id === started.id));

  const completed = await secondClient.waitForTerminal(started.id, 10_000, 30);
  assert.equal(completed.timedOut, false);
  assert.equal(completed.job.state, 'succeeded');
  assert.equal(completed.job.progress?.percentage, 100);

  process.stdout.write(
    `${JSON.stringify({
      residentDaemon: 'passed',
      secondClientReattach: 'passed',
      eventWait: 'passed',
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
}
