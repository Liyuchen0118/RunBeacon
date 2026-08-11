#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeAcceptanceReport } from './report.mjs';

assert.equal(process.platform, 'linux', 'Linux acceptance requires Linux');
const startedAt = new Date().toISOString();
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), 'runbeacon-linux-acceptance-')
);
const binary = path.join(temporary, 'runbeacon-runner');
const stateDir = path.join(temporary, 'state');
const socket = path.join(temporary, 'runner.sock');
const marker = path.join(temporary, 'execution-count');
const output =
  process.env.RUNBEACON_ACCEPTANCE_OUTPUT ||
  path.join(root, 'acceptance-results', 'linux-training.json');
const disconnectMs = Number(
  process.env.RUNBEACON_ACCEPTANCE_DISCONNECT_MS || 600_000
);
let server;

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
  const result = run(binary, ['rpc', '--socket', socket], {
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

async function waitForSocket() {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(socket)) {
    assert.ok(Date.now() < deadline, 'Runner socket did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startServer() {
  server = spawn(
    binary,
    ['serve', '--state-dir', stateDir, '--socket', socket],
    {
      detached: false,
      stdio: 'ignore',
    }
  );
  await waitForSocket();
}

async function stopServer() {
  if (!server) return;
  const current = server;
  server = undefined;
  const exited = new Promise((resolve) => current.once('exit', resolve));
  current.kill('SIGTERM');
  await exited;
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
  run('go', ['build', '-trimpath', '-o', binary, './cmd/runbeacon-runner'], {
    cwd: path.join(root, 'runner'),
  });
  await startServer();
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
  await stopServer();
  await new Promise((resolve) => setTimeout(resolve, disconnectMs));
  await startServer();
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
      daemonRecovery: process.env.RUNBEACON_DAEMON_TESTED === 'true',
      tenMinuteEventContinuity: disconnectMs >= 600_000,
      trainingProgress: true,
      verifiedCancellation: true,
    },
    details: {
      disconnectMs,
      eventCount: events.length,
      reconnectFromSequence: 0,
    },
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await stopServer();
  fs.rmSync(temporary, { recursive: true, force: true });
}
