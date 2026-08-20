#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), 'runbeacon-security-state-')
);
const dataDir = path.join(temporary, 'canonical');
const sourceDir = path.join(temporary, 'legacy');
const daemonModule = pathToFileURL(
  path.join(root, 'dist', 'lifecycle', 'DaemonPaths.js')
).href;
const migrationModule = pathToFileURL(
  path.join(root, 'dist', 'lifecycle', 'CredentialProfileMigration.js')
).href;

try {
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, 'credential-profiles.json'),
    JSON.stringify({
      version: 1,
      profiles: [
        {
          id: 'concurrent-training',
          kind: 'ssh',
          host: '192.0.2.10',
          port: 22,
          username: 'runner',
          credentialKind: 'password',
          hostKeySha256: 'SHA256:test',
          createdAt: '2026-08-20T00:00:00.000Z',
          updatedAt: '2026-08-20T00:00:00.000Z',
        },
      ],
      defaults: { ssh: 'concurrent-training' },
    }),
    { mode: 0o600 }
  );

  const source = [
    `import { ensureDaemonToken, getDaemonPaths } from ${JSON.stringify(daemonModule)};`,
    `import { migrateRunBeaconCredentialProfiles } from ${JSON.stringify(migrationModule)};`,
    `const dataDir = ${JSON.stringify(dataDir)};`,
    `const sourceDir = ${JSON.stringify(sourceDir)};`,
    'const token = ensureDaemonToken(getDaemonPaths(dataDir));',
    'migrateRunBeaconCredentialProfiles(dataDir, [sourceDir]);',
    'process.stdout.write(token);',
  ].join('\n');
  const results = await Promise.all(
    Array.from({ length: 64 }, () => runChild(source))
  );
  assert.equal(
    new Set(results).size,
    1,
    'daemon callers observed different tokens'
  );
  assert.match(results[0], /^[0-9a-f]{64}$/);
  const profiles = JSON.parse(
    fs.readFileSync(path.join(dataDir, 'credential-profiles.json'), 'utf8')
  );
  assert.deepEqual(
    profiles.profiles.map((profile) => profile.id),
    ['concurrent-training']
  );
  assert.equal(profiles.defaults.ssh, 'concurrent-training');
  assert.equal(
    fs
      .readdirSync(dataDir)
      .some((name) => name.endsWith('.lock') || name.endsWith('.tmp')),
    false,
    'concurrent startup left lock or temporary files'
  );
  process.stdout.write(
    'Concurrent daemon token and credential migration passed\n'
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function runChild(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', source],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`security-state child exited ${code}: ${stderr}`));
    });
  });
}
