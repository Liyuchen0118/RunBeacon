import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

interface CredentialProfileBase {
  id: string;
  kind: 'ssh' | 'github';
  createdAt: string;
  updatedAt: string;
}

export interface SshCredentialProfile extends CredentialProfileBase {
  kind: 'ssh';
  host: string;
  port: number;
  username: string;
  credentialKind?: 'password';
  privateKeyPath?: string;
  agent?: string;
  hostKeySha256?: string;
  allowUnverifiedHostKey?: boolean;
}

export interface GitHubCredentialProfile extends CredentialProfileBase {
  kind: 'github';
  host: 'github.com';
  credentialSource: 'git';
  username?: string;
  credentialKind?: 'credential-helper' | 'pat';
}

export type CredentialProfile = SshCredentialProfile | GitHubCredentialProfile;

export type SaveCredentialProfileInput =
  | Omit<SshCredentialProfile, 'createdAt' | 'updatedAt'>
  | Omit<GitHubCredentialProfile, 'createdAt' | 'updatedAt'>;

interface CredentialProfileDocument {
  version: 1;
  profiles: CredentialProfile[];
  defaults?: Partial<Record<CredentialProfile['kind'], string>>;
}

export class CredentialProfileStore {
  private readonly profiles = new Map<string, CredentialProfile>();
  private readonly defaultProfileIds: Partial<
    Record<CredentialProfile['kind'], string>
  > = {};

  constructor(private readonly filePath: string) {
    const document = this.load();
    for (const profile of document.profiles) {
      this.profiles.set(profile.id, profile);
    }
    for (const kind of ['ssh', 'github'] as const) {
      const id = document.defaults?.[kind];
      const profile = id ? this.profiles.get(id) : undefined;
      if (profile?.kind === kind) this.defaultProfileIds[kind] = id;
    }
  }

