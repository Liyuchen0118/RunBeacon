#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeAcceptanceReport } from './report.mjs';
import { assertRunBeaconCodexAcceptance } from './codex-exec-json.mjs';

const startedAt = new Date().toISOString();
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const home = os.homedir();
const pluginTarget = path.join(home, 'plugins', 'remote-job-monitor');
const marketplacePath = path.join(
  home,
  '.agents',
  'plugins',
  'marketplace.json'
);
const pluginCreator = path.join(
  home,
  '.codex',
  'skills',
  '.system',
  'plugin-creator'
);
const skillCreator = path.join(
  home,
  '.codex',
  'skills',
  '.system',
  'skill-creator'
);
const python =
  process.env.RUNBEACON_PYTHON ||
  (process.platform === 'win32' ? 'python.exe' : 'python3');
const codex =
  process.env.RUNBEACON_CODEX_BIN ||
  (process.platform === 'win32' ? 'codex.cmd' : 'codex');
const output =
  process.env.RUNBEACON_ACCEPTANCE_OUTPUT ||
  path.join(root, 'acceptance-results', 'codex-plugin.json');
const backup = `${pluginTarget}.acceptance-backup-${process.pid}`;
let staged = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10 * 60 * 1_000,
    shell: false,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} failed:\n${result.stdout}\n${result.stderr}`
  );
  return result;
}

function stagePlugin() {
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
  assert.ok(
    marketplace.plugins?.some(
      (plugin) =>
        plugin.name === 'remote-job-monitor' &&
        plugin.source?.source === 'local'
    ),
    'personal marketplace must already contain the local remote-job-monitor entry'
  );
  if (path.resolve(root) === path.resolve(pluginTarget)) return;
  fs.mkdirSync(path.dirname(pluginTarget), { recursive: true });
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(pluginTarget)) fs.renameSync(pluginTarget, backup);
  try {
    fs.cpSync(root, pluginTarget, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(root, source);
        return !relative
          .split(path.sep)
          .some((part) =>
            [
              '.git',
              'node_modules',
              'acceptance-results',
              'runner-assets',
            ].includes(part)
          );
      },
    });
    staged = true;
  } catch (error) {
    fs.rmSync(pluginTarget, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, pluginTarget);
    throw error;
  }
}

try {
  stagePlugin();
  run(python, [
    path.join(pluginCreator, 'scripts', 'update_plugin_cachebuster.py'),
    pluginTarget,
  ]);
  run(python, [
    path.join(pluginCreator, 'scripts', 'validate_plugin.py'),
    pluginTarget,
  ]);
  run(python, [
    path.join(skillCreator, 'scripts', 'quick_validate.py'),
    path.join(pluginTarget, 'skills', 'monitor-remote-jobs'),
  ]);
  const marketplaceName = run(python, [
    path.join(pluginCreator, 'scripts', 'read_marketplace_name.py'),
    '--marketplace-path',
    marketplacePath,
  ]).stdout.trim();
  assert.match(marketplaceName, /^[A-Za-z0-9._-]+$/);
  run(codex, ['plugin', 'add', `remote-job-monitor@${marketplaceName}`]);
  const prompt = [
    'Use RunBeacon job_start to run this as a local tracked command:',
    'node -e "console.log(\'RUNBEACON_CODEX_ACCEPTANCE\')"',
    'Immediately call job_wait exactly once. Do not call job_snapshot or job_list.',
    'Return the final job state.',
  ].join('\n');
  const task = run(
    codex,
    [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      prompt,
    ],
    { cwd: pluginTarget }
  );
  assertRunBeaconCodexAcceptance(task.stdout);
  const report = writeAcceptanceReport({
    kind: 'codex-plugin',
    output,
    startedAt,
    checks: {
      validatePlugin: true,
      quickValidateSkill: true,
      marketplaceReinstall: true,
      freshCodexTask: true,
      jobStartWait: true,
    },
    details: { marketplaceName },
  });
  if (staged) fs.rmSync(backup, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  if (staged && fs.existsSync(backup)) {
    fs.rmSync(pluginTarget, { recursive: true, force: true });
    fs.renameSync(backup, pluginTarget);
  }
  throw error;
}
