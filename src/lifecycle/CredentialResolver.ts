import { join } from 'node:path';
import {
  CredentialProfileStore,
  SshCredentialProfile,
} from './CredentialProfileStore.js';
import { SshPasswordProfileManager } from './SshPasswordProfileManager.js';
import { SshJobTarget } from './types.js';

export function resolveSshAgentReference(agent: string): string {
  if (agent !== 'auto') return agent;
  const configured = process.env.SSH_AUTH_SOCK?.trim();
  if (configured) return configured;
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  throw new Error(
    'agent="auto" requires SSH_AUTH_SOCK outside Windows; start ssh-agent or save an explicit agent path'
  );
}

export function createSshProfileResolver(
  dataDir: string
): (profileId: string) => Promise<SshJobTarget> {
  const profiles = new CredentialProfileStore(
    join(dataDir, 'credential-profiles.json')
  );
  const passwords = new SshPasswordProfileManager(profiles);
  return async (profileId: string) => {
    const profile = profiles.get(profileId);
    if (profile.kind !== 'ssh') {
      throw new Error(`Credential profile ${profileId} is not an SSH profile`);
    }
    return profileToTarget(profile, await passwords.read(profile));
  };
}

function profileToTarget(
  profile: SshCredentialProfile,
  password: string | undefined
): SshJobTarget {
  if (profile.credentialKind === 'password' && !password) {
    throw new Error(
      `SSH password for credential profile ${profile.id} is unavailable in the OS credential manager`
    );
  }
  return {
    kind: 'ssh',
    host: profile.host,
    port: profile.port,
    username: profile.username,
    password,
    privateKeyPath: profile.privateKeyPath,
    agent: profile.agent ? resolveSshAgentReference(profile.agent) : undefined,
    hostKeySha256: profile.hostKeySha256,
    hostKeyAlgorithm: profile.hostKeyAlgorithm,
    runnerPath: profile.runnerPath,
    allowUnverifiedHostKey: profile.allowUnverifiedHostKey,
  };
}
