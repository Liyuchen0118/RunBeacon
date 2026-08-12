#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const role = process.argv[2];
const roles = {
  'linux-training': { platform: 'linux', runnerOs: 'Linux' },
  'mac-signing': { platform: 'darwin', runnerOs: 'macOS' },
  'codex-plugin': { platform: 'win32', runnerOs: 'Windows' },
};
const expected = roles[role];

assert.ok(expected, `unknown acceptance role: ${role || '<missing>'}`);
assert.equal(
  process.env.GITHUB_ACTIONS,
  'true',
  'machine preflight must run inside GitHub Actions'
);
assert.equal(process.platform, expected.platform, `${role} OS mismatch`);
assert.equal(
  process.env.RUNNER_OS,
  expected.runnerOs,
  `${role} RUNNER_OS mismatch`
);
assert.match(
  process.env.GITHUB_SHA || '',
  /^[0-9a-f]{40}$/i,
  'GITHUB_SHA must bind acceptance to one commit'
);
assert.ok(process.env.RUNNER_NAME?.trim(), 'RUNNER_NAME is required');

const commands = ['git', 'node'];
if (role === 'linux-training') commands.push('go', 'systemctl');
if (role === 'mac-signing') {
  commands.push('go', 'launchctl', 'security', 'codesign', 'xcrun');
}
if (role === 'codex-plugin') commands.push('python', 'codex');
for (const command of commands) commandPath(command);

if (role === 'linux-training') {
  run('systemctl', ['--user', 'show-environment']);
}
if (role === 'mac-signing') {
  run('launchctl', ['print', `gui/${process.getuid()}`]);
  requiredEnvironment('RUNBEACON_APPLE_SIGNING_IDENTITY');
  requiredEnvironment('RUNBEACON_NOTARY_PROFILE');
}
if (role === 'codex-plugin') {
  run('python', ['-c', 'import yaml']);
}

process.stdout.write(
  `${JSON.stringify({
    role,
    runnerName: process.env.RUNNER_NAME,
    runnerOs: process.env.RUNNER_OS,
    architecture: process.arch,
    commitSha: process.env.GITHUB_SHA,
    tools: commands,
  })}\n`
);

function requiredEnvironment(name) {
  assert.ok(process.env[name]?.trim(), `${name} is required`);
}

function commandPath(command) {
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
      : [''];
  const candidates = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) =>
      extensions.map((extension) =>
        path.join(directory, `${command}${extension}`)
      )
    );
  const resolved = candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  assert.ok(resolved, `${command} was not found on PATH`);
  return resolved;
}

function run(command, args) {
  execFileSync(command, args, {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
