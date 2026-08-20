import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CredentialProfile,
  CredentialProfileDocument,
  parseCredentialProfileDocument,
  readCredentialProfileDocument,
  writeCredentialProfileDocument,
} from './CredentialProfileStore.js';

const PROFILE_FILE = 'credential-profiles.json';
const LOCK_FILE = 'credential-migration-v3.lock';
const MARKER_FILE = 'credential-migration-v3.json';
const MAX_PROFILE_BYTES = 1024 * 1024;
const LOCK_WAIT_MS = 5_000;
const STALE_LOCK_MS = 5 * 60_000;

interface MigrationMarker {
  version: 1;
  sources: Array<{
    pathHash: string;
    contentHash: string;
    migratedAt: string;
  }>;
}

export interface CredentialMigrationResult {
  importedProfiles: number;
  migratedSources: number;
  skippedSources: number;
}

export function migrateRunBeaconCredentialProfiles(
  canonicalDataDirInput: string,
  sourceDataDirs: string[]
): CredentialMigrationResult {
  const canonicalDataDir = resolve(canonicalDataDirInput);
  const canonicalPath = join(canonicalDataDir, PROFILE_FILE);
  const sources = Array.from(
    new Set(
      sourceDataDirs
        .map((directory) => resolve(directory))
        .filter((directory) => directory !== canonicalDataDir)
    )
  );
  if (sources.length === 0) {
    return { importedProfiles: 0, migratedSources: 0, skippedSources: 0 };
  }

  mkdirSync(canonicalDataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(canonicalDataDir, 0o700);
  const releaseLock = acquireMigrationLock(join(canonicalDataDir, LOCK_FILE));
  try {
    const markerPath = join(canonicalDataDir, MARKER_FILE);
    const marker = readMarker(markerPath);
    const migratedKeys = new Set(
      marker.sources.map((source) => `${source.pathHash}:${source.contentHash}`)
    );
    const candidates: Array<{
      filePath: string;
      pathHash: string;
      contentHash: string;
      document: CredentialProfileDocument;
    }> = [];
    let skippedSources = 0;

    for (const directory of sources) {
      const filePath = join(directory, PROFILE_FILE);
      const loaded = readMigrationSource(filePath);
      if (!loaded) continue;
      const pathHash = digest(resolve(filePath));
      const key = `${pathHash}:${loaded.contentHash}`;
      if (migratedKeys.has(key)) {
        skippedSources += 1;
        continue;
      }
      candidates.push({ filePath, pathHash, ...loaded });
    }
    if (candidates.length === 0) {
      return { importedProfiles: 0, migratedSources: 0, skippedSources };
    }

    const canonical = readCredentialProfileDocument(canonicalPath);
    const profiles = new Map(
      canonical.profiles.map((profile) => [profile.id, profile])
    );
    const defaults = validDefaults(canonical, profiles);
    let importedProfiles = 0;

    for (const candidate of candidates) {
      for (const profile of candidate.document.profiles) {
        if (profiles.has(profile.id)) continue;
        profiles.set(profile.id, profile);
        importedProfiles += 1;
      }
      const sourceDefaults = validDefaults(candidate.document, profiles);
      for (const kind of ['ssh', 'github'] as const) {
        if (!defaults[kind] && sourceDefaults[kind]) {
          defaults[kind] = sourceDefaults[kind];
        }
      }
    }

    if (importedProfiles > 0) {
      backupCanonicalProfiles(canonicalPath);
      writeCredentialProfileDocument(canonicalPath, {
        version: 1,
        profiles: Array.from(profiles.values()).sort((left, right) =>
          left.id.localeCompare(right.id)
        ),
        defaults,
      });
    }

    const migratedAt = new Date().toISOString();
    for (const candidate of candidates) {
      marker.sources.push({
        pathHash: candidate.pathHash,
        contentHash: candidate.contentHash,
        migratedAt,
      });
    }
    marker.sources = marker.sources.slice(-256);
    writeRestrictedJson(markerPath, marker);
    for (const candidate of candidates) retireSource(candidate.filePath);
    return {
      importedProfiles,
      migratedSources: candidates.length,
      skippedSources,
    };
  } finally {
    releaseLock();
  }
}

function readMigrationSource(
  filePath: string
): { contentHash: string; document: CredentialProfileDocument } | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    return undefined;
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_PROFILE_BYTES) {
      return undefined;
    }
    const serialized = readFileSync(descriptor, 'utf8');
    return {
      contentHash: digest(serialized),
      document: parseCredentialProfileDocument(serialized),
    };
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

