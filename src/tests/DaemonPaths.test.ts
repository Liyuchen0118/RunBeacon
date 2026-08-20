import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDaemonToken, getDaemonPaths } from '../lifecycle/DaemonPaths.js';

describe('daemon token security', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runbeacon-daemon-token-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('creates one strict token and reuses it', () => {
    const paths = getDaemonPaths(root);
    const token = ensureDaemonToken(paths);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureDaemonToken(paths)).toBe(token);
  });

  test('rejects an existing token with invalid contents', () => {
    const paths = getDaemonPaths(root);
    writeFileSync(paths.tokenPath, 'x'.repeat(64), { mode: 0o600 });
    expect(() => ensureDaemonToken(paths)).toThrow(/invalid contents/);
  });

  (process.platform === 'win32' ? test.skip : test)(
    'rejects permissive token permissions',
    () => {
      const paths = getDaemonPaths(root);
      writeFileSync(paths.tokenPath, 'a'.repeat(64), { mode: 0o600 });
      chmodSync(paths.tokenPath, 0o644);
      expect(() => ensureDaemonToken(paths)).toThrow(
        /permissions must be 0600/
      );
    }
  );

  (process.platform === 'win32' ? test.skip : test)(
    'does not follow a daemon token symlink',
    () => {
      const paths = getDaemonPaths(root);
      const target = join(root, 'attacker-token');
      writeFileSync(target, 'b'.repeat(64), { mode: 0o600 });
      symlinkSync(target, paths.tokenPath);
      expect(() => ensureDaemonToken(paths)).toThrow();
    }
  );
});
