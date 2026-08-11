import {
  classifyGitPushFailure,
  isSuccessfulActionsConclusion,
  parseGitCredentialOutput,
  parseGitHubRepository,
  retryGitPush,
} from '../lifecycle/GitHubPublish.js';

describe('GitHub publishing helpers', () => {
  test.each([
    [
      'https://github.com/Liyuchen0118/RunBeacon.git',
      { owner: 'Liyuchen0118', repository: 'RunBeacon' },
    ],
    [
      'git@github.com:Liyuchen0118/RunBeacon.git',
      { owner: 'Liyuchen0118', repository: 'RunBeacon' },
    ],
    [
      'ssh://git@github.com/Liyuchen0118/RunBeacon',
      { owner: 'Liyuchen0118', repository: 'RunBeacon' },
    ],
  ])('parses GitHub remote %s', (remote, expected) => {
    expect(parseGitHubRepository(remote)).toEqual(expected);
  });

  test('rejects non-GitHub remotes', () => {
    expect(parseGitHubRepository('https://example.com/acme/repo.git')).toBe(
      undefined
    );
  });

  test.each([
    ['fatal: Authentication failed', 'authentication'],
    ['! [rejected] main -> main (non-fast-forward)', 'non_fast_forward'],
    ['remote: Permission to acme/repo denied', 'permission'],
    ['fatal: unable to access: Could not resolve host', 'network'],
    ['fatal: unable to access: Recv failure: Connection was reset', 'network'],
    [
      'send-pack: unexpected disconnect while reading sideband packet',
      'network',
    ],
    ['fatal: the remote end hung up unexpectedly', 'network'],
    ['fatal: an unexpected push failure', 'unknown'],
  ])('classifies push failure output', (output, expected) => {
    expect(classifyGitPushFailure(output)).toBe(expected);
  });

  test.each(['success', 'neutral', 'skipped'])(
    'accepts the %s Actions conclusion',
    (conclusion) => {
      expect(isSuccessfulActionsConclusion(conclusion)).toBe(true);
    }
  );

  test.each(['failure', 'cancelled', 'timed_out', null])(
    'rejects the %s Actions conclusion',
    (conclusion) => {
      expect(isSuccessfulActionsConclusion(conclusion)).toBe(false);
    }
  );

  test('parses Git credential helper output without changing token contents', () => {
    expect(
      parseGitCredentialOutput(
        'protocol=https\r\nhost=github.com\r\nusername=oauth\r\npassword=token=with=equals\r\n'
      )
    ).toEqual({ username: 'oauth', password: 'token=with=equals' });
  });

  test('retries only network push failures with bounded backoff', async () => {
    const runAttempt = jest
      .fn()
      .mockResolvedValueOnce({
        code: 1,
        stdout: '',
        stderr: 'Recv failure: Connection was reset',
      })
      .mockResolvedValueOnce({
        code: 1,
        stdout: '',
        stderr: 'Could not resolve host: github.com',
      })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    const notices: unknown[] = [];
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(
      retryGitPush(runAttempt, (notice) => notices.push(notice), sleep)
    ).resolves.toMatchObject({ code: 0 });
    expect(runAttempt).toHaveBeenCalledTimes(3);
    expect(notices).toEqual([
      { attempt: 1, maxAttempts: 5, delayMs: 500 },
      { attempt: 2, maxAttempts: 5, delayMs: 1_000 },
    ]);
    expect(sleep.mock.calls).toEqual([[500], [1_000]]);

    const permissionFailure = jest.fn().mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'Permission to repository denied',
    });
    await retryGitPush(permissionFailure, () => undefined, sleep);
    expect(permissionFailure).toHaveBeenCalledTimes(1);
  });
});
