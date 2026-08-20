import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCredentialProfileDocument,
  writeCredentialProfileDocument,
} from '../lifecycle/CredentialProfileStore.js';
import { migrateRunBeaconCredentialProfiles } from '../lifecycle/CredentialProfileMigration.js';
import {
  resolveRunBeaconDataDir,
  runBeaconCredentialMigrationSources,
} from '../lifecycle/Environment.js';

const now = '2026-08-20T00:00:00.000Z';

describe('RunBeacon canonical data migration', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runbeacon-profile-migration-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('uses the stable home directory unless explicitly overridden', () => {
    expect(resolveRunBeaconDataDir({}, root)).toBe(join(root, '.runbeacon'));
    expect(
      resolveRunBeaconDataDir(
        { RUNBEACON_DATA_DIR: join(root, 'isolated') },
        root
      )
    ).toBe(join(root, 'isolated'));
    expect(
      runBeaconCredentialMigrationSources(
        {
          PLUGIN_DATA: join(root, 'plugin-data'),
          CLAUDE_PLUGIN_DATA: join(root, 'claude-data'),
        },
        root
      )
    ).toEqual([
      join(root, 'plugin-data'),
      join(root, 'claude-data'),
      join(root, '.remote-job-monitor'),
    ]);
    expect(
      runBeaconCredentialMigrationSources(
        {
          RUNBEACON_DATA_DIR: join(root, 'isolated'),
          PLUGIN_DATA: join(root, 'plugin-data'),
        },
        root
      )
    ).toEqual([]);
  });

  test('merges safe references while canonical profiles and defaults win', () => {
    const canonical = join(root, 'canonical');
    const pluginData = join(root, 'plugin-data');
    const legacy = join(root, 'legacy');
    writeCredentialProfileDocument(
      join(canonical, 'credential-profiles.json'),
      {
        version: 1,
        profiles: [githubProfile('shared', 'canonical-user')],
        defaults: { github: 'shared' },
      }
    );
    writeCredentialProfileDocument(
      join(pluginData, 'credential-profiles.json'),
      {
        version: 1,
        profiles: [
          sshProfile('training'),
          githubProfile('shared', 'source-user'),
        ],
        defaults: { ssh: 'training', github: 'shared' },
      }
    );
    writeCredentialProfileDocument(join(legacy, 'credential-profiles.json'), {
      version: 1,
      profiles: [githubProfile('backup-github', 'legacy-user')],
      defaults: { github: 'backup-github' },
    });

    const result = migrateRunBeaconCredentialProfiles(canonical, [
      pluginData,
      legacy,
    ]);
    expect(result).toEqual({
      importedProfiles: 2,
      migratedSources: 2,
      skippedSources: 0,
    });
    const merged = readCredentialProfileDocument(
      join(canonical, 'credential-profiles.json')
    );
    expect(merged.profiles.map((profile) => profile.id)).toEqual([
      'backup-github',
      'shared',
      'training',
    ]);
    expect(
      merged.profiles.find((profile) => profile.id === 'shared')
    ).toMatchObject({ username: 'canonical-user' });
    expect(merged.defaults).toEqual({ github: 'shared', ssh: 'training' });
    expect(
      existsSync(
        join(canonical, 'credential-profiles.json.pre-v3-migration.bak')
      )
    ).toBe(true);
    expect(
      existsSync(join(pluginData, 'credential-profiles.json.migrated-v3.bak'))
    ).toBe(true);
    expect(
      existsSync(join(legacy, 'credential-profiles.json.migrated-v3.bak'))
    ).toBe(true);
    expect(
      readFileSync(join(canonical, 'credential-migration-v3.json'), 'utf8')
    ).not.toContain('canonical-user');
    expect(
      migrateRunBeaconCredentialProfiles(canonical, [pluginData, legacy])
    ).toEqual({
      importedProfiles: 0,
      migratedSources: 0,
      skippedSources: 0,
    });
  });

  test('leaves an invalid source untouched', () => {
    const canonical = join(root, 'canonical');
    const source = join(root, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'credential-profiles.json'), '{invalid');
    expect(migrateRunBeaconCredentialProfiles(canonical, [source])).toEqual({
      importedProfiles: 0,
      migratedSources: 0,
      skippedSources: 0,
    });
    expect(existsSync(join(source, 'credential-profiles.json'))).toBe(true);
  });
});

function githubProfile(id: string, username: string) {
  return {
    id,
    kind: 'github' as const,
    host: 'github.com' as const,
    credentialSource: 'git' as const,
    credentialKind: 'pat' as const,
    username,
    createdAt: now,
    updatedAt: now,
  };
}

function sshProfile(id: string) {
  return {
    id,
    kind: 'ssh' as const,
    host: '192.0.2.10',
    port: 22,
    username: 'runner',
    credentialKind: 'password' as const,
    hostKeySha256: 'SHA256:test',
    createdAt: now,
    updatedAt: now,
  };
}
