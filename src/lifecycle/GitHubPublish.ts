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

export interface GitPushAttemptResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitPushRetryNotice {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
}

const MAX_GIT_PUSH_ATTEMPTS = 5;

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
    /could not resolve host|failed to connect|connection timed out|network is unreachable|connection (?:was )?reset|recv failure|send failure|unexpected disconnect|remote end hung up|early eof|schannel:.*(?:failed|error)|ssl\/tls connection failed|tls handshake/i.test(
      output
    )
  ) {
    return 'network';
  }
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
  return 'unknown';
}

export async function retryGitPush(
  runAttempt: () => Promise<GitPushAttemptResult>,
  onRetry: (notice: GitPushRetryNotice) => void = () => undefined,
  sleep: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
): Promise<GitPushAttemptResult> {
  let lastResult: GitPushAttemptResult | undefined;
  for (let attempt = 1; attempt <= MAX_GIT_PUSH_ATTEMPTS; attempt += 1) {
    lastResult = await runAttempt();
    if (lastResult.code === 0) return lastResult;
    const failure = classifyGitPushFailure(
      `${lastResult.stderr}\n${lastResult.stdout}`
    );
    if (failure !== 'network' || attempt === MAX_GIT_PUSH_ATTEMPTS) {
      return lastResult;
    }
    const delayMs = Math.min(8_000, 500 * 2 ** (attempt - 1));
    onRetry({ attempt, maxAttempts: MAX_GIT_PUSH_ATTEMPTS, delayMs });
    await sleep(delayMs);
  }
  return lastResult as GitPushAttemptResult;
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
