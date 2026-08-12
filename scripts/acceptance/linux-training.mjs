#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeAcceptanceReport } from './report.mjs';
import { LifecycleManager } from '../../dist/lifecycle/LifecycleManager.js';

assert.equal(process.platform, 'linux', 'Linux acceptance requires Linux');
const startedAt = new Date().toISOString();
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), 'runbeacon-linux-acceptance-')
);
const buildBinary = path.join(temporary, 'runbeacon-runner');
const binary = path.join(os.homedir(), '.local', 'bin', 'runbeacon-runner');
const marker = path.join(temporary, 'execution-count');
const output =
  process.env.RUNBEACON_ACCEPTANCE_OUTPUT ||
  path.join(root, 'acceptance-results', 'linux-training.json');
const disconnectMs = Number(
  process.env.RUNBEACON_ACCEPTANCE_DISCONNECT_MS || 600_000
);
const daemonEvidencePath = requiredPath(
  process.env.RUNBEACON_DAEMON_EVIDENCE,
  'RUNBEACON_DAEMON_EVIDENCE'
);
let runnerInstalled = false;
let runnerServiceStopped = false;

function requiredPath(value, name) {
  assert.ok(value?.trim(), `${name} is required`);
  return path.resolve(root, value);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} failed:\n${result.stdout}\n${result.stderr}`
  );
  return result;
}

function rpc(method, params = {}) {
  const request = JSON.stringify({ protocolVersion: 1, method, params });
  const result = run(binary, ['rpc'], {
    input: `${request}\n`,
  });
  const response = JSON.parse(result.stdout);
  assert.equal(
    response.ok,
    true,
    `${method}: ${JSON.stringify(response.error)}`
  );
  return response.result;
}

function systemctl(...args) {
  return run('systemctl', ['--user', ...args]);
}

function submitParams(jobId, idempotencyKey, command) {
  return {
    jobId,
    idempotencyKey,
    commandDigest: `sha256:${createHash('sha256').update(command).digest('hex')}`,
    command,
    timeoutMillis: 30 * 60 * 1_000,
    cancellationMode: 'process_group',
    outputPolicy: {
      mode: 'full',
      maxBytes: 64 * 1024 * 1024,
      retentionHours: 168,
    },
  };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

try {
  run(
    'go',
    ['build', '-trimpath', '-o', buildBinary, './cmd/runbeacon-runner'],
    {
      cwd: path.join(root, 'runner'),
    }
  );
  run(buildBinary, ['install']);
  runnerInstalled = true;
  systemctl('is-active', '--quiet', 'runbeacon-runner.service');
  assert.equal(
    systemctl(
      'show',
      '-p',
      'KillMode',
      '--value',
      'runbeacon-runner.service'
    ).stdout.trim(),
    'process',
    'systemd must leave independent supervisors alive when the Runner restarts'
  );
  const ping = rpc('ping');
  assert.equal(ping.protocolVersion, 1);
  assert.equal(ping.version, '3.0.0');
  const stepSeconds = Math.ceil(disconnectMs / 10_000) + 1;
  const trainingCommand = [
    'set -eu',
    `rb_marker=${shellQuote(marker)}`,
    'rb_count=0; [ ! -f "$rb_marker" ] || rb_count=$(cat "$rb_marker")',
    'rb_count=$((rb_count + 1)); printf \'%s\\n\' "$rb_count" >"$rb_marker"',
    'for rb_progress in 0 10 20 30 40 50 60 70 80 90 100; do',
    '  printf \'RUNBEACON_EVENT {"phase":"training","percentage":%s,"message":"acceptance"}\\n\' "$rb_progress"',
    '  printf \'TRAIN_PROGRESS %s%%\\n\' "$rb_progress"',
    `  sleep ${stepSeconds}`,
    'done',
    'echo TRAINING_COMPLETED',
  ].join('\n');
  const jobId = randomUUID();
  const params = submitParams(
    jobId,
    `linux-acceptance-${jobId}`,
    trainingCommand
  );
  const submitted = rpc('submit', params);
  assert.equal(submitted.created, true);
  const trainingRunningDeadline = Date.now() + 10_000;
  while (rpc('get', { jobId }).job.processGroupId <= 0) {
    assert.ok(
      Date.now() < trainingRunningDeadline,
      'training supervisor did not enter the running state'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  systemctl('stop', 'runbeacon-runner.service');
  runnerServiceStopped = true;
  const inactive = systemctl(
    'show',
    '-p',
    'ActiveState',
    '--value',
    'runbeacon-runner.service'
  );
  assert.match(
    inactive.stdout.trim(),
    /^(inactive|failed)$/,
    'Runner service must remain unavailable during the disconnect window'
  );
  await new Promise((resolve) => setTimeout(resolve, disconnectMs));
  systemctl('start', 'runbeacon-runner.service');
  systemctl('is-active', '--quiet', 'runbeacon-runner.service');
  runnerServiceStopped = false;
  const duplicate = rpc('submit', params);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.id, jobId);

  let afterSequence = 0;
  const events = [];
  let finalJob = duplicate.job;
  while (
    !['succeeded', 'failed', 'cancelled', 'timed_out', 'lost'].includes(
      finalJob.state
    ) ||
    afterSequence < Number(finalJob.lastEventSequence || 0)
  ) {
    const watched = rpc('watch', {
      jobId,
      afterSequence,
      timeoutMillis: 25_000,
    });
    for (const event of watched.events || []) {
      events.push(event);
      afterSequence = Math.max(afterSequence, event.sequence);
    }
    finalJob = watched.job;
  }
  assert.equal(finalJob.state, 'succeeded');
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), '1');
  const sequences = events.map((event) => event.sequence);
  assert.equal(
    new Set(sequences).size,
    sequences.length,
    'duplicate event sequence'
  );
  sequences.forEach((sequence, index) => assert.equal(sequence, index + 1));
  const text = events.map((event) => event.data || '').join('');
  assert.match(text, /TRAIN_PROGRESS 100%/);
  assert.match(text, /TRAINING_COMPLETED/);

  const daemonEvidence = JSON.parse(
    fs.readFileSync(daemonEvidencePath, 'utf8')
  );
  assert.equal(daemonEvidence.sameWaitDaemonCrashRecovery, 'passed');
  assert.equal(daemonEvidence.nonDurableCrashState, 'lost');

  const coordinatorStatePath = path.join(
    temporary,
    'coordinator-recovery.json'
  );
  const coordinatorProfile = 'linux-acceptance-runner';
  const coordinatorTarget = {
    kind: 'ssh',
    host: 'local-runner.invalid',
    username: 'acceptance',
    allowUnverifiedHostKey: true,
  };
  const firstCoordinator = new LifecycleManager({
    statePath: coordinatorStatePath,
    persistenceDebounceMs: 25,
    runnerTransportFactory: () => ({
      call: async (method, rpcParams = {}) => {
        if (method === 'watch') {
          return new Promise(() => undefined);
        }
        return rpc(method, rpcParams);
      },
    }),
  });
  const coordinatorJob = firstCoordinator.start({
    command: 'sleep 2; echo COORDINATOR_RECOVERED',
    idempotencyKey: `coordinator-recovery-${randomUUID()}`,
    credentialProfileId: coordinatorProfile,
    executionMode: 'runner',
    requireDurable: true,
    target: coordinatorTarget,
  });
  const acceptedDeadline = Date.now() + 10_000;
  while (!firstCoordinator.snapshot(coordinatorJob.id).execution.remoteJobId) {
    assert.ok(
      Date.now() < acceptedDeadline,
      'coordinator recovery fixture was not accepted by the Runner'
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  firstCoordinator.dispose();
  const recoveredCoordinator = new LifecycleManager({
    statePath: coordinatorStatePath,
    persistenceDebounceMs: 25,
    recoverRunnerTarget: async (profileId) => {
      assert.equal(profileId, coordinatorProfile);
      return coordinatorTarget;
    },
    runnerTransportFactory: () => ({
      call: async (method, rpcParams = {}) => rpc(method, rpcParams),
    }),
  });
  const recoveredCoordinatorJob = await recoveredCoordinator.waitForTerminal(
    coordinatorJob.id,
    20_000,
    50
  );
  assert.equal(recoveredCoordinatorJob.timedOut, false);
  assert.equal(recoveredCoordinatorJob.job.state, 'succeeded');
  assert.match(
    recoveredCoordinatorJob.job.tail.map((chunk) => chunk.data).join(''),
    /COORDINATOR_RECOVERED/
  );
  assert.ok(recoveredCoordinatorJob.job.execution.reconnectCount > 0);
  recoveredCoordinator.dispose();

  const cancelId = randomUUID();
  const cancelCommand = "trap 'exit 143' TERM; while :; do sleep 1; done";
  rpc('submit', submitParams(cancelId, `cancel-${cancelId}`, cancelCommand));
  const runningDeadline = Date.now() + 10_000;
  while (rpc('get', { jobId: cancelId }).job.processGroupId <= 0) {
    assert.ok(
      Date.now() < runningDeadline,
      'cancellation fixture did not start'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const cancelled = rpc('cancel', { jobId: cancelId }).job;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.cancellationVerified, true);

  const report = writeAcceptanceReport({
    kind: 'linux-training',
    output,
    startedAt,
    checks: {
      runnerExactlyOnce: true,
      runnerRestartRecovery: true,
      systemdUserService: true,
      daemonRecovery: true,
      sameWaitDaemonCrashRecovery: true,
      durableCoordinatorRecovery: true,
      tenMinuteEventContinuity: disconnectMs >= 600_000,
      trainingProgress: true,
      verifiedCancellation: true,
    },
    details: {
      disconnectMs,
      eventCount: events.length,
      reconnectFromSequence: 0,
      coordinatorJobId: coordinatorJob.id,
      runnerService: 'runbeacon-runner.service',
      runnerVersion: ping.version,
    },
  });
  systemctl('is-active', '--quiet', 'runbeacon-runner.service');
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  if (runnerInstalled && runnerServiceStopped) {
    spawnSync('systemctl', ['--user', 'start', 'runbeacon-runner.service']);
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
