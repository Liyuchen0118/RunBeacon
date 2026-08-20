import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCodexAcceptanceArgs,
  isCodexPluginInstalled,
  isWindowsStoreCodexBinary,
  parseCodexPluginInstallResult,
  prepareCodexCommand,
  WINDOWS_CODEX_COMPANIONS,
} from './acceptance/codex-command.mjs';
import {
  renameDirectoryWithRetry,
  restorePluginSource,
  stagePluginSource,
  swapPluginSource,
} from './acceptance/codex-plugin-files.mjs';

const acceptanceArgs = buildCodexAcceptanceArgs('acceptance prompt');
assert.deepEqual(acceptanceArgs, [
  'exec',
  '--json',
  '--approve-for-me',
  '--skip-git-repo-check',
  'acceptance prompt',
]);
assert.equal(acceptanceArgs.includes('--sandbox'), false);

const pluginList = `Marketplace \`personal\`
C:\\Users\\example\\.agents\\plugins\\marketplace.json

PLUGIN                       STATUS              VERSION  PATH
remote-job-monitor@personal  installed, enabled  2.0.0    C:\\plugins\\remote-job-monitor
other@team                   not installed                C:\\plugins\\other
`;
assert.equal(
  isCodexPluginInstalled(pluginList, 'remote-job-monitor@personal'),
  true
);
assert.equal(isCodexPluginInstalled(pluginList, 'other@team'), false);
assert.equal(isCodexPluginInstalled(pluginList, 'missing@personal'), false);

const installed = parseCodexPluginInstallResult(
  JSON.stringify({
    pluginId: 'remote-job-monitor@personal',
    version: '2.0.0+codex.fixture',
    installedPath: 'C:\\cache\\remote-job-monitor\\2.0.0+codex.fixture',
  }),
  'remote-job-monitor@personal'
);
assert.equal(installed.version, '2.0.0+codex.fixture');
assert.throws(
  () =>
    parseCodexPluginInstallResult(
      JSON.stringify({
        pluginId: 'other@personal',
        version: '2.0.0',
        installedPath: '/tmp/other',
      }),
      'remote-job-monitor@personal'
    ),
  /instead of/
);
assert.throws(
  () =>
    parseCodexPluginInstallResult(
      JSON.stringify({
        pluginId: 'remote-job-monitor@personal',
        version: '2.0.0',
      }),
      'remote-job-monitor@personal'
    ),
  /installed path/
);

const storeCodex =
  'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3.0_x64__publisher\\app\\resources\\codex.exe';
assert.equal(isWindowsStoreCodexBinary(storeCodex), true);
assert.equal(isWindowsStoreCodexBinary('C:\\tools\\codex.exe'), false);
assert.equal(isWindowsStoreCodexBinary('/usr/local/bin/codex'), false);

const direct = prepareCodexCommand({
  configuredCommand: '/usr/local/bin/codex',
  platform: 'linux',
});
assert.equal(direct.command, '/usr/local/bin/codex');
direct.cleanup();

