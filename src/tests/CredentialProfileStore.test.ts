import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialProfileStore } from '../lifecycle/CredentialProfileStore.js';

describe('CredentialProfileStore', () => {
  let root: string;
  let profilePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runbeacon-credentials-'));
    profilePath = join(root, 'credential-profiles.json');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('persists passwordless SSH and GitHub credential references', () => {
    const store = new CredentialProfileStore(profilePath);
    const ssh = store.save({
      id: 'production',
      kind: 'ssh',
      host: 'server.example.com',
      port: 22,
      username: 'deploy',
      agent: 'auto',
      hostKeySha256: 'SHA256:synthetic-fingerprint',
    });
    const github = store.save({
      id: 'github-main',
      kind: 'github',
      host: 'github.com',
      credentialSource: 'git',
      username: 'octocat',
      credentialKind: 'pat',
    });

    expect(ssh.kind).toBe('ssh');
    expect(github.kind).toBe('github');
    expect(store.findSsh('SERVER.EXAMPLE.COM', 'deploy')).toHaveLength(1);
    expect(new CredentialProfileStore(profilePath).list()).toHaveLength(2);
    expect(readFileSync(profilePath, 'utf8')).toContain('"agent": "auto"');
    expect(readFileSync(profilePath, 'utf8')).toContain(
      '"credentialKind": "pat"'
    );
    expect(readFileSync(profilePath, 'utf8')).not.toMatch(
      /password|passphrase|token|privateKey"/i
    );
  });

  test('rejects secret fields and does not persist their values', () => {
    const store = new CredentialProfileStore(profilePath);
    const marker = 'PROFILE_SECRET_MUST_NOT_PERSIST_9321';
    expect(() =>
      store.save({
        id: 'unsafe',
        kind: 'ssh',
        host: 'server.example.com',
        port: 22,
        username: 'deploy',
        agent: 'auto',
        hostKeySha256: 'SHA256:test',
        password: marker,
      } as never)
    ).toThrow(/never store password/);
    expect(store.list()).toEqual([]);

    expect(() =>
      store.save({
        id: 'unsafe-github',
        kind: 'github',
        host: 'github.com',
        credentialSource: 'git',
        token: marker,
      } as never)
    ).toThrow(/never store token/);
    expect(store.list()).toEqual([]);
  });

  test('deletes only the RunBeacon reference profile', () => {
    const store = new CredentialProfileStore(profilePath);
    store.save({
      id: 'github-main',
      kind: 'github',
      host: 'github.com',
      credentialSource: 'git',
    });
    expect(store.delete('github-main').id).toBe('github-main');
    expect(store.list()).toEqual([]);
  });

  test('persists one default profile per credential kind and clears it on delete', () => {
    const store = new CredentialProfileStore(profilePath);
    store.save({
      id: 'production',
      kind: 'ssh',
      host: 'server.example.com',
      port: 22,
      username: 'deploy',
      agent: 'auto',
      hostKeySha256: 'SHA256:test',
    });
    store.save({
      id: 'github-main',
      kind: 'github',
      host: 'github.com',
      credentialSource: 'git',
      username: 'octocat',
    });

    store.setDefault('production');
    store.setDefault('github-main');
    expect(store.defaults()).toEqual({
      ssh: 'production',
      github: 'github-main',
    });

    const reloaded = new CredentialProfileStore(profilePath);
    expect(reloaded.getDefault('ssh')?.id).toBe('production');
    expect(reloaded.getDefault('github')?.id).toBe('github-main');
    reloaded.delete('production');
    expect(reloaded.getDefault('ssh')).toBeUndefined();
    expect(reloaded.getDefault('github')?.id).toBe('github-main');

    expect(reloaded.clearDefault('github')?.id).toBe('github-main');
    expect(reloaded.defaults()).toEqual({});
  });
});
