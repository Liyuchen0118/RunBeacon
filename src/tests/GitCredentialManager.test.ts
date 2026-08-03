import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteGitHubTokenCredential,
  hasGitHubTokenCredential,
  saveGitHubTokenCredential,
} from '../lifecycle/GitCredentialManager.js';

describe('GitCredentialManager', () => {
  let root: string;
  let credentialPath: string;
  let helperPath: string;
  let environment: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runbeacon-git-credential-'));
    credentialPath = join(root, 'credentials.txt');
    helperPath = join(root, 'credential-helper.cjs');
    writeFileSync(
      helperPath,
      [
        "'use strict';",
        "const fs = require('node:fs');",
        'const [file, action] = process.argv.slice(2);',
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', chunk => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  if (action === 'store') fs.writeFileSync(file, input);",
        "  if (action === 'get' && fs.existsSync(file)) process.stdout.write(fs.readFileSync(file, 'utf8'));",
        "  if (action === 'erase' && fs.existsSync(file)) fs.rmSync(file);",
        '});',
      ].join('\n')
    );
    const helperCommand = `!node ${helperPath.replaceAll('\\', '/')} ${credentialPath.replaceAll('\\', '/')}`;
    environment = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: helperCommand,
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('stores, verifies, and deletes a PAT through the configured helper', async () => {
    const token = 'github_pat_TEST_ONLY_12345678901234567890';
    await saveGitHubTokenCredential(
      { username: 'runbeacon-test', token },
      { environment }
    );

    expect(existsSync(credentialPath)).toBe(true);
    expect(readFileSync(credentialPath, 'utf8')).toContain(token);
    await expect(
      hasGitHubTokenCredential('github.com', 'runbeacon-test', {
        environment,
      })
    ).resolves.toBe(true);

    await deleteGitHubTokenCredential('github.com', 'runbeacon-test', {
      environment,
    });
    await expect(
      hasGitHubTokenCredential('github.com', 'runbeacon-test', {
        environment,
      })
    ).resolves.toBe(false);
  });

  test('rejects malformed tokens before invoking the helper', async () => {
    await expect(
      saveGitHubTokenCredential(
        { username: 'runbeacon-test', token: 'too-short' },
        { environment }
      )
    ).rejects.toThrow(/invalid format/);
    expect(existsSync(credentialPath)).toBe(false);
  });

  test('rejects the plaintext credential store helper', async () => {
    const plaintextEnvironment = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: `store --file=${credentialPath.replaceAll('\\', '/')}`,
    };
    await expect(
      saveGitHubTokenCredential(
        {
          username: 'runbeacon-test',
          token: 'github_pat_TEST_ONLY_12345678901234567890',
        },
        { environment: plaintextEnvironment }
      )
    ).rejects.toThrow(/plaintext Git credential store/);
    expect(existsSync(credentialPath)).toBe(false);
  });
});