const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'runbeacon-codex-command-test-')
);
try {
  const source = path.join(
    fixtureRoot,
    'Program Files',
    'WindowsApps',
    'OpenAI.Codex_1.2.3.0_x64__publisher',
    'app',
    'resources',
    'codex.exe'
  );
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'signed-codex-fixture');
  for (const companion of WINDOWS_CODEX_COMPANIONS) {
    fs.writeFileSync(path.join(path.dirname(source), companion), companion);
  }
  const staged = prepareCodexCommand({
    configuredCommand: source,
    platform: 'win32',
    tempRoot: fixtureRoot,
  });
  assert.notEqual(staged.command, source);
  assert.equal(fs.readFileSync(staged.command, 'utf8'), 'signed-codex-fixture');
  for (const companion of WINDOWS_CODEX_COMPANIONS) {
    assert.equal(
      fs.readFileSync(
        path.join(path.dirname(staged.command), companion),
        'utf8'
      ),
      companion
    );
  }
  const stagedDirectory = path.dirname(staged.command);
  staged.cleanup();
  assert.equal(fs.existsSync(stagedDirectory), false);

  const pluginSource = path.join(fixtureRoot, 'plugin-source');
  const pluginStaging = path.join(fixtureRoot, 'plugin-stage');
  const pluginTarget = path.join(fixtureRoot, 'plugin-target');
  const pluginBackup = path.join(fixtureRoot, 'plugin-backup');
  fs.mkdirSync(path.join(pluginSource, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginSource, '.codex-plugin', 'plugin.json'),
    'new'
  );
  for (const excluded of [
    '.git',
    '.codex-tmp',
    '.tools',
    'acceptance-results',
    'coverage',
    'data',
    'diagnostics',
    'node_modules',
    'runner-assets',
    'test-diagnostics',
    'test-results',
  ]) {
    fs.mkdirSync(path.join(pluginSource, excluded), { recursive: true });
    fs.writeFileSync(path.join(pluginSource, excluded, 'generated'), excluded);
  }
  fs.writeFileSync(path.join(pluginSource, 'test-report.xml'), 'generated');
  stagePluginSource(pluginSource, pluginStaging);
  assert.equal(
    fs.readFileSync(
      path.join(pluginStaging, '.codex-plugin', 'plugin.json'),
      'utf8'
    ),
    'new'
  );
  for (const excluded of [
    '.git',
    '.codex-tmp',
    '.tools',
    'acceptance-results',
    'coverage',
    'data',
    'diagnostics',
    'node_modules',
    'runner-assets',
    'test-diagnostics',
    'test-results',
    'test-report.xml',
  ]) {
    assert.equal(fs.existsSync(path.join(pluginStaging, excluded)), false);
  }

  fs.mkdirSync(pluginTarget);
  fs.writeFileSync(path.join(pluginTarget, 'version'), 'old');
  const targetExisted = swapPluginSource(
    pluginStaging,
    pluginTarget,
    pluginBackup
  );
  assert.equal(targetExisted, true);
  assert.equal(
    fs.readFileSync(
      path.join(pluginTarget, '.codex-plugin', 'plugin.json'),
      'utf8'
    ),
    'new'
  );
  assert.equal(
    fs.readFileSync(path.join(pluginBackup, 'version'), 'utf8'),
    'old'
  );
  restorePluginSource(pluginTarget, pluginBackup, targetExisted);
  assert.equal(
    fs.readFileSync(path.join(pluginTarget, 'version'), 'utf8'),
    'old'
  );

  const retrySource = path.join(fixtureRoot, 'retry-source');
  const retryTarget = path.join(fixtureRoot, 'retry-target');
  fs.mkdirSync(retrySource);
  let renameAttempts = 0;
  renameDirectoryWithRetry(retrySource, retryTarget, {
    attempts: 3,
    delayMs: 0,
    sleep() {},
    rename(source, target) {
      renameAttempts += 1;
      if (renameAttempts < 3) {
        const error = new Error('directory is temporarily locked');
        error.code = 'EPERM';
        throw error;
      }
      fs.renameSync(source, target);
    },
  });
  assert.equal(renameAttempts, 3);
  assert.equal(fs.existsSync(retryTarget), true);

  let permanentAttempts = 0;
  assert.throws(
    () =>
      renameDirectoryWithRetry('missing', 'target', {
        attempts: 10,
        delayMs: 0,
        sleep() {},
        rename() {
          permanentAttempts += 1;
          const error = new Error('source is missing');
          error.code = 'ENOENT';
          throw error;
        },
      }),
    /source is missing/
  );
  assert.equal(permanentAttempts, 1);

  const atomicTarget = path.join(fixtureRoot, 'atomic-target');
  const atomicBackup = path.join(fixtureRoot, 'atomic-backup');
  fs.mkdirSync(atomicTarget);
  fs.mkdirSync(atomicBackup);
  fs.writeFileSync(path.join(atomicTarget, 'version'), 'new');
  fs.writeFileSync(path.join(atomicBackup, 'version'), 'old');
  let atomicRenameAttempts = 0;
  assert.throws(
    () =>
      restorePluginSource(atomicTarget, atomicBackup, true, {
        attempts: 1,
        delayMs: 0,
        sleep() {},
        rename(source, target) {
          atomicRenameAttempts += 1;
          if (source === atomicBackup) {
            const error = new Error('backup remains temporarily unavailable');
            error.code = 'ENOENT';
            throw error;
          }
          fs.renameSync(source, target);
        },
      }),
    /backup remains temporarily unavailable/
  );
  assert.equal(atomicRenameAttempts, 3);
  assert.equal(
    fs.readFileSync(path.join(atomicTarget, 'version'), 'utf8'),
    'new'
  );
  assert.equal(
    fs.readFileSync(path.join(atomicBackup, 'version'), 'utf8'),
    'old'
  );

  const missingStage = path.join(fixtureRoot, 'missing-stage');
  const failedTarget = path.join(fixtureRoot, 'failed-target');
  const failedBackup = path.join(fixtureRoot, 'failed-backup');
  fs.mkdirSync(failedTarget);
  fs.writeFileSync(path.join(failedTarget, 'version'), 'old');
  assert.throws(
    () => swapPluginSource(missingStage, failedTarget, failedBackup),
    /ENOENT|not found|cannot find|no such file/i
  );
  assert.equal(
    fs.readFileSync(path.join(failedTarget, 'version'), 'utf8'),
    'old'
  );
  assert.equal(fs.existsSync(failedBackup), false);

  const preservedTarget = path.join(fixtureRoot, 'preserved-target');
  fs.mkdirSync(preservedTarget);
  fs.writeFileSync(path.join(preservedTarget, 'version'), 'new');
  assert.throws(
    () =>
      restorePluginSource(
        preservedTarget,
        path.join(fixtureRoot, 'missing-backup'),
        true
      ),
    /backup is missing/
  );
  assert.equal(
    fs.readFileSync(path.join(preservedTarget, 'version'), 'utf8'),
    'new'
  );
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

process.stdout.write('Codex command preparation tests passed\n');
