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
    const client = new GitHubApiClient({
      request: async () => {
        throw new Error('fetch failed');
      },
      delay: async () => undefined,
      maxAttempts: 1,
    });
    const outcome = await monitorGitHubActions(monitorInput(client));

    expect(outcome).toEqual({
      kind: 'unavailable',
      code: 'github_api_transport',
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
});
