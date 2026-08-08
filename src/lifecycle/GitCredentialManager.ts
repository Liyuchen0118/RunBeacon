import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parseGitCredentialOutput } from './GitHubPublish.js';

export interface GitHubTokenCredential {
  host?: 'github.com';
  username: string;
  token: string;
}

export interface GitCredentialCommandOptions {
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface SshPasswordCredential {
  profileId: string;
  username: string;
  password: string;
}

export async function saveGitHubTokenCredential(
  input: GitHubTokenCredential,
  options: GitCredentialCommandOptions = {}
): Promise<void> {
  const credential = normalizeCredential(input);
  await rejectPlaintextCredentialStore(options, 'a GitHub token');
  await runGitCredential(
    'approve',
    credentialPayload(credential, true),
    options
  );
  const resolved = await fillGitHubCredential(
    credential.host,
    credential.username,
    options
  );
  if (
    !resolved?.password ||
    !secretEquals(resolved.password, credential.token)
  ) {
    await runGitCredential(
      'reject',
      credentialPayload(credential, false),
      options
    ).catch(() => undefined);
    throw new Error(
      'The configured Git credential helper did not return the saved GitHub token'
    );
  }
}

export async function saveSshPasswordCredential(
  input: SshPasswordCredential,
  options: GitCredentialCommandOptions = {}
): Promise<void> {
  const credential = normalizeSshPasswordCredential(input);
  await rejectPlaintextCredentialStore(options, 'an SSH password');
  await runGitCredential(
    'approve',
    sshCredentialPayload(credential, true),
    options
  );
  const resolved = await fillSshPasswordCredential(
    credential.profileId,
    credential.username,
    options
  );
  if (!resolved || !secretEquals(resolved, credential.password)) {
    await runGitCredential(
      'reject',
      sshCredentialPayload(credential, false),
      options
    ).catch(() => undefined);
    throw new Error(
      'The configured Git credential helper did not return the saved SSH password'
    );
  }
}

export async function readSshPasswordCredential(
  profileId: string,
  username: string,
  options: GitCredentialCommandOptions = {}
): Promise<string | undefined> {
  return fillSshPasswordCredential(profileId, username, options);
}

export async function deleteSshPasswordCredential(
  profileId: string,
  username: string,
  options: GitCredentialCommandOptions = {}
): Promise<void> {
  const credential = normalizeSshPasswordCredential(
    {
      profileId,
      username,
      password: '',
    },
    false
  );
  await runGitCredential(
    'reject',
    sshCredentialPayload(credential, false),
    options
  );
}

async function rejectPlaintextCredentialStore(
  options: GitCredentialCommandOptions,
  secretDescription: string
): Promise<void> {
  const helpers = await runGitCommand(
    ['config', '--get-all', 'credential.helper'],
    options
  );
  if (
    helpers
      .split(/\r?\n/)
      .some((helper) => /(?:^|[\s/-])store(?:\s|$)/i.test(helper.trim()))
  ) {
    throw new Error(
      `Refusing to save ${secretDescription} with the plaintext Git credential store; configure Git Credential Manager or another OS-backed helper`
    );
  }
}

export async function deleteGitHubTokenCredential(
  host: 'github.com',
  username: string,
  options: GitCredentialCommandOptions = {}
): Promise<void> {
  await runGitCredential(
    'reject',
    credentialPayload(
      {
        host: normalizeHost(host),
        username: normalizeUsername(username),
        token: '',
      },
      false
    ),
    options
  );
}

export async function hasGitHubTokenCredential(
  host: 'github.com',
  username: string,
  options: GitCredentialCommandOptions = {}
): Promise<boolean> {
  const resolved = await fillGitHubCredential(host, username, options);
  return Boolean(resolved?.password);
}

async function fillGitHubCredential(
  host: 'github.com',
  username: string,
  options: GitCredentialCommandOptions
): Promise<{ username?: string; password?: string } | undefined> {
  try {
    const output = await runGitCredential(
      'fill',
      credentialPayload(
        {
          host: normalizeHost(host),
          username: normalizeUsername(username),
          token: '',
        },
        false
      ),
      options
    );
    return parseGitCredentialOutput(output);
  } catch {
    return undefined;
  }
}

async function fillSshPasswordCredential(
  profileId: string,
  username: string,
  options: GitCredentialCommandOptions
): Promise<string | undefined> {
  const credential = normalizeSshPasswordCredential(
    { profileId, username, password: '' },
    false
  );
  try {
    const output = await runGitCredential(
      'fill',
      sshCredentialPayload(credential, false),
      options
    );
    return parseGitCredentialOutput(output).password;
  } catch {
    return undefined;
  }
}

function runGitCredential(
  action: 'approve' | 'fill' | 'reject',
  input: string,
  options: GitCredentialCommandOptions
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['credential', action], {
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        ...options.environment,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      },
    });
    let stdout = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) rejectPromise(error);
      else resolvePromise(stdout);
    };
    const timeout = setTimeout(
      () => finish(new Error(`Git credential ${action} timed out`)),
      Math.max(1_000, options.timeoutMs ?? 15_000)
    );
    timeout.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-64 * 1024);
    });
    // Credential helpers may emit sensitive diagnostics. Never forward either stream.
    child.stderr.resume();
    child.stdin.on('error', () =>
      finish(new Error(`Git credential ${action} rejected its input`))
    );
    child.once('error', () =>
      finish(new Error(`Unable to start git credential ${action}`))
    );
    child.once('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`Git credential ${action} failed`));
    });
    child.stdin.end(input);
  });
}