function validDefaults(
  document: CredentialProfileDocument,
  profiles: Map<string, CredentialProfile>
): Partial<Record<CredentialProfile['kind'], string>> {
  const result: Partial<Record<CredentialProfile['kind'], string>> = {};
  for (const kind of ['ssh', 'github'] as const) {
    const id = document.defaults?.[kind];
    if (id && profiles.get(id)?.kind === kind) result[kind] = id;
  }
  return result;
}

function backupCanonicalProfiles(canonicalPath: string): void {
  if (!existsSync(canonicalPath)) return;
  const backup = `${canonicalPath}.pre-v3-migration.bak`;
  if (existsSync(backup)) return;
  try {
    copyFileSync(canonicalPath, backup, constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') chmodSync(backup, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function retireSource(filePath: string): void {
  const preferred = `${filePath}.migrated-v3.bak`;
  const destination = existsSync(preferred)
    ? `${preferred}.${randomUUID()}`
    : preferred;
  try {
    renameSync(filePath, destination);
    if (process.platform !== 'win32') chmodSync(destination, 0o600);
  } catch {
    // The canonical marker prevents re-import if a plugin host keeps this file open.
  }
}

function readMarker(path: string): MigrationMarker {
  try {
    const marker = JSON.parse(readFileSync(path, 'utf8')) as MigrationMarker;
    if (marker.version !== 1 || !Array.isArray(marker.sources))
      throw new Error();
    return {
      version: 1,
      sources: marker.sources.filter(
        (source) =>
          /^[0-9a-f]{64}$/.test(source.pathHash) &&
          /^[0-9a-f]{64}$/.test(source.contentHash) &&
          Number.isFinite(Date.parse(source.migratedAt))
      ),
    };
  } catch {
    return { version: 1, sources: [] };
  }
}

function writeRestrictedJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    const descriptor = openSync(temporary, 'r+');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (process.platform !== 'win32') chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function acquireMigrationLock(path: string): () => void {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const descriptor = openSync(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          noFollowFlag(),
        0o600
      );
      writeSync(
        descriptor,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
        undefined,
        'utf8'
      );
      fsyncSync(descriptor);
      const identity = fstatSync(descriptor);
      return () => {
        closeSync(descriptor);
        try {
          const current = lstatSync(path);
          if (current.dev === identity.dev && current.ino === identity.ino) {
            rmSync(path, { force: true });
          }
        } catch {
          // Another recovery path may already have retired a stale lock.
        }
      };
    } catch (error) {
      if (!isMigrationLockContention(error, path)) throw error;
      if (retireStaleLock(path)) continue;
      if (Date.now() >= deadline) {
        throw new Error('RunBeacon credential migration lock is busy');
      }
      sleepSync(25);
    }
  }
}

function isMigrationLockContention(error: unknown, path: string): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EEXIST') return true;

  // Windows can report EPERM instead of EEXIST when another process still
  // holds an O_EXCL-created file open. Only classify it as contention when
  // the lock path exists, so unrelated permission failures remain fatal.
  return process.platform === 'win32' && code === 'EPERM' && existsSync(path);
}

function retireStaleLock(path: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
  } catch {
    return false;
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || Date.now() - stats.mtimeMs <= STALE_LOCK_MS) {
      return false;
    }
    let pid = 0;
    try {
      const parsed = JSON.parse(readFileSync(descriptor, 'utf8')) as {
        pid?: number;
      };
      pid = Number(parsed.pid) || 0;
    } catch {
      pid = 0;
    }
    if (pid > 0 && processIsAlive(pid)) return false;
  } finally {
    closeSync(descriptor);
  }

  const retired = `${path}.stale.${randomUUID()}`;
  try {
    renameSync(path, retired);
    rmSync(retired, { force: true });
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds
  );
}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
