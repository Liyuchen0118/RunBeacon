import {
  CredentialProfileStore,
  SshCredentialProfile,
} from './CredentialProfileStore.js';
import {
  deleteSshPasswordCredential,
  readSshPasswordCredential,
  saveSshPasswordCredential,
  SshPasswordCredential,
} from './GitCredentialManager.js';

export interface SaveSshPasswordProfileInput {
  id: string;
  host: string;
  port?: number;
  username: string;
  password: string;
  hostKeySha256?: string;
  allowUnverifiedHostKey?: boolean;
  makeDefault?: boolean;
}

export interface SshPasswordCredentialBackend {
  save(input: SshPasswordCredential): Promise<void>;
  read(profileId: string, username: string): Promise<string | undefined>;
  delete(profileId: string, username: string): Promise<void>;
}

const systemCredentialBackend: SshPasswordCredentialBackend = {
  save: saveSshPasswordCredential,
  read: readSshPasswordCredential,
  delete: deleteSshPasswordCredential,
};

export class SshPasswordProfileManager {
  constructor(
    private readonly profiles: CredentialProfileStore,
    private readonly credentials: SshPasswordCredentialBackend = systemCredentialBackend
  ) {}

  async save(
    input: SaveSshPasswordProfileInput
  ): Promise<SshCredentialProfile> {
    const candidate = this.profiles.validate({
      id: input.id,
      kind: 'ssh',
      host: input.host,
      port: input.port ?? 22,
      username: input.username,
      credentialKind: 'password',
      hostKeySha256: input.hostKeySha256,
      allowUnverifiedHostKey:
        input.allowUnverifiedHostKey === true ? true : undefined,
    });
    if (candidate.kind !== 'ssh') {
      throw new Error('Expected an SSH credential profile');
    }

    const existing = this.profiles
      .list()
      .find((profile) => profile.id === candidate.id);
    if (existing && existing.kind !== 'ssh') {
      throw new Error(
        `Credential profile ${candidate.id} is not an SSH profile`
      );
    }
    if (
      existing?.kind === 'ssh' &&
      existing.credentialKind === 'password' &&
      existing.username !== candidate.username
    ) {
      throw new Error(
        `SSH password profile ${candidate.id} already belongs to ${existing.username}; delete and recreate it to change usernames`
      );
    }

    const previousPassword =
      existing?.kind === 'ssh' && existing.credentialKind === 'password'
        ? await this.credentials.read(existing.id, existing.username)
        : undefined;
    await this.credentials.save({
      profileId: candidate.id,
      username: candidate.username,
      password: input.password,
    });

    try {
      const profile = this.profiles.save(candidate, input.makeDefault === true);
      return profile as SshCredentialProfile;
    } catch (error) {
      await this.credentials
        .delete(candidate.id, candidate.username)
        .catch(() => undefined);
      if (previousPassword && existing?.kind === 'ssh') {
        await this.credentials
          .save({
            profileId: existing.id,
            username: existing.username,
            password: previousPassword,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async read(profile: SshCredentialProfile): Promise<string | undefined> {
    if (profile.credentialKind !== 'password') return undefined;
    return this.credentials.read(profile.id, profile.username);
  }

  async delete(id: string): Promise<{
    profile: SshCredentialProfile;
    credentialDeleted: boolean;
  }> {
    const selected = this.profiles.get(id);
    if (selected.kind !== 'ssh' || selected.credentialKind !== 'password') {
      throw new Error(
        `Credential profile ${id} is not an SSH password profile managed by RunBeacon`
      );
    }

    const previousPassword = await this.credentials.read(
      selected.id,
      selected.username
    );
    await this.credentials.delete(selected.id, selected.username);
    try {
      this.profiles.delete(selected.id);
    } catch (error) {
      if (previousPassword) {
        await this.credentials
          .save({
            profileId: selected.id,
            username: selected.username,
            password: previousPassword,
          })
          .catch(() => undefined);
      }
      throw error;
    }
    return {
      profile: selected,
      credentialDeleted: Boolean(previousPassword),
    };
  }
}
