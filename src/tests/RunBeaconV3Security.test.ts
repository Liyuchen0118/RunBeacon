import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditIntegrityError, AuditLog } from '../lifecycle/AuditLog.js';
import { commandForAdapter } from '../lifecycle/Adapters.js';
import { EventSubscriptionStore } from '../lifecycle/EventSubscriptionStore.js';
import { PolicyEngine } from '../lifecycle/PolicyEngine.js';

describe('RunBeacon 3 security services', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runbeacon-v3-security-'));
  });

  afterEach(() => {
    delete process.env.RUNBEACON_TEST_WEBHOOK_URL;
    delete process.env.RUNBEACON_TEST_WEBHOOK_SECRET;
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  test('detects audit-chain tampering and refuses queries or appends', () => {
    const path = join(root, 'audit.jsonl');
    const audit = new AuditLog(path);
    audit.append({
      action: 'job_start',
      outcome: 'queued',
      jobId: 'job-12345678',
      commandDigest: `sha256:${'a'.repeat(64)}`,
    });
    audit.append({
      action: 'job_terminal',
      outcome: 'succeeded',
      jobId: 'job-12345678',
    });
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.replace('succeeded', 'failed'));

    expect(() => audit.query()).toThrow(AuditIntegrityError);
    expect(() =>
      audit.append({ action: 'policy_update', outcome: 'updated' })
    ).toThrow(/AUDIT_INTEGRITY_FAILURE/);
  });

  test('classifies risky work and bounds approval grants to five-minute defaults', () => {
    const policy = new PolicyEngine(join(root, 'policy.json'));

    expect(policy.classify('echo ok', 'generic')).toMatchObject({
      risk: 'standard',
      requiresApproval: false,
    });
    expect(policy.classify('sudo systemctl restart app', 'generic').risk).toBe(
      'privileged'
    );
    expect(policy.classify('npm publish', 'generic').risk).toBe('release');
    expect(policy.classify('rm -rf ./build', 'generic').risk).toBe(
      'destructive'
    );
    expect(
      policy.classify('codesign --sign ID app', 'apple-signing').risk
    ).toBe('credential');
    expect(policy.get().approvalTtlSeconds).toBe(300);
    expect(policy.update({ approvalTtlSeconds: 1 }).approvalTtlSeconds).toBe(
      60
    );
    expect(
      policy.update({ approvalTtlSeconds: 10_000 }).approvalTtlSeconds
    ).toBe(900);
  });

  test('signs webhook delivery without persisting the HMAC secret', async () => {
    const path = join(root, 'subscriptions.json');
    const store = new EventSubscriptionStore(path);
    process.env.RUNBEACON_TEST_WEBHOOK_URL =
      'https://events.example.test/runbeacon';
    store.save({
      id: 'build-finished',
      kind: 'webhook',
      urlEnvVar: 'RUNBEACON_TEST_WEBHOOK_URL',
      hmacSecretEnvVar: 'RUNBEACON_TEST_WEBHOOK_SECRET',
    });
    process.env.RUNBEACON_TEST_WEBHOOK_SECRET = 'canary-webhook-secret';
    const event = {
      event: 'job_terminal' as const,
      jobId: 'job-12345678',
      state: 'succeeded',
      finishedAt: '2026-08-11T00:00:00.000Z',
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(store.dispatch(['build-finished'], event)).resolves.toEqual([
      { id: 'build-finished', delivered: true },
    ]);

    const body = JSON.stringify(event);
    const expected = createHmac('sha256', 'canary-webhook-secret')
      .update(body)
      .digest('hex');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://events.example.test/runbeacon',
      expect.objectContaining({
        method: 'POST',
        body,
        headers: expect.objectContaining({
          'x-runbeacon-signature': `sha256=${expected}`,
        }),
      })
    );
    const persisted = readFileSync(path, 'utf8');
    expect(persisted).toContain('RUNBEACON_TEST_WEBHOOK_URL');
    expect(persisted).not.toContain('https://events.example.test/runbeacon');
    expect(persisted).toContain('RUNBEACON_TEST_WEBHOOK_SECRET');
    expect(persisted).not.toContain('canary-webhook-secret');
  });

  test('rejects unsafe webhook endpoints and limits subscription fan-out', () => {
    const store = new EventSubscriptionStore(join(root, 'subscriptions.json'));
    process.env.RUNBEACON_TEST_WEBHOOK_URL =
      'http://user:password@example.test/hook';
    expect(() =>
      store.save({
        id: 'unsafe',
        kind: 'webhook',
        urlEnvVar: 'RUNBEACON_TEST_WEBHOOK_URL',
        hmacSecretEnvVar: 'RUNBEACON_TEST_WEBHOOK_SECRET',
      })
    ).toThrow(/HTTPS URL without userinfo/);
    for (let index = 0; index < 17; index += 1) {
      store.save({ id: `codex-${index}`, kind: 'codex' });
    }
    expect(() =>
      store.validateIds(
        Array.from({ length: 17 }, (_, index) => `codex-${index}`)
      )
    ).toThrow(/at most 16/);
  });

  test('builds durable Slurm and Aqua Apple-signing wrappers without passwords', () => {
    const slurm = commandForAdapter({
      command: 'sbatch --parsable train.slurm',
      adapter: 'slurm',
    });
    expect(slurm).toContain('squeue');
    expect(slurm).toContain('sacct');
    expect(slurm).toContain('scancel');

    const signing = commandForAdapter({
      command: 'echo release-ready',
      adapter: 'apple-signing',
    });
    expect(signing).toContain('launchctl print "gui/$rb_uid"');
    expect(signing).toContain('codesign --force --options runtime --timestamp');
    expect(signing).toContain('notarytool history --keychain-profile');
    expect(signing).not.toMatch(/keychain-password|apple-id-password/i);
  });
});
