#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeAcceptanceReport, requiredEnvironment } from './report.mjs';

assert.equal(
  process.platform,
  'darwin',
  'Mac signing acceptance requires macOS'
);
const startedAt = new Date().toISOString();
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), 'runbeacon-mac-acceptance-')
);
const build = path.join(temporary, 'runbeacon-runner');
const installed = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'RunBeacon',
  'bin',
  'runbeacon-runner'
);
const identity = requiredEnvironment('RUNBEACON_APPLE_SIGNING_IDENTITY');
const notaryProfile = requiredEnvironment('RUNBEACON_NOTARY_PROFILE');
const output =
  process.env.RUNBEACON_ACCEPTANCE_OUTPUT ||
  path.join(root, 'acceptance-results', 'mac-signing.json');

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
  const result = run(installed, ['rpc'], {
    input: `${JSON.stringify({ protocolVersion: 1, method, params })}\n`,
  });
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.result;
}

function tryRpc(method, params = {}) {
  const result = spawnSync(installed, ['rpc'], {
    cwd: root,
    encoding: 'utf8',
    input: `${JSON.stringify({ protocolVersion: 1, method, params })}\n`,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 1_000,
  });
  if (result.status !== 0) return undefined;
  try {
    const response = JSON.parse(result.stdout);
    return response.ok ? response.result : undefined;
  } catch {
    return undefined;
  }
}

async function waitForReady(timeoutMillis = 10_000) {
  const deadline = Date.now() + timeoutMillis;
  while (Date.now() < deadline) {
    const ping = tryRpc('ping');
    if (ping?.protocolVersion === 1 && ping.version === '3.0.0') return ping;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Runner LaunchAgent RPC did not become ready');
}

try {
  run('go', ['build', '-trimpath', '-o', build, './cmd/runbeacon-runner'], {
    cwd: path.join(root, 'runner'),
  });
  run(build, ['install']);
  run('launchctl', ['print', `gui/${process.getuid()}`]);
  await waitForReady();
  const command = [
    'set -eu',
    'rb_tmp=$(mktemp -d "${TMPDIR:-/tmp}/runbeacon-signing-acceptance.XXXXXX")',
    'trap \'rm -rf "$rb_tmp"\' EXIT HUP INT TERM',
    'printf \'int main(void) { return 0; }\\n\' >"$rb_tmp/probe.c"',
    'xcrun clang -Os -o "$rb_tmp/probe" "$rb_tmp/probe.c"',
    'security find-identity -v -p codesigning | grep -F -- "$RUNBEACON_APPLE_SIGNING_IDENTITY" >/dev/null',
    'codesign --force --options runtime --timestamp=none --sign "$RUNBEACON_APPLE_SIGNING_IDENTITY" "$rb_tmp/probe"',
    'codesign --verify --strict --verbose=2 "$rb_tmp/probe"',
    'if codesign -d --verbose=4 "$rb_tmp/probe" 2>&1 | grep -q \'^Timestamp=\'; then exit 65; fi',
    'echo RUNBEACON_UNTIMESTAMPED_OK',
    'codesign --force --options runtime --timestamp --sign "$RUNBEACON_APPLE_SIGNING_IDENTITY" "$rb_tmp/probe"',
    'codesign --verify --strict --verbose=2 "$rb_tmp/probe"',
    'codesign -d --verbose=4 "$rb_tmp/probe" 2>&1 | grep -q \'^Timestamp=\'',
    'echo RUNBEACON_TIMESTAMPED_OK',
    'xcrun notarytool history --keychain-profile "$RUNBEACON_NOTARY_PROFILE" >/dev/null',
    'echo RUNBEACON_NOTARY_OK',
    'cp "$RUNBEACON_ACCEPTANCE_RUNNER_BINARY" "$rb_tmp/runbeacon-runner"',
    'codesign --force --options runtime --timestamp --sign "$RUNBEACON_APPLE_SIGNING_IDENTITY" "$rb_tmp/runbeacon-runner"',
    'codesign --verify --strict --verbose=2 "$rb_tmp/runbeacon-runner"',
    'ditto -c -k --keepParent "$rb_tmp/runbeacon-runner" "$rb_tmp/runbeacon-runner-notary.zip"',
    'xcrun notarytool submit "$rb_tmp/runbeacon-runner-notary.zip" --keychain-profile "$RUNBEACON_NOTARY_PROFILE" --wait --output-format json >"$rb_tmp/notary-result.json"',
    'test "$(plutil -extract status raw -o - "$rb_tmp/notary-result.json")" = Accepted',
    'echo RUNBEACON_NOTARY_ACCEPTED',
  ].join('\n');
  const jobId = randomUUID();
  const submitted = rpc('submit', {
    jobId,
    idempotencyKey: `mac-signing-${jobId}`,
    commandDigest: `sha256:${createHash('sha256').update(command).digest('hex')}`,
    command,
    env: {
      RUNBEACON_APPLE_SIGNING_IDENTITY: identity,
      RUNBEACON_NOTARY_PROFILE: notaryProfile,
      RUNBEACON_ACCEPTANCE_RUNNER_BINARY: installed,
    },
    timeoutMillis: 20 * 60 * 1_000,
    cancellationMode: 'process_group',
    outputPolicy: {
      mode: 'full',
      maxBytes: 4 * 1024 * 1024,
      retentionHours: 168,
    },
  });
  assert.equal(submitted.created, true);
  let sequence = 0;
  let finalJob = submitted.job;
  const events = [];
  while (
    !['succeeded', 'failed', 'cancelled', 'timed_out', 'lost'].includes(
      finalJob.state
    ) ||
    sequence < Number(finalJob.lastEventSequence || 0)
  ) {
    const watched = rpc('watch', {
      jobId,
      afterSequence: sequence,
      timeoutMillis: 25_000,
    });
    for (const event of watched.events || []) {
      events.push(event);
      sequence = Math.max(sequence, event.sequence);
    }
    finalJob = watched.job;
  }
  assert.equal(finalJob.state, 'succeeded');
  const text = events.map((event) => event.data || '').join('');
  const report = writeAcceptanceReport({
    kind: 'mac-signing',
    output,
    startedAt,
    checks: {
      launchAgentAqua: true,
      developerIdUntimestamped: text.includes('RUNBEACON_UNTIMESTAMPED_OK'),
      developerIdTimestamped: text.includes('RUNBEACON_TIMESTAMPED_OK'),
      notaryProfile: text.includes('RUNBEACON_NOTARY_OK'),
      temporaryNotaryAccepted: text.includes('RUNBEACON_NOTARY_ACCEPTED'),
      keychainSecretStayedLocal:
        !/unlock-keychain|keychain-password|\.p8/i.test(command),
    },
    details: { identity, notaryProfile, runnerJobId: jobId },
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
