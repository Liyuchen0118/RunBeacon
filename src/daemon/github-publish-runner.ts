#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  classifyGitPushFailure,
  isSuccessfulActionsConclusion,
  parseGitCredentialOutput,
  parseGitHubRepository,
} from '../lifecycle/GitHubPublish.js';
import { redactPersistedText } from '../lifecycle/security.js';

interface RunnerOptions {
  cwd: string;
  remote: string;
  branch?: string;
  commitMessage?: string;
  watchActions: boolean;
  actionsTimeoutMs: number;
  discoveryTimeoutMs: number;
  pollIntervalMs: number;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
}

const options = parseArguments(process.argv.slice(2));
try {
  await publish(options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  phase(99, 'failed', message);
  process.exitCode = 1;
}

async function publish(input: RunnerOptions): Promise<void> {
  phase(5, 'preflight', 'Validating repository and branch');
  const root = await requireGit(input.cwd, ['rev-parse', '--show-toplevel']);
  const cwd = resolve(root.stdout.trim());
  const branch =
    input.branch ||
    (await requireGit(cwd, ['branch', '--show-current'])).stdout.trim();
  if (!branch)
    throw new Error('Detached HEAD is not supported; provide a branch');
  await requireGit(cwd, ['check-ref-format', '--branch', branch]);

  const remoteUrl = (
    await requireGit(cwd, ['remote', 'get-url', input.remote])
  ).stdout.trim();
  const repository = parseGitHubRepository(remoteUrl);
  phase(10, 'preflight', `Repository ready on ${input.remote}/${branch}`);

  if (input.commitMessage) {
    phase(15, 'commit', 'Checking staged changes');
    const staged = await runGit(cwd, ['diff', '--cached', '--quiet']);
    if (staged.code === 0) {
      throw new Error(
        'commitMessage was provided, but there are no staged changes. Run git add explicitly first.'
      );
    }
    if (staged.code !== 1) {
      throw new Error(redactPersistedText(staged.stderr || staged.stdout));
    }
    phase(20, 'commit', 'Creating commit from staged changes');
    await requireGit(cwd, ['commit', '-m', input.commitMessage], true);
  }

  const sha = (await requireGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
  phase(30, 'push', `Pushing ${sha.slice(0, 12)} to ${input.remote}/${branch}`);
  const push = await runGit(
    cwd,
    ['push', '--progress', input.remote, `HEAD:${branch}`],
    true,
    {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    }
  );
  if (push.code !== 0) {
    const output = `${push.stderr}\n${push.stdout}`;
    const failure = classifyGitPushFailure(output);
    phase(35, failure, `Git push failed: ${failure.replaceAll('_', ' ')}`);
    throw new Error(
      `Git push failed during ${failure}: ${redactPersistedText(output, 2_000)}`
    );
  }
  phase(60, 'pushed', `Commit ${sha.slice(0, 12)} is on GitHub`);

  if (!input.watchActions) {
    phase(
      100,
      'complete',
      'Push completed; GitHub Actions monitoring disabled'
    );
    return;
  }
  if (!repository) {
    throw new Error(
      'The selected remote is not a supported github.com URL; disable watchActions for non-GitHub remotes.'
    );
  }

  await watchActions(repository.owner, repository.repository, sha, input);
}

async function watchActions(
  owner: string,
  repository: string,
  sha: string,
  input: RunnerOptions
): Promise<void> {
  const token =
    process.env.RUNBEACON_GITHUB_TOKEN?.trim() ||
    (await resolveGitHubTokenFromCredentialManager(
      process.env.RUNBEACON_GITHUB_USERNAME?.trim()
    ));
  const pollIntervalMs = token
    ? Math.max(10_000, input.pollIntervalMs)
    : Math.max(60_000, input.pollIntervalMs);
  const discoveryDeadline = Date.now() + input.discoveryTimeoutMs;
  let runs: WorkflowRun[] = [];

  phase(65, 'actions-discovery', 'Waiting for GitHub Actions runs to appear');
  while (Date.now() < discoveryDeadline) {
    runs = await fetchWorkflowRuns(owner, repository, sha, token);
    if (runs.length > 0) break;
    await delay(
      Math.min(pollIntervalMs, Math.max(1, discoveryDeadline - Date.now()))
    );
  }
  if (runs.length === 0) {
    phase(
      100,
      'complete',
      'Push completed; no GitHub Actions run was discovered'
    );
    return;
  }

  const deadline = Date.now() + input.actionsTimeoutMs;
  for (;;) {
    const summary = runs
      .map(
        (run) =>
          `${run.name}: ${run.status}${run.conclusion ? `/${run.conclusion}` : ''}`
      )
      .join(' | ')
      .slice(0, 1_000);
    const completed = runs.every((run) => run.status === 'completed');
    if (completed) {
      const failed = runs.filter(
        (run) => !isSuccessfulActionsConclusion(run.conclusion)
      );
      if (failed.length > 0) {
        phase(99, 'actions-failed', summary);
        throw new Error(`GitHub Actions failed: ${summary}`);
      }
      phase(100, 'complete', `GitHub Actions passed: ${summary}`);
      return;
    }

    if (Date.now() >= deadline) {
      phase(95, 'actions-timeout', summary);
      throw new Error(`Timed out waiting for GitHub Actions: ${summary}`);
    }
    const elapsed = input.actionsTimeoutMs - (deadline - Date.now());
    const percentage = Math.min(
      95,
      70 + Math.round((25 * elapsed) / input.actionsTimeoutMs)
    );
    phase(percentage, 'actions', summary);
    await delay(pollIntervalMs);
    runs = await fetchWorkflowRuns(owner, repository, sha, token);
  }
}

async function fetchWorkflowRuns(
  owner: string,
  repository: string,
  sha: string,
  token?: string
): Promise<WorkflowRun[]> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=50`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'RunBeacon',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        'GitHub Actions API returned 404. For a private repository, sign in through Git Credential Manager or provide a memory-only githubToken.'
      );
    }
    throw new Error(`GitHub Actions API failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { workflow_runs?: WorkflowRun[] };
  return (body.workflow_runs ?? []).filter((run) => run.head_sha === sha);
}

async function resolveGitHubTokenFromCredentialManager(
  username?: string
): Promise<string | undefined> {
  if (process.env.RUNBEACON_GITHUB_CREDENTIAL_SOURCE === 'none') {
    return undefined;
  }
  return new Promise((resolvePromise) => {
    const child = spawn('git', ['credential', 'fill'], {
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      },
      shell: false,
    });
    let stdout = '';
    let settled = false;
    const finish = (token?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolvePromise(token);
    };
    const timeout = setTimeout(() => finish(), 10_000);
    timeout.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-64 * 1024);
    });
    // Never forward credential-helper stdout or stderr: stdout can contain a token.
    child.stderr.resume();
    child.stdin.on('error', () => finish());
    child.once('error', () => finish());
    child.once('close', (code) => {
      if (code !== 0) finish();
      else finish(parseGitCredentialOutput(stdout).password?.trim());
    });
    child.stdin.end(
      [
        'protocol=https',
        'host=github.com',
        ...(username ? [`username=${username}`] : []),
        '',
        '',
      ].join('\n')
    );
  });
}

