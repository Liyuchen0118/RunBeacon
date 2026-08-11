import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const warned = new Set<string>();

export function runBeaconEnv(
  name: string,
  legacyName?: string
): string | undefined {
  const current = process.env[name]?.trim();
  if (current) return current;
  const legacy = legacyName ? process.env[legacyName]?.trim() : undefined;
  if (legacy && legacyName && !warned.has(legacyName)) {
    warned.add(legacyName);
    process.stderr.write(
      `RunBeacon: ${legacyName} is deprecated; use ${name}. The alias will be removed in 4.0.\n`
    );
  }
  return legacy;
}

export function runBeaconBoolean(name: string, legacyName?: string): boolean {
  return runBeaconEnv(name, legacyName)?.toLowerCase() === 'true';
}

export function resolveRunBeaconDataDir(): string {
  const configured =
    runBeaconEnv('RUNBEACON_DATA_DIR') ||
    process.env.PLUGIN_DATA ||
    process.env.CLAUDE_PLUGIN_DATA;
  if (configured) return configured;
  const current = join(homedir(), '.runbeacon');
  const legacy = join(homedir(), '.remote-job-monitor');
  if (!existsSync(current) && existsSync(legacy)) {
    try {
      renameSync(legacy, current);
    } catch {
      return legacy;
    }
  }
  return current;
}
