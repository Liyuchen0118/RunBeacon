export interface GitHubRepository {
  owner: string;
  repository: string;
}

export type GitPushFailureKind =
  | 'authentication'
  | 'non_fast_forward'
  | 'permission'
  | 'network'
  | 'unknown';

export function parseGitHubRepository(
  remoteUrl: string
): GitHubRepository | undefined {
  const trimmed = remoteUrl.trim();
  const match =
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(
      trimmed
    );
  if (!match) return undefined;
  return {
    owner: match[1],
    repository: match[2].replace(/\.git$/i, ''),
  };
}

export function classifyGitPushFailure(output: string): GitPushFailureKind {
  if (
    /authentication failed|could not read username|terminal prompts disabled|credential|logon failed/i.test(
      output
    )
  ) {
    return 'authentication';
  }
  if (/non-fast-forward|fetch first|rejected.*behind/i.test(output)) {
    return 'non_fast_forward';
  }
  if (
    /permission.*denied|not permitted|repository not found|403/i.test(output)
  ) {
    return 'permission';
  }
  if (
    /could not resolve host|failed to connect|connection timed out|network is unreachable/i.test(
      output
    )
  ) {
    return 'network';
  }
  return 'unknown';
}

export function isSuccessfulActionsConclusion(
  conclusion: string | null | undefined
): boolean {
  return (
    conclusion === 'success' ||
    conclusion === 'neutral' ||
    conclusion === 'skipped'
  );
}

export function parseGitCredentialOutput(output: string): {
  username?: string;
  password?: string;
} {
  const credential: { username?: string; password?: string } = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === 'username') credential.username = value;
    if (key === 'password') credential.password = value;
  }
  return credential;
}
