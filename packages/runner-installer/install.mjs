#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyRunnerAsset } from './verify.mjs';

const platform = process.platform;
const architecture = process.arch;
if (
  !['linux', 'darwin'].includes(platform) ||
  !['x64', 'arm64'].includes(architecture)
) {
  throw new Error(`Unsupported Runner target: ${platform}/${architecture}`);
}

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `runbeacon-runner-${platform}-${architecture}`;
const asset = join(root, 'assets', name);
const binary = await verifyRunnerAsset({
  name,
  asset,
  sumsPath: join(root, 'assets', 'SHA256SUMS'),
  bundlePath: `${asset}.sigstore.json`,
});
const target =
  platform === 'darwin'
    ? join(
        homedir(),
        'Library',
        'Application Support',
        'RunBeacon',
        'bin',
        'runbeacon-runner'
      )
    : join(homedir(), '.local', 'bin', 'runbeacon-runner');
const temporary = `${target}.new-${process.pid}`;
const backup = `${target}.previous`;
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
copyFileSync(asset, temporary);
chmodSync(temporary, 0o700);

const versionCheck = spawnSync(temporary, ['version'], {
  encoding: 'utf8',
  shell: false,
});
if (
  versionCheck.error ||
  versionCheck.status !== 0 ||
  versionCheck.stdout.trim() !== manifest.version
) {
  rmSync(temporary, { force: true });
  throw new Error(
    `Runner asset version did not match installer ${manifest.version}`
  );
}

let movedExisting = false;
try {
  rmSync(backup, { force: true });
  if (existsSync(target)) {
    renameSync(target, backup);
    movedExisting = true;
  }
  renameSync(temporary, target);
  const installed = spawnSync(target, ['install'], {
    stdio: 'inherit',
    shell: false,
  });
  if (installed.error) throw installed.error;
  if (installed.status !== 0) {
    throw new Error(
      `Runner service installation exited with code ${installed.status}`
    );
  }
  rmSync(backup, { force: true });
  process.stdout.write(`${target}\n`);
} catch (error) {
  rmSync(temporary, { force: true });
  rmSync(target, { force: true });
  if (movedExisting && existsSync(backup)) {
    renameSync(backup, target);
    spawnSync(target, ['install'], { stdio: 'ignore', shell: false });
  }
  throw error;
} finally {
  binary.fill(0);
}
