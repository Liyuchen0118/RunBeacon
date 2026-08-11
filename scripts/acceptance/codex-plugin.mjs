#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeAcceptanceReport } from './report.mjs';
import { assertRunBeaconCodexAcceptance } from './codex-exec-json.mjs';
import {
  isCodexPluginInstalled,
  prepareCodexCommand,
} from './codex-command.mjs';

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
const output =
  process.env.RUNBEACON_ACCEPTANCE_OUTPUT ||
  path.join(root, 'acceptance-results', 'codex-plugin.json');
const backup = `${pluginTarget}.acceptance-backup-${process.pid}`;
const pluginSourceExisted = fs.existsSync(pluginTarget);
let staged = false;
let codexInvocation;
let marketplaceName;
let pluginSelector;
let installationChanged = false;
let pluginWasInstalled = false;
let acceptanceData;

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
    `${command} failed${result.error ? `: ${result.error.message}` : ''}:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
  );
  return result;
}

function runNpm(args, options = {}) {
  const npmCliCandidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js'
    ),
    path.resolve(
      path.dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js'
    ),
  ].find((candidate) => candidate && fs.existsSync(candidate));
  if (npmCliCandidates) {
    return run(process.execPath, [npmCliCandidates, ...args], options);
  }
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
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
  codexInvocation = prepareCodexCommand();
  marketplaceName = run(python, [
    path.join(pluginCreator, 'scripts', 'read_marketplace_name.py'),
    '--marketplace-path',
    marketplacePath,
  ]).stdout.trim();
  assert.match(marketplaceName, /^[A-Za-z0-9._-]+$/);
  pluginSelector = `remote-job-monitor@${marketplaceName}`;
  pluginWasInstalled = isCodexPluginInstalled(
    run(codexInvocation.command, ['plugin', 'list']).stdout,
    pluginSelector
  );
  stagePlugin();
  run(python, [
    path.join(pluginCreator, 'scripts', 'update_plugin_cachebuster.py'),
    pluginTarget,
  ]);
  runNpm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: pluginTarget,
  });
  run(python, [
    path.join(pluginCreator, 'scripts', 'validate_plugin.py'),
    pluginTarget,
  ]);
  run(python, [
    path.join(skillCreator, 'scripts', 'quick_validate.py'),
    path.join(pluginTarget, 'skills', 'monitor-remote-jobs'),
  ]);
  installationChanged = true;
  run(codexInvocation.command, ['plugin', 'add', pluginSelector]);
  const prompt = [
    'Use RunBeacon job_start to run this as a local tracked command:',
    'node -e "console.log(\'RUNBEACON_CODEX_ACCEPTANCE\')"',
    'Immediately call job_wait exactly once. Do not call job_snapshot or job_list.',
    'Return the final job state.',
  ].join('\n');
  acceptanceData = fs.mkdtempSync(
    path.join(os.tmpdir(), 'runbeacon-codex-acceptance-')
  );
  const task = run(
    codexInvocation.command,
    [
      'exec',
      '--json',
      '--approve-for-me',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      prompt,
    ],
    {
      cwd: pluginTarget,
      env: {
        ...process.env,
        PLUGIN_DATA: acceptanceData,
        RUNBEACON_INLINE_MANAGER: 'true',
      },
    }
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
  let rollbackError;
  if (staged) {
    fs.rmSync(pluginTarget, { recursive: true, force: true });
    if (pluginSourceExisted && fs.existsSync(backup)) {
      fs.renameSync(backup, pluginTarget);
    }
  }
  if (installationChanged && codexInvocation && pluginSelector) {
    try {
      const currentlyInstalled = isCodexPluginInstalled(
        run(codexInvocation.command, ['plugin', 'list']).stdout,
        pluginSelector
      );
      if (currentlyInstalled) {
        run(codexInvocation.command, ['plugin', 'remove', pluginSelector]);
      }
      if (pluginWasInstalled) {
        run(codexInvocation.command, ['plugin', 'add', pluginSelector]);
      }
    } catch (cause) {
      rollbackError = cause;
    }
  }
  if (rollbackError) {
    throw new AggregateError(
      [error, rollbackError],
      'Codex plugin acceptance failed and the installed plugin rollback also failed'
    );
  }
  throw error;
} finally {
  if (acceptanceData) {
    fs.rmSync(acceptanceData, { recursive: true, force: true });
  }
  codexInvocation?.cleanup();
}
