import {
  monitorGitHubActions,
  monitoringOutcomeFails,
  type WorkflowRun,
} from '../lifecycle/GitHubActionsMonitor.js';
import { GitHubApiClient } from '../lifecycle/GitHubApiClient.js';

function response(workflowRuns: WorkflowRun[]) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ workflow_runs: workflowRuns }),
  };
}

function run(status: string, conclusion: string | null): WorkflowRun {
  return {
    id: 1,
    name: 'CI',
    status,
    conclusion,
    html_url: 'https://github.com/acme/project/actions/runs/1',
    head_sha: 'abc123',
  };
}

function monitorInput(client: GitHubApiClient) {
  return {
    owner: 'acme',
    repository: 'project',
    sha: 'abc123',
    authenticated: true,
    client,
    discoveryTimeoutMs: 30_000,
    actionsTimeoutMs: 30_000,
    pollIntervalMs: 1_000,
  };
}

describe('GitHub Actions monitor', () => {
  test('classifies persistent transport failure as unavailable', async () => {
    let currentTime = 1_000;
    const client = new GitHubApiClient({
      request: async () => {
        throw new Error('fetch failed');
      },
      delay: async () => undefined,
      maxAttempts: 1,
      now: () => currentTime,
    });
    const outcome = await monitorGitHubActions({
      ...monitorInput(client),
      discoveryTimeoutMs: 25_000,
      now: () => currentTime,
      delay: async (milliseconds) => {
        currentTime += milliseconds;
      },
    });

    expect(outcome).toEqual({
      kind: 'unavailable',
      code: 'github_api_timeout',
    });
    expect(monitoringOutcomeFails(outcome, false)).toBe(false);
    expect(monitoringOutcomeFails(outcome, true)).toBe(true);
  });

  test('preserves an actual Actions failure as a gate failure', async () => {
    const client = new GitHubApiClient({
      request: async () => response([run('completed', 'failure')]),
    });
    const outcome = await monitorGitHubActions(monitorInput(client));

    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(monitoringOutcomeFails(outcome, false)).toBe(true);
    expect(monitoringOutcomeFails(outcome, true)).toBe(true);
  });

  test('waits for a running workflow and returns passed', async () => {
    let currentTime = 1_000;
    const request = jest
      .fn()
      .mockResolvedValueOnce(response([run('in_progress', null)]))
      .mockResolvedValueOnce(response([run('completed', 'success')]));
    const client = new GitHubApiClient({ request, now: () => currentTime });
    const progress: string[] = [];

    const outcome = await monitorGitHubActions({
      ...monitorInput(client),
      now: () => currentTime,
      delay: async (milliseconds) => {
        currentTime += milliseconds;
      },
      onProgress: (_percentage, phase) => progress.push(phase),
    });

    expect(outcome).toMatchObject({ kind: 'passed' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(progress).toEqual(['actions-discovery', 'actions']);
  });

  test('continues discovery after more than five retryable failures', async () => {
    let currentTime = 1_000;
    let attempts = 0;
    const client = new GitHubApiClient({
      request: async () => {
        attempts += 1;
        if (attempts <= 6) throw new Error('temporary transport failure');
        return response([run('completed', 'success')]);
      },
      delay: async () => undefined,
      maxAttempts: 1,
      now: () => currentTime,
    });

    const outcome = await monitorGitHubActions({
      ...monitorInput(client),
      discoveryTimeoutMs: 90_000,
      now: () => currentTime,
      delay: async (milliseconds) => {
        currentTime += milliseconds;
      },
    });

    expect(outcome).toMatchObject({ kind: 'passed' });
    expect(attempts).toBe(7);
  });

  test('retains workflow state while reconnecting and then recovers', async () => {
    let currentTime = 1_000;
    const request = jest
      .fn()
      .mockResolvedValueOnce(response([run('in_progress', null)]))
      .mockRejectedValueOnce(new Error('temporary transport failure'))
      .mockResolvedValueOnce(response([run('completed', 'success')]));
    const client = new GitHubApiClient({
      request,
      delay: async () => undefined,
      maxAttempts: 1,
      now: () => currentTime,
    });
    const progress: Array<{ phase: string; message: string }> = [];

    const outcome = await monitorGitHubActions({
      ...monitorInput(client),
      now: () => currentTime,
      delay: async (milliseconds) => {
        currentTime += milliseconds;
      },
      onProgress: (_percentage, phase, message) =>
        progress.push({ phase, message }),
    });

    expect(outcome).toMatchObject({ kind: 'passed' });
    expect(progress.some(({ phase }) => phase === 'actions-reconnecting')).toBe(
      true
    );
    expect(
      progress.find(({ phase }) => phase === 'actions-reconnecting')?.message
    ).toContain('CI: in_progress');
  });

  test.each([401, 403])(
    'stops immediately on non-retryable HTTP %s during discovery',
    async (status) => {
      const request = jest.fn(async () => ({
        ok: false,
        status,
        headers: { get: () => null },
        json: async () => ({}),
      }));
      const client = new GitHubApiClient({ request });

      await expect(monitorGitHubActions(monitorInput(client))).resolves.toEqual(
        {
          kind: 'unavailable',
          code: `github_api_http_${status}`,
        }
      );
      expect(request).toHaveBeenCalledTimes(1);
    }
  );
});
