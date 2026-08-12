import fs from 'node:fs';
import path from 'node:path';

const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
const DEFAULT_RENAME_ATTEMPTS = 51;
const DEFAULT_RENAME_DELAY_MS = 100;

const EXCLUDED_PARTS = new Set([
  '.git',
  '.codex-tmp',
  '.tools',
  'acceptance-results',
  'coverage',
  'data',
  'diagnostics',
  'node_modules',
  'runner-assets',
  'test-diagnostics',
  'test-results',
]);

export function stagePluginSource(source, staging) {
  removeDirectory(staging);
  try {
    fs.cpSync(source, staging, {
      recursive: true,
      filter: (entry) => {
        const relative = path.relative(source, entry);
        if (!relative) return true;
        if (path.basename(relative) === 'test-report.xml') return false;
        return !relative
          .split(path.sep)
          .some((part) => EXCLUDED_PARTS.has(part));
      },
    });
  } catch (error) {
    removeDirectory(staging);
    throw error;
  }
}

export function renameDirectoryWithRetry(
  source,
  target,
  {
    attempts = DEFAULT_RENAME_ATTEMPTS,
    delayMs = DEFAULT_RENAME_DELAY_MS,
    rename = fs.renameSync,
    sleep = blockingSleep,
  } = {}
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(source, target);
      return;
    } catch (error) {
      if (
        attempt >= attempts ||
        !TRANSIENT_RENAME_CODES.has(error?.code)
      ) {
        throw error;
      }
      sleep(delayMs);
    }
  }
}

export function swapPluginSource(staging, target, backup, options) {
  const targetExisted = fs.existsSync(target);
  if (targetExisted) renameDirectoryWithRetry(target, backup, options);
  try {
    renameDirectoryWithRetry(staging, target, options);
  } catch (error) {
    if (targetExisted && fs.existsSync(backup)) {
      try {
        renameDirectoryWithRetry(backup, target, options);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Plugin source exchange and rollback both failed'
        );
      }
    }
    throw error;
  }
  return targetExisted;
}

export function restorePluginSource(target, backup, targetExisted, options) {
  if (targetExisted && !fs.existsSync(backup)) {
    throw new Error(`plugin backup is missing: ${backup}`);
  }
  if (!targetExisted) {
    removeDirectory(target);
    return;
  }

  const displacedTarget = `${target}.acceptance-rollback-${process.pid}`;
  removeDirectory(displacedTarget);
  const targetExists = fs.existsSync(target);
  if (targetExists) {
    renameDirectoryWithRetry(target, displacedTarget, options);
  }
  try {
    renameDirectoryWithRetry(backup, target, options);
  } catch (error) {
    if (targetExists && fs.existsSync(displacedTarget)) {
      try {
        renameDirectoryWithRetry(displacedTarget, target, options);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Plugin backup restore and rollback both failed'
        );
      }
    }
    throw error;
  }
  removeDirectory(displacedTarget);
}

function removeDirectory(directory) {
  fs.rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 50,
    retryDelay: DEFAULT_RENAME_DELAY_MS,
  });
}

function blockingSleep(delayMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}
