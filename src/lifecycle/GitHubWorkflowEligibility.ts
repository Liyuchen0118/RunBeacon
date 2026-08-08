import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { minimatch } from 'minimatch';
import { parse } from 'yaml';
import { GitHubApiClient, GitHubApiError } from './GitHubApiClient.js';

interface PullRequest {
  draft?: boolean;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
}

interface WorkflowEvents {
  push?: unknown;
  pullRequest?: unknown;
  pullRequestTarget?: unknown;
  uncertain: boolean;
}

export interface WorkflowEligibilityInput {
  cwd: string;
  owner: string;
  repository: string;
  branch: string;
  sha: string;
  client: GitHubApiClient;
  deadlineAt: number;
}

export interface WorkflowEligibility {
  eligible: boolean;
  reason: 'push' | 'pull-request' | 'no-workflows' | 'uncertain';
  workflowCount: number;
  unavailableCode?: string;
}

export async function determineWorkflowEligibility(
  input: WorkflowEligibilityInput
): Promise<WorkflowEligibility> {
  const workflows = await readWorkflowEvents(input.cwd);
  if (workflows.some((workflow) => workflow.uncertain)) {
    return {
      eligible: true,
      reason: 'uncertain',
      workflowCount: workflows.length,
    };
  }
  if (
    workflows.some((workflow) =>
      branchMatchesEvent(input.branch, workflow.push)
    )
  ) {
    return {
      eligible: true,
      reason: 'push',
      workflowCount: workflows.length,
    };
  }

  const pullRequestWorkflows = workflows.filter(
    (workflow) =>
      supportsSynchronize(workflow.pullRequest) ||
      supportsSynchronize(workflow.pullRequestTarget)
  );
  if (pullRequestWorkflows.length === 0) {
    return {
      eligible: false,
      reason: 'no-workflows',
      workflowCount: workflows.length,
    };
  }

  let pulls: PullRequest[];
  try {
    const url =
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/` +
      `${encodeURIComponent(input.repository)}/pulls?state=open&per_page=100`;
    pulls = await input.client.getJson<PullRequest[]>(url, input.deadlineAt);
  } catch (error) {
    return {
      eligible: true,
      reason: 'uncertain',
      workflowCount: workflows.length,
      unavailableCode:
        error instanceof GitHubApiError
          ? error.code
          : 'actions_monitoring_unavailable',
    };
  }

  const matchingPulls = pulls.filter(
    (pull) => pull.head?.sha === input.sha || pull.head?.ref === input.branch
  );
  const eligible = matchingPulls.some((pull) =>
    pullRequestWorkflows.some(
      (workflow) =>
        branchMatchesEvent(pull.base?.ref ?? '', workflow.pullRequest) ||
        branchMatchesEvent(pull.base?.ref ?? '', workflow.pullRequestTarget)
    )
  );
  return {
    eligible,
    reason: eligible ? 'pull-request' : 'no-workflows',
    workflowCount: workflows.length,
  };
}

async function readWorkflowEvents(cwd: string): Promise<WorkflowEvents[]> {
  const workflowDirectory = join(cwd, '.github', 'workflows');
  let names: string[];
  try {
    names = (await readdir(workflowDirectory))
      .filter((name) => /\.ya?ml$/i.test(name))
      .slice(0, 100);
  } catch (error) {
    if (isMissing(error)) return [];
    return [{ uncertain: true }];
  }

  return Promise.all(
    names.map(async (name): Promise<WorkflowEvents> => {
      const path = join(workflowDirectory, name);
      try {
        const handle = await open(path, 'r');
        try {
          const details = await handle.stat();
          if (!details.isFile() || details.size > 1024 * 1024) {
            return { uncertain: true };
          }
          const source = await handle.readFile({ encoding: 'utf8' });
          if (Buffer.byteLength(source, 'utf8') > 1024 * 1024) {
            return { uncertain: true };
          }
          const document = parse(source, {
            maxAliasCount: 50,
          }) as Record<string, unknown> | null;
          return normalizeEvents(document?.on);
        } finally {
          await handle.close();
        }
      } catch {
        return { uncertain: true };
      }
    })
  );
}

function normalizeEvents(value: unknown): WorkflowEvents {
  if (typeof value === 'string') {
    return eventNames([value]);
  }
  if (Array.isArray(value)) {
    return eventNames(
      value.filter((item): item is string => typeof item === 'string')
    );
  }
  if (!isRecord(value)) return { uncertain: true };
  return {
    push: Object.prototype.hasOwnProperty.call(value, 'push')
      ? value.push
      : undefined,
    pullRequest: Object.prototype.hasOwnProperty.call(value, 'pull_request')
      ? value.pull_request
      : undefined,
    pullRequestTarget: Object.prototype.hasOwnProperty.call(
      value,
      'pull_request_target'
    )
      ? value.pull_request_target
      : undefined,
    uncertain: false,
  };
}

function eventNames(names: string[]): WorkflowEvents {
  const normalized = new Set(names.map((name) => name.trim()));
  return {
    push: normalized.has('push') ? null : undefined,
    pullRequest: normalized.has('pull_request') ? null : undefined,
    pullRequestTarget: normalized.has('pull_request_target') ? null : undefined,
    uncertain: false,
  };
}

function branchMatchesEvent(branch: string, event: unknown): boolean {
  if (event === undefined) return false;
  if (event === null || event === '') return true;
  if (!isRecord(event)) return true;
  const branches = stringList(event.branches);
  const ignored = stringList(event['branches-ignore']);
  if (branches && !matchesOrderedPatterns(branch, branches)) return false;
  if (ignored?.some((pattern) => matchesBranch(branch, pattern))) return false;
  return true;
}

function supportsSynchronize(event: unknown): boolean {
  if (event === undefined) return false;
  if (event === null || event === '') return true;
  if (!isRecord(event)) return true;
  const types = stringList(event.types);
  return !types || types.includes('synchronize');
}

function matchesOrderedPatterns(branch: string, patterns: string[]): boolean {
  let included = false;
  for (const pattern of patterns) {
    const negative = pattern.startsWith('!');
    const candidate = negative ? pattern.slice(1) : pattern;
    if (candidate && matchesBranch(branch, candidate)) included = !negative;
  }
  return included;
}

function matchesBranch(branch: string, pattern: string): boolean {
  return minimatch(branch, pattern, { dot: true, nocase: false });
}

function stringList(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === 'string'
  );
  return strings.length === value.length ? strings : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
