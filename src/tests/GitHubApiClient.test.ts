import {
  GitHubApiClient,
  GitHubApiError,
  matchesNoProxy,
  resolveGitHubProxy,
  type GitHubRequest,
} from '../lifecycle/GitHubApiClient.js';

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => body,
  };
}

describe('GitHubApiClient', () => {
  test('recovers when three transport attempts fail and the fourth succeeds', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const request: GitHubRequest = async () => {
      attempts += 1;
      if (attempts <= 3) throw new Error('secret transport details');
      return response(200, { ok: true });
    };
    const client = new GitHubApiClient({
      request,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      random: () => 0.5,
    });

    await expect(
      client.getJson('https://api.github.com/test', Date.now() + 60_000)
    ).resolves.toEqual({
      ok: true,
    });
    expect(attempts).toBe(4);
    expect(delays).toEqual([250, 500, 1_000]);
  });

  test('honors Retry-After for HTTP 429', async () => {
    const delays: number[] = [];
    const request = jest
      .fn<ReturnType<GitHubRequest>, Parameters<GitHubRequest>>()
      .mockResolvedValueOnce(response(429, {}, { 'retry-after': '2' }))
      .mockResolvedValueOnce(response(200, { ok: true }));
    const client = new GitHubApiClient({
      request,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await expect(
      client.getJson('https://api.github.com/test', Date.now() + 60_000)
    ).resolves.toEqual({
      ok: true,
    });
    expect(delays).toEqual([2_000]);
  });

  test('retries HTTP 500', async () => {
    const request = jest
      .fn<ReturnType<GitHubRequest>, Parameters<GitHubRequest>>()
      .mockResolvedValueOnce(response(500, {}))
      .mockResolvedValueOnce(response(200, { ok: true }));
    const client = new GitHubApiClient({
      request,
      delay: async () => undefined,
    });

    await expect(
      client.getJson('https://api.github.com/test', Date.now() + 60_000)
    ).resolves.toEqual({
      ok: true,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  test.each([401, 403])('does not retry HTTP %s', async (status) => {
    const request = jest.fn(async () => response(status, {}));
    const client = new GitHubApiClient({ request });

    await expect(
      client.getJson('https://api.github.com/test', Date.now() + 60_000)
    ).rejects.toMatchObject({
      code: `github_api_http_${status}`,
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('returns only a stable code after persistent transport failure', async () => {
    const token = 'ghp_CANARY_SHOULD_NOT_APPEAR';
    const proxySecret = 'proxy-secret';
    const client = new GitHubApiClient({
      token,
      request: async () => {
        throw new Error(`network failed ${token} ${proxySecret}`);
      },
      delay: async () => undefined,
    });

    const error = await client
      .getJson('https://api.github.com/test', Date.now() + 60_000)
      .catch((caught) => caught as GitHubApiError);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(String(error)).toContain('github_api_transport');
    expect(JSON.stringify(error)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(proxySecret);
  });
});

describe('GitHub proxy resolution', () => {
  test('uses the documented precedence', () => {
    expect(
      resolveGitHubProxy(
        {
          RUNBEACON_GITHUB_PROXY: 'http://runbeacon:1',
          HTTPS_PROXY: 'http://https-env:2',
          HTTP_PROXY: 'http://http-env:3',
        },
        'http://git-url:4',
        'http://git:5'
      )
    ).toMatchObject({ source: 'runbeacon', url: 'http://runbeacon:1/' });
    expect(
      resolveGitHubProxy(
        { HTTPS_PROXY: 'http://https-env:2', HTTP_PROXY: 'http://http-env:3' },
        'http://git-url:4',
        'http://git:5'
      )
    ).toMatchObject({ source: 'https_env', url: 'http://https-env:2/' });
    expect(
      resolveGitHubProxy({}, 'http://git-url:4', 'http://git:5')
    ).toMatchObject({ source: 'git_url', url: 'http://git-url:4/' });
    expect(resolveGitHubProxy({}, undefined, 'http://git:5')).toMatchObject({
      source: 'git',
      url: 'http://git:5/',
    });
  });

  test('NO_PROXY forces a direct GitHub API connection', () => {
    expect(matchesNoProxy('api.github.com', '.github.com,localhost')).toBe(
      true
    );
    expect(
      resolveGitHubProxy({
        HTTPS_PROXY: 'http://proxy.example:8080',
        NO_PROXY: '.github.com',
      })
    ).toEqual({ source: 'direct', noProxy: '.github.com' });
  });
});
