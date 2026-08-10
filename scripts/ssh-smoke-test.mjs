import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifecycleManager } from '../dist/lifecycle/LifecycleManager.js';

const host = process.env.SSH_TEST_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.SSH_TEST_PORT || '22', 10);
const username = process.env.SSH_TEST_USER;
const password = process.env.SSH_TEST_PASS;
const marker = 'RUNBEACON_SSH_PASSWORD_SMOKE_OK';

assert.ok(username, 'SSH_TEST_USER is required');
assert.ok(password, 'SSH_TEST_PASS is required');
assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535);

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'runbeacon-ssh-smoke-')
);
const manager = new LifecycleManager({
  statePath: path.join(temporaryDirectory, 'jobs.json'),
  sshHandshakeAttempts: 1,
  sshReadyTimeoutMs: 10_000,
});

try {
  const started = manager.start({
    command: `printf '${marker}\\n'`,
    executionMode: 'direct',
    timeoutMs: 15_000,
    target: {
      kind: 'ssh',
      host,
      port,
      username,
      password,
      // The ephemeral CI SSH daemon has no stable trust anchor. Production
      // profiles require a pinned SHA-256 host key.
      allowUnverifiedHostKey: true,
    },
  });
  const result = await manager.waitForTerminal(started.id, 20_000, 40);
  const output = result.job.tail.map((chunk) => chunk.data).join('');

  assert.equal(result.timedOut, false);
  assert.equal(result.job.state, 'succeeded', result.job.error);
  assert.equal(result.job.execution.backend, 'ssh_direct');
  assert.equal(result.job.execution.durable, false);
  assert.equal(result.job.target.verifiedHostKey, false);
  assert.match(output, new RegExp(marker));
  assert.doesNotMatch(JSON.stringify(result.job), new RegExp(password));

  process.stdout.write(
    `${JSON.stringify({ passwordAuthentication: 'passed', lifecycle: 'start-wait' })}\n`
  );
} finally {
  manager.dispose();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
