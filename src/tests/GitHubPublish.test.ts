import {
  classifyGitPushFailure,
  isSuccessfulActionsConclusion,
  parseGitHubRepository,
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
});
