#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const platform = process.platform;
const architecture = process.arch;
if (!['linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(architecture)) {
  throw new Error(`Unsupported Runner target: ${platform}/${architecture}`);
}
const root = dirname(fileURLToPath(import.meta.url));
const name = `runbeacon-runner-${platform}-${architecture}`;
const asset = join(root, 'assets', name);
const sums = readFileSync(join(root, 'assets', 'SHA256SUMS'), 'utf8');
const expected = sums
  .split(/\r?\n/)
  .map((line) => line.trim().split(/\s+/))
  .find((entry) => entry.at(-1) === name)?.[0];
if (!expected || !/^[0-9a-f]{64}$/i.test(expected)) {
  throw new Error(`Missing SHA256 entry for ${name}`);
}
const actual = createHash('sha256').update(readFileSync(asset)).digest('hex');
if (actual.toLowerCase() !== expected.toLowerCase()) {
  throw new Error(`SHA256 verification failed for ${name}`);
}
const target =
  platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'RunBeacon', 'bin', 'runbeacon-runner')
    : join(homedir(), '.local', 'bin', 'runbeacon-runner');
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
copyFileSync(asset, target);
chmodSync(target, 0o700);
const installed = spawnSync(target, ['install'], { stdio: 'inherit' });
if (installed.error) throw installed.error;
if (installed.status !== 0) {
  throw new Error(`Runner service installation exited with code ${installed.status}`);
}
process.stdout.write(`${target}\n`);

