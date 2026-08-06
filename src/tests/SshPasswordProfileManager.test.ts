import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialProfileStore } from '../lifecycle/CredentialProfileStore.js';
import {
  SshPasswordCredentialBackend,
  SshPasswordProfileManager,
} from '../lifecycle/SshPasswordProfileManager.js';
import { SshPasswordCredential } from '../lifecycle/GitCredentialManager.js';

class MemoryCredentialBackend implements SshPasswordCredentialBackend {
  readonly secrets = new Map<string, string>();
  failNextSave = false;

  async save(input: SshPasswordCredential): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('synthetic credential helper failure');
    }
    this.secrets.set(this.key(input.profileId, input.username), input.password);
  }

  async read(profileId: string, username: string): Promise<string | undefined> {
    return this.secrets.get(this.key(profileId, username));
  }

  async delete(profileId: string, username: string): Promise<void> {
    this.secrets.delete(this.key(profileId, username));
  }

  private key(profileId: string, username: string): string {
    return `${profileId}\0${username.toLowerCase()}`;
  }
}

describe('SshPasswordProfileManager', () => {
  let root: string;
  let profilePath: string;
  let profiles: CredentialProfileStore;
  let credentials: MemoryCredentialBackend;
  let manager: SshPasswordProfileManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runbeacon-ssh-password-profile-'));
    profilePath = join(root, 'credential-profiles.json');
    profiles = new CredentialProfileStore(profilePath);
    credentials = new MemoryCredentialBackend();
    manager = new SshPasswordProfileManager(profiles, credentials);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('stores only a safe default profile and resolves its password from the backend', async () => {
    const password = 'SSH_PROFILE_SECRET_MUST_NOT_PERSIST_1047';
    const profile = await manager.save({
      id: 'training-primary',
      host: '192.0.2.10',
      username: 'trainer',
      password,
      hostKeySha256: 'SHA256:training-host-key',
      makeDefault: true,
    });

    expect(profile).toMatchObject({
      kind: 'ssh',
      credentialKind: 'password',
      host: '192.0.2.10',
      username: 'trainer',
    });
    expect(profiles.getDefault('ssh')?.id).toBe('training-primary');
    await expect(manager.read(profile)).resolves.toBe(password);
    const persisted = readFileSync(profilePath, 'utf8');
    expect(persisted).not.toContain(password);
    expect(persisted).not.toMatch(/"password"\s*:/i);
  });

  test('does not create a profile when the credential helper fails', async () => {
    credentials.failNextSave = true;
    await expect(
      manager.save({
        id: 'training-primary',
        host: '192.0.2.10',
        username: 'trainer',
        password: 'SSH_PROFILE_SECRET_1047',
        allowUnverifiedHostKey: true,
      })
    ).rejects.toThrow(/credential helper failure/);
    expect(profiles.list()).toEqual([]);
    expect(credentials.secrets.size).toBe(0);
  });

  test('restores the previous password when profile persistence fails', async () => {
    const profile = await manager.save({
      id: 'training-primary',
      host: '192.0.2.10',
      username: 'trainer',
      password: 'ORIGINAL_PASSWORD_1047',
      allowUnverifiedHostKey: true,
    });
    jest.spyOn(profiles, 'save').mockImplementationOnce(() => {
      throw new Error('synthetic profile persistence failure');
    });

    await expect(
      manager.save({
        id: profile.id,
        host: '192.0.2.11',
        username: profile.username,
        password: 'REPLACEMENT_PASSWORD_1047',
        allowUnverifiedHostKey: true,
      })
    ).rejects.toThrow(/profile persistence failure/);
    await expect(manager.read(profile)).resolves.toBe('ORIGINAL_PASSWORD_1047');
    expect(profiles.get(profile.id).host).toBe('192.0.2.10');
  });

  test('keeps same-host profiles isolated and deletes only the selected password', async () => {
    const first = await manager.save({
      id: 'training-primary',
      host: '192.0.2.10',
      username: 'trainer-a',
      password: 'FIRST_PASSWORD_1047',
      allowUnverifiedHostKey: true,
    });
    const second = await manager.save({
      id: 'training-secondary',
      host: '192.0.2.10',
      username: 'trainer-b',
      password: 'SECOND_PASSWORD_1047',
      allowUnverifiedHostKey: true,
    });

    await expect(manager.read(first)).resolves.toBe('FIRST_PASSWORD_1047');
    await expect(manager.read(second)).resolves.toBe('SECOND_PASSWORD_1047');
    await expect(manager.delete(first.id)).resolves.toMatchObject({
      credentialDeleted: true,
    });
    expect(profiles.list('ssh').map((profile) => profile.id)).toEqual([
      'training-secondary',
    ]);
    await expect(manager.read(second)).resolves.toBe('SECOND_PASSWORD_1047');
  });

  test('rejects changing the username of an existing password profile', async () => {
    await manager.save({
      id: 'training-primary',
      host: '192.0.2.10',
      username: 'trainer-a',
      password: 'FIRST_PASSWORD_1047',
      allowUnverifiedHostKey: true,
    });

    await expect(
      manager.save({
        id: 'training-primary',
        host: '192.0.2.10',
        username: 'trainer-b',
        password: 'SECOND_PASSWORD_1047',
        allowUnverifiedHostKey: true,
      })
    ).rejects.toThrow(/delete and recreate/);
    expect(credentials.secrets.size).toBe(1);
  });
});