  list(kind?: CredentialProfile['kind']): CredentialProfile[] {
    return Array.from(this.profiles.values())
      .filter((profile) => !kind || profile.kind === kind)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  get(id: string): CredentialProfile {
    const profile = this.profiles.get(normalizeId(id));
    if (!profile) throw new Error(`Credential profile not found: ${id}`);
    return profile;
  }

  getDefault<TKind extends CredentialProfile['kind']>(
    kind: TKind
  ): Extract<CredentialProfile, { kind: TKind }> | undefined {
    const id = this.defaultProfileIds[kind];
    const profile = id ? this.profiles.get(id) : undefined;
    return profile?.kind === kind
      ? (profile as Extract<CredentialProfile, { kind: TKind }>)
      : undefined;
  }

  defaults(): Partial<Record<CredentialProfile['kind'], string>> {
    return { ...this.defaultProfileIds };
  }

  setDefault(id: string): CredentialProfile {
    const profile = this.get(id);
    const previous = this.defaultProfileIds[profile.kind];
    this.defaultProfileIds[profile.kind] = profile.id;
    try {
      this.persist();
    } catch (error) {
      if (previous) this.defaultProfileIds[profile.kind] = previous;
      else delete this.defaultProfileIds[profile.kind];
      throw error;
    }
    return profile;
  }

  clearDefault(kind: CredentialProfile['kind']): CredentialProfile | undefined {
    const profile = this.getDefault(kind);
    delete this.defaultProfileIds[kind];
    try {
      this.persist();
    } catch (error) {
      if (profile) this.defaultProfileIds[kind] = profile.id;
      throw error;
    }
    return profile;
  }

  validate(input: SaveCredentialProfileInput): SaveCredentialProfileInput {
    rejectSecretFields(input as unknown as Record<string, unknown>);
    return normalizeProfile(input);
  }

  save(
    input: SaveCredentialProfileInput,
    makeDefault = false
  ): CredentialProfile {
    const normalized = this.validate(input);
    const existing = this.profiles.get(normalized.id);
    const previousDefault = this.defaultProfileIds[normalized.kind];
    const now = new Date().toISOString();
    const profile: CredentialProfile = {
      ...normalized,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } as CredentialProfile;
    this.profiles.set(profile.id, profile);
    if (makeDefault) this.defaultProfileIds[profile.kind] = profile.id;
    try {
      this.persist();
    } catch (error) {
      if (existing) this.profiles.set(existing.id, existing);
      else this.profiles.delete(profile.id);
      if (previousDefault) {
        this.defaultProfileIds[profile.kind] = previousDefault;
      } else {
        delete this.defaultProfileIds[profile.kind];
      }
      throw error;
    }
    return profile;
  }

  delete(id: string): CredentialProfile {
    const profile = this.get(id);
    const previousDefault = this.defaultProfileIds[profile.kind];
    this.profiles.delete(profile.id);
    if (this.defaultProfileIds[profile.kind] === profile.id) {
      delete this.defaultProfileIds[profile.kind];
    }
    try {
      this.persist();
    } catch (error) {
      this.profiles.set(profile.id, profile);
      if (previousDefault) {
        this.defaultProfileIds[profile.kind] = previousDefault;
      }
      throw error;
    }
    return profile;
  }

  findSsh(host: string, username?: string): SshCredentialProfile[] {
    const normalizedHost = host.trim().toLowerCase();
    const normalizedUsername = username?.trim();
    return this.list('ssh').filter(
      (profile): profile is SshCredentialProfile =>
        profile.kind === 'ssh' &&
        profile.host.toLowerCase() === normalizedHost &&
        (!normalizedUsername || profile.username === normalizedUsername)
    );
  }

  private load(): CredentialProfileDocument {
    if (!existsSync(this.filePath)) return { version: 1, profiles: [] };
    try {
      const document = JSON.parse(
        readFileSync(this.filePath, 'utf8')
      ) as CredentialProfileDocument;
      if (document.version !== 1 || !Array.isArray(document.profiles))
        return { version: 1, profiles: [] };
      return {
        version: 1,
        profiles: document.profiles
          .map(normalizeStoredProfile)
          .filter((profile): profile is CredentialProfile => Boolean(profile)),
        defaults:
          document.defaults && typeof document.defaults === 'object'
            ? document.defaults
            : undefined,
      };
    } catch {
      return { version: 1, profiles: [] };
    }
  }

  private persist(): void {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp`;
    const document: CredentialProfileDocument = {
      version: 1,
      profiles: this.list(),
      defaults: this.defaults(),
    };
    writeFileSync(temporaryPath, JSON.stringify(document, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (process.platform !== 'win32') chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.filePath);
    if (process.platform !== 'win32') chmodSync(this.filePath, 0o600);
  }
}

function normalizeProfile(
  input: SaveCredentialProfileInput
): SaveCredentialProfileInput {
  const id = normalizeId(input.id);
  if (input.kind === 'github') {
    const host = input.host?.trim().toLowerCase() || 'github.com';
    if (host !== 'github.com') {
      throw new Error(
        'GitHub credential profiles currently support github.com'
      );
    }
    const username = normalizeOptional(input.username, 128);
    const credentialKind =
      input.credentialKind === 'pat' ? 'pat' : 'credential-helper';
    return {
      id,
      kind: 'github',
      host,
      credentialSource: 'git',
      username,
      credentialKind,
    };
  }

  const host = normalizeRequired(input.host, 'host', 253);
  if (/\s/.test(host))
    throw new Error('SSH profile host must not contain whitespace');
  const username = normalizeRequired(input.username, 'username', 128);
  const port = input.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SSH profile port must be between 1 and 65535');
  }
  const privateKeyPath = normalizeOptional(input.privateKeyPath, 4_000);
  const agent = normalizeOptional(input.agent, 4_000);
  if (
    input.credentialKind !== undefined &&
    input.credentialKind !== 'password'
  ) {
    throw new Error('Unsupported SSH credential kind');
  }
  const credentialKind =
    input.credentialKind === 'password' ? 'password' : undefined;
  if (credentialKind && (privateKeyPath || agent)) {
    throw new Error(
      'SSH password profiles cannot also contain a private-key path or SSH agent reference'
    );
  }
  if (!credentialKind && !privateKeyPath && !agent) {
    throw new Error(
      'SSH profile requires credentialKind="password", privateKeyPath, or agent="auto"/an SSH agent path; passwords are never stored in the profile'
    );
  }
  const hostKeySha256 = normalizeOptional(input.hostKeySha256, 200);
  if (!hostKeySha256 && input.allowUnverifiedHostKey !== true) {
    throw new Error(
      'SSH profile requires hostKeySha256 unless allowUnverifiedHostKey=true is explicitly accepted'
    );
  }
  return {
    id,
    kind: 'ssh',
    host,
    port,
    username,
    credentialKind,
    privateKeyPath,
    agent,
    hostKeySha256,
    allowUnverifiedHostKey:
      input.allowUnverifiedHostKey === true ? true : undefined,
  };
}

function normalizeStoredProfile(value: unknown): CredentialProfile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') {
    return undefined;
  }
  try {
    const normalized = normalizeProfile(
      raw as unknown as SaveCredentialProfileInput
    );
    return {
      ...normalized,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    } as CredentialProfile;
  } catch {
    return undefined;
  }
}

function normalizeId(value: string): string {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new Error(
      'Credential profile id must contain 1 to 64 letters, numbers, dots, underscores, or hyphens'
    );
  }
  return id;
}

function normalizeRequired(value: string, name: string, limit: number): string {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > limit || /[\r\n\0]/.test(normalized)) {
    throw new Error(
      `${name} is required and must not exceed ${limit} characters`
    );
  }
  return normalized;
}

function normalizeOptional(
  value: string | undefined,
  limit: number
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = String(value).trim();
  if (!normalized) return undefined;
  if (normalized.length > limit || /[\r\n\0]/.test(normalized)) {
    throw new Error(
      `Credential profile value must not exceed ${limit} characters`
    );
  }
  return normalized;
}

function rejectSecretFields(input: Record<string, unknown>): void {
  const supplied = Object.keys(input).find(
    (key) =>
      key !== 'privateKeyPath' &&
      /password|passphrase|token|secret|privatekey|authorization/i.test(key) &&
      input[key] !== undefined
  );
  if (supplied) {
    throw new Error(
      `Credential profiles never store ${supplied}; use an OS credential manager, SSH agent, or private-key path`
    );
  }
}
