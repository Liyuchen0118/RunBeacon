import { GitHubApiClient, GitHubApiError } from './GitHubApiClient.js';
import { isSuccessfulActionsConclusion } from './GitHubPublish.js';

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
}

export type GitHubActionsOutcome =
  | { kind: 'passed'; summary: string }
  | { kind: 'failed'; summary: string }
  | { kind: 'timed-out'; summary: string }
  | { kind: 'unavailable'; code: string };

export interface GitHubActionsMonitorInput {
  owner: string;
  repository: string;
  sha: string;
  authenticated: boolean;
  client: GitHubApiClient;
  discoveryTimeoutMs: number;
  actionsTimeoutMs: number;
  pollIntervalMs: number;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  onProgress?: (percentage: number, phase: string, message: string) => void;
}

export async function monitorGitHubActions(
  input: GitHubActionsMonitorInput
): Promise<GitHubActionsOutcome> {
  const now = input.now ?? Date.now;
  const sleep =
    input.delay ??
    ((milliseconds: number) =>
      new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, milliseconds)
      ));
  const pollIntervalMs = input.authenticated
    ? Math.max(10_000, input.pollIntervalMs)
    : Math.max(60_000, input.pollIntervalMs);
  const discoveryDeadline = now() + input.discoveryTimeoutMs;
  let runs: WorkflowRun[] = [];

  input.onProgress?.(
    65,
    'actions-discovery',
    'Waiting for GitHub Actions runs to appear'
  );
  while (now() < discoveryDeadline) {
    try {
      runs = await fetchWorkflowRuns(input, discoveryDeadline);
    } catch (error) {
      return {
        kind: 'unavailable',
        code:
          error instanceof GitHubApiError
            ? error.code
            : 'actions_monitoring_unavailable',
      };
    }
    if (runs.length > 0) break;
    await sleep(
      Math.min(pollIntervalMs, Math.max(1, discoveryDeadline - now()))
    );
  }
  if (runs.length === 0) {
    return { kind: 'unavailable', code: 'actions_not_discovered' };
  }

  const deadline = now() + input.actionsTimeoutMs;
  for (;;) {
    const summary = summarize(runs);
    if (runs.every((run) => run.status === 'completed')) {
      const failed = runs.some(
        (run) => !isSuccessfulActionsConclusion(run.conclusion)
      );
      return { kind: failed ? 'failed' : 'passed', summary };
    }
    if (now() >= deadline) return { kind: 'timed-out', summary };

    const elapsed = input.actionsTimeoutMs - (deadline - now());
    const percentage = Math.min(
      95,
      70 + Math.round((25 * elapsed) / input.actionsTimeoutMs)
    );
    input.onProgress?.(percentage, 'actions', summary);
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
    try {
      runs = await fetchWorkflowRuns(input, deadline);
    } catch (error) {
      return {
        kind: 'unavailable',
        code:
          error instanceof GitHubApiError
            ? error.code
            : 'actions_monitoring_unavailable',
      };
    }
  }
}

export function monitoringOutcomeFails(
  outcome: GitHubActionsOutcome,
  requireActions: boolean
): boolean {
  return (
    outcome.kind === 'failed' ||
    outcome.kind === 'timed-out' ||
    (outcome.kind === 'unavailable' && requireActions)
  );
}

async function fetchWorkflowRuns(
  input: Pick<
    GitHubActionsMonitorInput,
    'owner' | 'repository' | 'sha' | 'client'
  >,
  deadlineAt: number
): Promise<WorkflowRun[]> {
  const url =
    `https://api.github.com/repos/${encodeURIComponent(input.owner)}/` +
    `${encodeURIComponent(input.repository)}/actions/runs?` +
    `head_sha=${encodeURIComponent(input.sha)}&per_page=50`;
  const body = await input.client.getJson<{ workflow_runs?: WorkflowRun[] }>(
    url,
    deadlineAt
  );
  return (body.workflow_runs ?? []).filter((run) => run.head_sha === input.sha);
}

function summarize(runs: WorkflowRun[]): string {
  return runs
    .map(
      (run) =>
        `${run.name}: ${run.status}${run.conclusion ? `/${run.conclusion}` : ''}`
    )
    .join(' | ')
    .slice(0, 1_000);
}
