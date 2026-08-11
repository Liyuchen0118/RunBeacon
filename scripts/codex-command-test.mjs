import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isCodexPluginInstalled,
  isWindowsStoreCodexBinary,
  prepareCodexCommand,
  WINDOWS_CODEX_COMPANIONS,
} from './acceptance/codex-command.mjs';

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
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

process.stdout.write('Codex command preparation tests passed\n');
