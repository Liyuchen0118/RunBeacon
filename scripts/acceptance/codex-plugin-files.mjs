import fs from 'node:fs';
import path from 'node:path';

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
  fs.rmSync(staging, { recursive: true, force: true });
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
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function swapPluginSource(staging, target, backup) {
  const targetExisted = fs.existsSync(target);
  if (targetExisted) fs.renameSync(target, backup);
  try {
    fs.renameSync(staging, target);
  } catch (error) {
    if (targetExisted && fs.existsSync(backup)) {
      fs.renameSync(backup, target);
    }
    throw error;
  }
  return targetExisted;
}

export function restorePluginSource(target, backup, targetExisted) {
  if (targetExisted && !fs.existsSync(backup)) {
    throw new Error(`plugin backup is missing: ${backup}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  if (targetExisted) fs.renameSync(backup, target);
}