async function requireGit(
  cwd: string,
  args: string[],
  stream = false
): Promise<GitResult> {
  const result = await runGit(cwd, args, stream);
  if (result.code !== 0) {
    throw new Error(
      redactPersistedText(
        result.stderr || result.stdout || 'Git command failed'
      )
    );
  }
  return result;
}

function runGit(
  cwd: string,
  args: string[],
  stream = false,
  environment: Record<string, string> = {}
): Promise<GitResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...environment },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (stream) process.stdout.write(redactPersistedText(text, 64 * 1024));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      if (stream) process.stderr.write(redactPersistedText(text, 64 * 1024));
    });
    child.once('error', rejectPromise);
    child.once('close', (code) =>
      resolvePromise({ code: code ?? 1, stdout, stderr })
    );
  });
}

function phase(percentage: number, name: string, message: string): void {
  process.stdout.write(
    `${Math.max(0, Math.min(100, percentage))}% [${name}] ${redactPersistedText(message, 1_000)}\n`
  );
}

function parseArguments(args: string[]): RunnerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid runner argument near ${String(key)}`);
    }
    values.set(key.slice(2), value);
  }
  const cwd = values.get('cwd');
  if (!cwd) throw new Error('--cwd is required');
  const remote = values.get('remote') || 'origin';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(remote)) {
    throw new Error('remote contains unsupported characters');
  }
  return {
    cwd,
    remote,
    branch: values.get('branch') || undefined,
    commitMessage: values.get('commit-message') || undefined,
    watchActions: values.get('watch-actions') !== 'false',
    actionsTimeoutMs: boundedNumber(
      values.get('actions-timeout-ms'),
      30 * 60_000,
      10_000,
      23 * 60 * 60_000
    ),
    discoveryTimeoutMs: boundedNumber(
      values.get('discovery-timeout-ms'),
      120_000,
      1_000,
      10 * 60_000
    ),
    pollIntervalMs: boundedNumber(
      values.get('poll-interval-ms'),
      15_000,
      1_000,
      5 * 60_000
    ),
  };
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`Invalid numeric value: ${value}`);
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}
