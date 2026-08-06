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
  deleteSshPasswordCredential,
  deleteGitHubTokenCredential,
  hasGitHubTokenCredential,
  readSshPasswordCredential,
  saveGitHubTokenCredential,
  saveSshPasswordCredential,
  sshPasswordCredentialHost,
} from '../lifecycle/GitCredentialManager.js';

describe('GitCredentialManager', () => {
  let root: string;
  let credentialPath: string;
  let auditPath: string;
  let helperPath: string;
  let environment: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runbeacon-git-credential-'));
    credentialPath = join(root, 'credentials.txt');
    auditPath = join(root, 'credential-audit.txt');
    helperPath = join(root, 'credential-helper.cjs');
    writeFileSync(
      helperPath,
      [
        "'use strict';",
        "const fs = require('node:fs');",
        'const [file, audit, action] = process.argv.slice(2);',
        "let input = '';",
        "const parse = text => Object.fromEntries(text.split(/\\r?\\n/).filter(Boolean).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));",
        "const load = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', chunk => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  fs.appendFileSync(audit, JSON.stringify({ argv: process.argv.slice(2), secretEnvironmentKeys: Object.entries(process.env).filter(([, value]) => String(value).includes('SSH_PASSWORD_CANARY_MUST_STAY_ON_STDIN_6724')).map(([key]) => key) }) + '\\n');",
        '  const query = parse(input);',
        "  const key = [query.protocol || '', query.host || '', query.username || ''].join('|');",
        '  const entries = load();',
        "  if (action === 'store') { entries[key] = input; fs.writeFileSync(file, JSON.stringify(entries)); }",
        "  if (action === 'get' && entries[key]) process.stdout.write(entries[key]);",
        "  if (action === 'erase') { delete entries[key]; fs.writeFileSync(file, JSON.stringify(entries)); }",
        '});',
      ].join('\n')
    );
    const helperCommand = `!node ${helperPath.replaceAll('\\', '/')} ${credentialPath.replaceAll('\\', '/')} ${auditPath.replaceAll('\\', '/')}`;
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

  test('stores, reads, overwrites, and deletes SSH passwords by profile', async () => {
    const firstPassword = 'SSH_PASSWORD_CANARY_MUST_STAY_ON_STDIN_6724';
    const updatedPassword = ' SSH password with spaces 6724 ';
    await saveSshPasswordCredential(
      {
        profileId: 'training-primary',
        username: 'trainer',
        password: firstPassword,
      },
      { environment }
    );
    await saveSshPasswordCredential(
      {
        profileId: 'training-secondary',
        username: 'trainer',
        password: 'SECOND_PROFILE_PASSWORD_8461',
      },
      { environment }
    );

    await expect(
      readSshPasswordCredential('training-primary', 'trainer', {
        environment,
      })
    ).resolves.toBe(firstPassword);
    await expect(
      readSshPasswordCredential('training-secondary', 'trainer', {
        environment,
      })
    ).resolves.toBe('SECOND_PROFILE_PASSWORD_8461');
    expect(sshPasswordCredentialHost('training-primary')).not.toBe(
      sshPasswordCredentialHost('training-secondary')
    );

    await saveSshPasswordCredential(
      {
        profileId: 'training-primary',
        username: 'trainer',
        password: updatedPassword,
      },
      { environment }
    );
    await expect(
      readSshPasswordCredential('training-primary', 'trainer', {
        environment,
      })
    ).resolves.toBe(updatedPassword);

    const audit = readFileSync(auditPath, 'utf8');
    expect(audit).not.toContain(firstPassword);
    expect(audit).not.toContain('SECOND_PROFILE_PASSWORD_8461');
    expect(audit).toMatch(/"secretEnvironmentKeys":\[\]/);

    await deleteSshPasswordCredential('training-primary', 'trainer', {
      environment,
    });
    await expect(
      readSshPasswordCredential('training-primary', 'trainer', {
        environment,
      })
    ).resolves.toBeUndefined();
    await expect(
      readSshPasswordCredential('training-secondary', 'trainer', {
        environment,
      })
    ).resolves.toBe('SECOND_PROFILE_PASSWORD_8461');
  });

  test('rejects SSH password persistence through plaintext credential-store', async () => {
    const plaintextEnvironment = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: `store --file=${credentialPath.replaceAll('\\', '/')}`,
    };
    await expect(
      saveSshPasswordCredential(
        {
          profileId: 'training-primary',
          username: 'trainer',
          password: 'SSH_PASSWORD_CANARY_MUST_STAY_ON_STDIN_6724',
        },
        { environment: plaintextEnvironment }
      )
    ).rejects.toThrow(/plaintext Git credential store/);
    expect(existsSync(credentialPath)).toBe(false);
  });
});