function runGitCommand(
  args: string[],
  options: GitCredentialCommandOptions
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, {
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        ...options.environment,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      },
    });
    let stdout = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) rejectPromise(error);
      else resolvePromise(stdout);
    };
    const timeout = setTimeout(
      () => finish(new Error('Git credential helper inspection timed out')),
      Math.max(1_000, options.timeoutMs ?? 15_000)
    );
    timeout.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-64 * 1024);
    });
    child.stderr.resume();
    child.once('error', () =>
      finish(
        new Error('Unable to inspect the configured Git credential helper')
      )
    );
    child.once('close', (code) => {
      // git config returns 1 when no helper is configured. Verification after
      // credential approve will then provide the actionable failure.
      if (code === 0 || code === 1) finish();
      else finish(new Error('Unable to inspect the Git credential helper'));
    });
  });
}

function normalizeCredential(
  input: GitHubTokenCredential
): Required<GitHubTokenCredential> {
  return {
    host: normalizeHost(input.host ?? 'github.com'),
    username: normalizeUsername(input.username),
    token: normalizeToken(input.token),
  };
}

function normalizeSshPasswordCredential(
  input: SshPasswordCredential,
  requirePassword = true
): SshPasswordCredential {
  return {
    profileId: normalizeProfileId(input.profileId),
    username: normalizeUsername(input.username, 'SSH'),
    password: requirePassword ? normalizeSshPassword(input.password) : '',
  };
}

function normalizeProfileId(value: string): string {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new Error(
      'Credential profile id must contain 1 to 64 letters, numbers, dots, underscores, or hyphens'
    );
  }
  return id;
}

function normalizeHost(host: string): 'github.com' {
  if (String(host).trim().toLowerCase() !== 'github.com') {
    throw new Error('GitHub token credentials currently support github.com');
  }
  return 'github.com';
}

function normalizeUsername(username: string, kind = 'GitHub'): string {
  const normalized = String(username ?? '').trim();
  if (!normalized || normalized.length > 128 || /[\r\n\0]/.test(normalized)) {
    throw new Error(
      `${kind} username is required and must not exceed 128 characters`
    );
  }
  return normalized;
}

function normalizeToken(token: string): string {
  const normalized = String(token ?? '').trim();
  if (
    normalized.length < 20 ||
    normalized.length > 2_000 ||
    /[\s\0]/.test(normalized)
  ) {
    throw new Error('GitHub token is missing or has an invalid format');
  }
  return normalized;
}

function normalizeSshPassword(password: string): string {
  const normalized = String(password ?? '');
  if (
    normalized.length < 1 ||
    normalized.length > 4_096 ||
    /[\r\n\0]/.test(normalized)
  ) {
    throw new Error(
      'SSH password is required, must not exceed 4096 characters, and cannot contain a line break or NUL byte'
    );
  }
  return normalized;
}

function credentialPayload(
  credential: Required<GitHubTokenCredential>,
  includeToken: boolean
): string {
  return [
    'protocol=https',
    `host=${credential.host}`,
    `username=${credential.username}`,
    ...(includeToken ? [`password=${credential.token}`] : []),
    '',
    '',
  ].join('\n');
}

function sshCredentialPayload(
  credential: SshPasswordCredential,
  includePassword: boolean
): string {
  return [
    'protocol=https',
    `host=${sshPasswordCredentialHost(credential.profileId)}`,
    `username=${credential.username}`,
    ...(includePassword ? [`password=${credential.password}`] : []),
    '',
    '',
  ].join('\n');
}

export function sshPasswordCredentialHost(profileId: string): string {
  const normalized = normalizeProfileId(profileId);
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `runbeacon-ssh-${digest.slice(0, 24)}.invalid`;
}

function secretEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
