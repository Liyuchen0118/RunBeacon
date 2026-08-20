import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

export function resolveRunBeaconDataDir(
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const configured = environment.RUNBEACON_DATA_DIR?.trim();
  return resolve(configured || join(home, '.runbeacon'));
}

export function runBeaconCredentialMigrationSources(
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string[] {
  if (environment.RUNBEACON_DATA_DIR?.trim()) return [];
  const canonical = resolveRunBeaconDataDir(environment, home);
  return Array.from(
    new Set(
      [
        environment.PLUGIN_DATA?.trim(),
        environment.CLAUDE_PLUGIN_DATA?.trim(),
        join(home, '.remote-job-monitor'),
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => resolve(value))
        .filter((value) => value !== canonical)
    )
  );
}
