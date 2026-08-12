import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const WINDOWS_CODEX_COMPANIONS = [
  'codex-code-mode-host.exe',
  'codex-command-runner.exe',
  'codex-windows-sandbox-setup.exe',
];

export function buildCodexAcceptanceArgs(prompt) {
  return [
    'exec',
    '--json',
    '--approve-for-me',
    '--skip-git-repo-check',
    prompt,
  ];
}

export function isCodexPluginInstalled(output, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\s+installed(?:,\\s*enabled)?\\s`, 'm').test(
    output
  );
}

export function parseCodexPluginInstallResult(output, selector) {
  let result;
  try {
    result = JSON.parse(output.trim());
  } catch (error) {
    throw new Error(`codex plugin add emitted invalid JSON: ${error.message}`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('codex plugin add did not return an object');
  }
  if (result.pluginId !== selector) {
    throw new Error(
      `codex plugin add returned ${String(result.pluginId)} instead of ${selector}`
    );
  }
  if (typeof result.version !== 'string' || !result.version.trim()) {
    throw new Error('codex plugin add did not return a version');
  }
  if (
    typeof result.installedPath !== 'string' ||
    !result.installedPath.trim()
  ) {
    throw new Error('codex plugin add did not return an installed path');
  }
  return result;
}

export function isWindowsStoreCodexBinary(command) {
  if (typeof command !== 'string' || !path.win32.isAbsolute(command)) {
    return false;
  }
  const normalized = command.replaceAll('/', '\\').toLowerCase();
  const basename = path.win32.basename(normalized);
  return (
    normalized.includes('\\program files\\windowsapps\\openai.codex_') &&
    normalized.includes('\\app\\resources\\') &&
    (basename === 'codex' || basename === 'codex.exe')
  );
}

function discoverWindowsCodex() {
  const powershell = path.join(
    process.env.WINDIR ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const result = spawnSync(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-Command codex.exe -ErrorAction Stop).Source',
    ],
    { encoding: 'utf8', shell: false }
  );
  if (result.status !== 0) return undefined;
  const source = result.stdout.trim();
  return source || undefined;
}

export function prepareCodexCommand({
  configuredCommand = process.env.RUNBEACON_CODEX_BIN,
  platform = process.platform,
  tempRoot = os.tmpdir(),
} = {}) {
  const source =
    configuredCommand ||
    (platform === 'win32' ? discoverWindowsCodex() : undefined) ||
    (platform === 'win32' ? 'codex.cmd' : 'codex');

  if (platform !== 'win32' || !isWindowsStoreCodexBinary(source)) {
    return { command: source, cleanup() {} };
  }

  const temporaryDirectory = fs.mkdtempSync(
    path.join(tempRoot, 'runbeacon-codex-cli-')
  );
  const command = path.join(temporaryDirectory, 'codex.exe');
  try {
    fs.copyFileSync(source, command);
    for (const companion of WINDOWS_CODEX_COMPANIONS) {
      fs.copyFileSync(
        path.join(path.dirname(source), companion),
        path.join(temporaryDirectory, companion)
      );
    }
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    command,
    cleanup() {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    },
  };
}
