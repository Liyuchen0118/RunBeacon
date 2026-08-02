import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export interface DaemonPaths {
  dataDir: string;
  socketPath: string;
  tokenPath: string;
  statePath: string;
}

export function getDaemonPaths(dataDirInput: string): DaemonPaths {
  const dataDir = resolve(dataDirInput);
  const suffix = createHash('sha256')
    .update(dataDir)
    .digest('hex')
    .slice(0, 16);
  return {
    dataDir,
    socketPath:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\remote-job-monitor-${suffix}`
        : join(dataDir, 'daemon.sock'),
    tokenPath: join(dataDir, 'daemon.token'),
    statePath: join(dataDir, 'jobs.json'),
  };
}

export function ensureDaemonToken(paths: DaemonPaths): string {
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(paths.dataDir, 0o700);

  if (!existsSync(paths.tokenPath)) {
    try {
      writeFileSync(paths.tokenPath, randomBytes(32).toString('hex'), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
    }
  }
  if (process.platform !== 'win32') chmodSync(paths.tokenPath, 0o600);
  return readFileSync(paths.tokenPath, 'utf8').trim();
}
