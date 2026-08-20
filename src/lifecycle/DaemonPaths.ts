import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  chmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
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

  try {
    const descriptor = openSync(
      paths.tokenPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        noFollowFlag(),
      0o600
    );
    try {
      writeSync(descriptor, randomBytes(32).toString('hex'), undefined, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      return readDaemonToken(paths.tokenPath);
    } catch (error) {
      if (attempt >= 20 || !(error instanceof DaemonTokenNotReadyError)) {
        throw error;
      }
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
        0,
        0,
        5
      );
    }
  }
}

function readDaemonToken(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size !== 64) {
      throw new DaemonTokenNotReadyError(
        'RunBeacon daemon token must be a 64-byte regular file'
      );
    }
    if (process.platform !== 'win32') {
      const getuid = process.getuid;
      if (getuid && stats.uid !== getuid()) {
        throw new Error('RunBeacon daemon token is not owned by this user');
      }
      if ((stats.mode & 0o777) !== 0o600) {
        throw new Error('RunBeacon daemon token permissions must be 0600');
      }
    }
    const token = readFileSync(descriptor, 'utf8');
    if (!/^[0-9a-f]{64}$/.test(token)) {
      throw new Error('RunBeacon daemon token has invalid contents');
    }
    return token;
  } finally {
    closeSync(descriptor);
  }
}

class DaemonTokenNotReadyError extends Error {}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
}
