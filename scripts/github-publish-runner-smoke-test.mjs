#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'runbeacon-github-'));
const repository = path.join(temporary, 'repository');
const remote = path.join(temporary, 'remote.git');
const canary = 'PROXY_PASSWORD_MUST_NOT_APPEAR';

try {
  fs.mkdirSync(repository);
  git(temporary, ['init', '--bare', remote]);
  git(repository, ['init']);
  git(repository, ['checkout', '-b', 'feature/test']);
  git(repository, ['config', 'user.name', 'RunBeacon Smoke']);
  git(repository, ['config', 'user.email', 'runbeacon@example.invalid']);
  fs.mkdirSync(path.join(repository, '.github', 'workflows'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repository, '.github', 'workflows', 'ci.yml'),
    'name: CI\non:\n  push:\n    branches: [main]\n'
  );
  fs.writeFileSync(path.join(repository, 'README.md'), '# smoke\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'test: seed publish smoke repository']);
  git(repository, [
    'remote',
    'add',
    'origin',
    'https://github.com/acme/runbeacon-smoke.git',
  ]);
  git(repository, ['remote', 'set-url', '--push', 'origin', remote]);

  const startedAt = Date.now();
  const bestEffort = runner(false);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(bestEffort.status, 0, bestEffort.stderr || bestEffort.stdout);
  assert.match(bestEffort.stdout, /100% \[no-workflows\]/);
  assert.ok(elapsedMs < 5_000, `no-workflows took ${elapsedMs}ms`);
  assert.doesNotMatch(
    bestEffort.stdout + bestEffort.stderr,
    new RegExp(canary)
  );

  const required = runner(true);
  assert.notEqual(required.status, 0);
  assert.match(required.stdout, /\[no-workflows\]/);
  assert.match(required.stdout, /\[failed\]/);
  assert.doesNotMatch(required.stdout + required.stderr, new RegExp(canary));

  const commitCount = Number(
    git(temporary, [
      '--git-dir',
      remote,
      'rev-list',
      '--count',
      'refs/heads/feature/test',
    ]).stdout.trim()
  );
  assert.equal(commitCount, 1);
  process.stdout.write(
    `GitHub publish runner smoke test passed (${elapsedMs}ms no-workflows)\n`
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function runner(requireActions) {
  return spawnSync(
    process.execPath,
    [
      path.join(root, 'dist', 'daemon', 'github-publish-runner.js'),
      '--cwd',
      repository,
      '--remote',
      'origin',
      '--watch-actions',
      'true',
      '--require-actions',
      String(requireActions),
      '--actions-timeout-ms',
      '10000',
      '--discovery-timeout-ms',
      '1000',
      '--poll-interval-ms',
      '1000',
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNBEACON_GITHUB_CREDENTIAL_SOURCE: 'none',
        RUNBEACON_GITHUB_PROXY: `http://user:${canary}@127.0.0.1:9`,
      },
      windowsHide: true,
    }
  );
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}
