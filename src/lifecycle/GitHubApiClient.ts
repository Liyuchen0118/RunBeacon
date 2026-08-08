import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
} from 'undici';

export type GitHubApiErrorCode =
  | 'github_api_transport'
  | 'github_api_timeout'
  | 'github_api_invalid_json'
  | `github_api_http_${number}`;

export class GitHubApiError extends Error {
  constructor(
    public readonly code: GitHubApiErrorCode,
    public readonly retryable: boolean,
    public readonly status?: number
  ) {
    super(code);
    this.name = 'GitHubApiError';
  }
}

interface ResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type GitHubRequest = (
  url: string,
  init: {
    headers: Record<string, string>;
    signal: AbortSignal;
    dispatcher?: Dispatcher;
  }
) => Promise<ResponseLike>;

export interface GitHubApiClientOptions {
  token?: string;
  dispatcher?: Dispatcher;
  request?: GitHubRequest;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  maxAttempts?: number;
  attemptTimeoutMs?: number;
}

export class GitHubApiClient {
  private readonly request: GitHubRequest;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxAttempts: number;
  private readonly attemptTimeoutMs: number;

  constructor(private readonly options: GitHubApiClientOptions = {}) {
    this.request = options.request ?? defaultRequest;
    this.sleep =
      options.delay ??
      ((milliseconds) =>
        new Promise((resolvePromise) =>
          setTimeout(resolvePromise, milliseconds)
        ));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.maxAttempts = clamp(options.maxAttempts ?? 5, 1, 5);
    this.attemptTimeoutMs = clamp(
      options.attemptTimeoutMs ?? 15_000,
      100,
      15_000
    );
  }

  async getJson<T>(url: string, deadlineAt: number): Promise<T> {
    let lastError = new GitHubApiError('github_api_transport', true);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const remainingMs = deadlineAt - this.now();
      if (remainingMs <= 0) {
        throw new GitHubApiError('github_api_timeout', true);
      }
      const timeoutMs = Math.max(
        1,
        Math.min(this.attemptTimeoutMs, remainingMs)
      );
      try {
        const response = await this.request(url, {
          headers: this.headers(),
          signal: AbortSignal.timeout(timeoutMs),
          dispatcher: this.options.dispatcher,
        });
        if (response.ok) {
          try {
            return (await response.json()) as T;
          } catch {
            throw new GitHubApiError('github_api_invalid_json', false);
          }
        }

        const retryable = isRetryableStatus(response.status);
        lastError = new GitHubApiError(
          `github_api_http_${response.status}`,
          retryable,
          response.status
        );
        if (!retryable || attempt === this.maxAttempts) throw lastError;
        await this.waitBeforeRetry(
          attempt,
          response.headers.get('retry-after'),
          deadlineAt
        );
      } catch (error) {
        if (error instanceof GitHubApiError) {
          if (!error.retryable || attempt === this.maxAttempts) throw error;
          lastError = error;
        } else {
          lastError = new GitHubApiError(
            isAbortError(error) ? 'github_api_timeout' : 'github_api_transport',
            true
          );
          if (attempt === this.maxAttempts) throw lastError;
        }
        await this.waitBeforeRetry(attempt, null, deadlineAt);
      }
    }
    throw lastError;
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'RunBeacon',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(this.options.token
        ? { Authorization: `Bearer ${this.options.token}` }
        : {}),
    };
  }

  private async waitBeforeRetry(
    attempt: number,
    retryAfter: string | null,
    deadlineAt: number
  ): Promise<void> {
    const retryAfterMs = parseRetryAfter(retryAfter, this.now());
    const exponentialMs = Math.min(4_000, 250 * 2 ** (attempt - 1));
    const jitteredMs = Math.round(exponentialMs * (0.75 + this.random() * 0.5));
    const requestedMs = retryAfterMs ?? jitteredMs;
    const remainingMs = deadlineAt - this.now();
    if (remainingMs <= 0 || requestedMs >= remainingMs) {
      throw new GitHubApiError('github_api_timeout', true);
    }
    await this.sleep(requestedMs);
  }
}

export interface ProxyEnvironment {
  [key: string]: string | undefined;
}

export interface ResolvedGitHubProxy {
  url?: string;
  source: 'runbeacon' | 'https_env' | 'http_env' | 'git_url' | 'git' | 'direct';
  noProxy: string;
}

export function resolveGitHubProxy(
  environment: ProxyEnvironment,
  gitUrlProxy?: string,
  gitProxy?: string,
  hostname = 'api.github.com'
): ResolvedGitHubProxy {
  const noProxy = envValue(environment, 'NO_PROXY') ?? '';
  if (matchesNoProxy(hostname, noProxy)) {
    return { source: 'direct', noProxy };
  }

  const candidates: Array<[ResolvedGitHubProxy['source'], string | undefined]> =
    [
      ['runbeacon', envValue(environment, 'RUNBEACON_GITHUB_PROXY')],
      ['https_env', envValue(environment, 'HTTPS_PROXY')],
      ['http_env', envValue(environment, 'HTTP_PROXY')],
      ['git_url', gitUrlProxy],
      ['git', gitProxy],
    ];
  for (const [source, value] of candidates) {
    const url = normalizeProxyUrl(value);
    if (url) return { url, source, noProxy };
  }
  return { source: 'direct', noProxy };
}

export function createGitHubDispatcher(
  proxy: ResolvedGitHubProxy
): Dispatcher | undefined {
  if (!proxy.url) return undefined;
  return new EnvHttpProxyAgent({
    httpProxy: proxy.url,
    httpsProxy: proxy.url,
    noProxy: proxy.noProxy,
  });
}

export function matchesNoProxy(hostname: string, value: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true;
      const withoutPort = entry.replace(/:\d+$/, '');
      const domain = withoutPort.startsWith('.')
        ? withoutPort.slice(1)
        : withoutPort;
      return host === domain || host.endsWith(`.${domain}`);
    });
}

function envValue(
  environment: ProxyEnvironment,
  key: string
): string | undefined {
  const direct = environment[key] ?? environment[key.toLowerCase()];
  const value = direct?.trim();
  return value || undefined;
}

function normalizeProxyUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function parseRetryAfter(
  value: string | null,
  now: number
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.round(seconds * 1_000));
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(60_000, Math.max(0, date - now));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

const defaultRequest: GitHubRequest = async (url, init) =>
  undiciFetch(url, init);
