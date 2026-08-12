import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = fs.mkdtempSync(
  path.join(root, '.runbeacon-package-smoke-')
);
const npmEnvironment = {
  ...process.env,
  npm_config_cache: path.join(temporaryDirectory, 'npm-cache'),
};

const npmInvocation = (args) => {
  if (process.env.npm_execpath) {
    return spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: npmEnvironment,
    });
  }

  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: root,
    encoding: 'utf8',
    env: npmEnvironment,
  });
};

try {
  const packed = npmInvocation([
    'pack',
    '--quiet',
    '--pack-destination',
    temporaryDirectory,
  ]);
  assert.equal(
    packed.status,
    0,
    `npm pack failed:\n${packed.stdout}\n${packed.stderr}`
  );

  const archive = fs
    .readdirSync(temporaryDirectory)
    .find((entry) => entry.endsWith('.tgz'));
  assert.ok(archive, 'npm pack did not create an archive');

  const packageRoot = path.join(
    temporaryDirectory,
    'node_modules',
    'console-automation-mcp'
  );
  fs.mkdirSync(packageRoot, { recursive: true });
  const installed = spawnSync(
    'tar',
    [
      '-xzf',
      path.join(temporaryDirectory, archive),
      '-C',
      packageRoot,
      '--strip-components=1',
    ],
    { encoding: 'utf8' }
  );
  assert.equal(
    installed.status,
    0,
    `Package extraction failed:\n${installed.stdout}\n${installed.stderr}`
  );

  const serverPath = path.join(
    packageRoot,
    'dist',
    'mcp',
    'lifecycle-server.js'
  );
  assert.ok(fs.existsSync(serverPath), 'Packed MCP entry point is missing');
  const pluginManifest = JSON.parse(
    fs.readFileSync(
      path.join(packageRoot, '.codex-plugin', 'plugin.json'),
      'utf8'
    )
  );
  const pluginPackage = JSON.parse(
    fs.readFileSync(
      path.join(root, 'packages', 'codex-plugin', 'package.json'),
      'utf8'
    )
  );
  assert.equal(pluginManifest.name, 'remote-job-monitor');
  const pluginBaseVersion = pluginPackage.version.replaceAll('.', '\\.');
  assert.match(
    pluginManifest.version,
    new RegExp(`^${pluginBaseVersion}\\+codex\\.\\d{14}$`),
    'Packed plugin manifest is not bound to the workspace plugin version'
  );
  assert.equal(pluginManifest.mcpServers, './.mcp.json');
  for (const relative of [
    '.mcp.json',
    'hooks/hooks.json',
    'hooks/inject-job-trace.cjs',
    'hooks/pending-trace.cjs',
    'hooks/route-remote-prompt.cjs',
    'hooks/route-ssh.cjs',
    'skills/monitor-remote-jobs/SKILL.md',
    'skills/monitor-remote-jobs/agents/openai.yaml',
  ]) {
    assert.ok(
      fs.existsSync(path.join(packageRoot, relative)),
      `Packed Codex plugin file is missing: ${relative}`
    );
  }
  assert.equal(
    fs.existsSync(path.join(packageRoot, 'src')),
    false,
    'Source tree leaked into the production package'
  );
  assert.equal(
    fs.existsSync(path.join(packageRoot, 'dist', 'core')),
    false,
    'Legacy core leaked into the production package'
  );
  assert.equal(
    fs.existsSync(path.join(packageRoot, 'dist', 'protocols')),
    false,
    'Legacy protocols leaked into the production package'
  );

  const smoke = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'lifecycle-mcp-smoke-test.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNBEACON_SERVER_PATH: serverPath,
      },
    }
  );
  assert.equal(
    smoke.status,
    0,
    `Packed MCP smoke test failed:\n${smoke.stdout}\n${smoke.stderr}`
  );
  assert.equal(
    smoke.stderr.trim(),
    '',
    `Packed MCP wrote unexpected startup diagnostics:\n${smoke.stderr}`
  );

  process.stdout.write(
    `${JSON.stringify({ packageContents: 'minimal', isolatedExtraction: 'passed', lifecycleServer: 'passed', codexPlugin: 'passed' })}\n`
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
