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
  restorePluginSource,
  stagePluginSource,
  swapPluginSource as swapPluginDirectories,
} from './codex-plugin-files.mjs';
import {
  parseCodexPluginInstallResult,
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
const staging = `${pluginTarget}.acceptance-stage-${process.pid}`;
const backup = `${pluginTarget}.acceptance-backup-${process.pid}`;
const pluginSourceExisted = fs.existsSync(pluginTarget);
let stagePrepared = false;
let sourceSwapped = false;
let codexInvocation;
let marketplaceName;
let pluginSelector;
let installationAttempted = false;
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
  fs.mkdirSync(path.dirname(pluginTarget), { recursive: true });
  fs.rmSync(backup, { recursive: true, force: true });
  try {
    stagePluginSource(root, staging);
    stagePrepared = true;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function swapPluginSource() {
  try {
    swapPluginDirectories(staging, pluginTarget, backup);
    stagePrepared = false;
    sourceSwapped = true;
  } catch (error) {
    throw error;
  }
}

function installPlugin() {
  installationAttempted = true;
  const installed = parseCodexPluginInstallResult(
    run(codexInvocation.command, ['plugin', 'add', pluginSelector, '--json'])
      .stdout,
    pluginSelector
  );
  const installedManifest = JSON.parse(
    fs.readFileSync(
      path.join(installed.installedPath, '.codex-plugin', 'plugin.json'),
      'utf8'
    )
  );
  const sourceManifest = JSON.parse(
    fs.readFileSync(
      path.join(pluginTarget, '.codex-plugin', 'plugin.json'),
      'utf8'
    )
  );
  assert.equal(installed.version, sourceManifest.version);
  assert.equal(installedManifest.version, sourceManifest.version);
  return installed;
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
  stagePlugin();
  run(python, [
    path.join(pluginCreator, 'scripts', 'update_plugin_cachebuster.py'),
    staging,
  ]);
  runNpm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: staging,
  });
  run(python, [
    path.join(pluginCreator, 'scripts', 'validate_plugin.py'),
    staging,
  ]);
  run(python, [
    path.join(skillCreator, 'scripts', 'quick_validate.py'),
    path.join(staging, 'skills', 'monitor-remote-jobs'),
  ]);
  swapPluginSource();
  const installed = installPlugin();
  const prompt = [
    'Use RunBeacon job_start to run this as a local tracked command:',
    'node -e "console.log(\'RUNBEACON_CODEX_ACCEPTANCE\')"',
    'Call job_start exactly once. If that call is rejected or fails before returning a jobId, stop and report the failure without retrying.',
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
    details: {
      marketplaceName,
      installedVersion: installed.version,
    },
  });
  if (sourceSwapped) fs.rmSync(backup, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  let rollbackError;
  if (sourceSwapped) {
    restorePluginSource(pluginTarget, backup, pluginSourceExisted);
  }
  if (stagePrepared) {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  if (installationAttempted && codexInvocation && pluginSelector) {
    try {
      if (pluginSourceExisted) {
        parseCodexPluginInstallResult(
          run(codexInvocation.command, [
            'plugin',
            'add',
            pluginSelector,
            '--json',
          ]).stdout,
          pluginSelector
        );
      } else {
        run(codexInvocation.command, [
          'plugin',
          'remove',
          pluginSelector,
          '--json',
        ]);
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
  if (stagePrepared) {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  if (acceptanceData) {
    fs.rmSync(acceptanceData, { recursive: true, force: true });
  }
  codexInvocation?.cleanup();
}
