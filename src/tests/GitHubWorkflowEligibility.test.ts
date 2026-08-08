import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubApiClient } from '../lifecycle/GitHubApiClient.js';
import { determineWorkflowEligibility } from '../lifecycle/GitHubWorkflowEligibility.js';

describe('GitHub workflow eligibility', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  async function repository(workflow: string): Promise<string> {
    const cwd = await mkdtemp(join(tmpdir(), 'runbeacon-workflow-'));
    directories.push(cwd);
    const directory = join(cwd, '.github', 'workflows');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'ci.yml'), workflow, 'utf8');
    return cwd;
  }

  function input(
    cwd: string,
    client: GitHubApiClient,
    branch = 'feature/test'
  ) {
    return {
      cwd,
      owner: 'acme',
      repository: 'project',
      branch,
      sha: 'abc123',
      client,
      deadlineAt: Date.now() + 10_000,
    };
  }

  test('finds an eligible push branch without calling GitHub', async () => {
    const cwd = await repository(`
name: CI
on:
  push:
    branches: [main, "feature/**"]
`);
    const request = jest.fn();
    const client = new GitHubApiClient({ request });

    await expect(
      determineWorkflowEligibility(input(cwd, client))
    ).resolves.toMatchObject({
      eligible: true,
      reason: 'push',
    });
    expect(request).not.toHaveBeenCalled();
  });

  test('returns no-workflows for a feature branch without an open PR', async () => {
    const cwd = await repository(`
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
`);
    const client = new GitHubApiClient({
      request: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [],
      }),
    });

    await expect(
      determineWorkflowEligibility(input(cwd, client))
    ).resolves.toMatchObject({
      eligible: false,
      reason: 'no-workflows',
    });
  });

  test('treats a draft PR synchronization as eligible', async () => {
    const cwd = await repository(`
name: PR
on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main]
`);
    const client = new GitHubApiClient({
      request: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [
          {
            draft: true,
            head: { ref: 'feature/test', sha: 'abc123' },
            base: { ref: 'main' },
          },
        ],
      }),
    });

    await expect(
      determineWorkflowEligibility(input(cwd, client))
    ).resolves.toMatchObject({
      eligible: true,
      reason: 'pull-request',
    });
  });

  test('polls conservatively when workflow YAML cannot be parsed', async () => {
    const cwd = await repository('on: [push\ninvalid');
    const client = new GitHubApiClient({ request: jest.fn() });

    await expect(
      determineWorkflowEligibility(input(cwd, client))
    ).resolves.toMatchObject({
      eligible: true,
      reason: 'uncertain',
    });
  });

  test('returns one bounded monitoring error when open-PR lookup fails', async () => {
    const cwd = await repository(`
name: PR
on:
  pull_request:
    branches: [main]
`);
    const request = jest.fn(async () => {
      throw new Error('fetch failed');
    });
    const client = new GitHubApiClient({
      request,
      delay: async () => undefined,
      maxAttempts: 1,
    });

    await expect(
      determineWorkflowEligibility(input(cwd, client))
    ).resolves.toMatchObject({
      eligible: true,
      reason: 'uncertain',
      unavailableCode: 'github_api_transport',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
