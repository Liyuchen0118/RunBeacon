import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LifecycleManager } from '../lifecycle/LifecycleManager.js';
import { createDashboardHtml } from '../lifecycle/DashboardApp.js';
import { redactCommand } from '../lifecycle/security.js';

describe('LifecycleManager', () => {
  let testRoot: string;
  let statePath: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), 'remote-job-monitor-'));
    statePath = join(testRoot, 'jobs.json');
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  test('waits on process events and returns the terminal result', async () => {
    const manager = new LifecycleManager({ statePath });
    const script = [
      "console.log('10% starting')",
      "setTimeout(() => console.log('60% working'), 30)",
      "setTimeout(() => { console.log('100% done'); process.exit(0) }, 70)",
    ].join(';');

    const started = manager.start({
      command: process.execPath,
      args: ['-e', script],
      shell: false,
      label: 'event-driven-test',
    });
    const result = await manager.waitForTerminal(started.id, 5_000, 40);

    expect(result.timedOut).toBe(false);
    expect(result.job.state).toBe('succeeded');
    expect(result.job.exitCode).toBe(0);
    expect(result.job.progress?.percentage).toBe(100);
    expect(result.job.progress?.message).toBe('100% done');
    expect(result.job.assessment.phase).toBe('finished');
    expect(result.job.assessment.health).toBe('terminal');
    expect(result.job.assessment.elapsedMs).toBeGreaterThan(0);
    expect(result.job.tail.map((chunk) => chunk.data).join('')).toContain(
      '100% done'
    );
  });

  test('marks an over-time process as timed_out', async () => {
    const manager = new LifecycleManager({ statePath });
    const started = manager.start({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      shell: false,
      timeoutMs: 100,
    });
    const result = await manager.waitForTerminal(started.id, 5_000);

    expect(result.timedOut).toBe(false);
    expect(result.job.state).toBe('timed_out');
  });

  test('does not persist command output unless explicitly enabled', async () => {
    const manager = new LifecycleManager({ statePath });
    const started = manager.start({
      command: process.execPath,
      args: ['-e', "console.log('DO_NOT_PERSIST_THIS_OUTPUT')"],
      shell: false,
    });
    await manager.waitForTerminal(started.id, 5_000);

    const persisted = readFileSync(statePath, 'utf8');
    expect(persisted).not.toContain('DO_NOT_PERSIST_THIS_OUTPUT');
  });

  test('does not persist arbitrary metadata or output-derived progress messages by default', async () => {
    const manager = new LifecycleManager({ statePath });
    const marker = 'SYNTHETIC_SECRET_MARKER_9481';
    const started = manager.start({
      command: process.execPath,
      args: ['-e', `console.log('50% ${marker}')`],
      shell: false,
      label: 'safe-label',
      progressPattern: '(\\d+)% .*',
      metadata: { token: marker, note: marker },
    });
    await manager.waitForTerminal(started.id, 5_000);

    const persisted = readFileSync(statePath, 'utf8');
    expect(persisted).not.toContain(marker);
    expect(persisted).not.toContain('metadata');
  });

  test('sanitizes opted-in metadata using sensitive-key and command redaction', async () => {
    const manager = new LifecycleManager({
      statePath,
      persistMetadata: true,
    });
    const marker = 'SYNTHETIC_TOKEN_3127';
    const password = 'SYNTHETIC_PASSWORD_6184';
    const started = manager.start({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      shell: false,
      label: 'metadata-redaction',
      metadata: {
        apiToken: marker,
        note: `deploy --password ${password}`,
      },
    });
    await manager.waitForTerminal(started.id, 5_000);

    const persisted = readFileSync(statePath, 'utf8');
    expect(persisted).not.toContain(marker);
    expect(persisted).not.toContain(password);
    expect(persisted).toContain('[REDACTED]');
  });

  test('drops previously persisted output and metadata when recovery opt-ins are disabled', async () => {
    const marker = 'RECOVERY_PRIVATE_MARKER_7719';
    const writer = new LifecycleManager({
      statePath,
      persistOutput: true,
      persistMetadata: true,
    });
    const started = writer.start({
      command: process.execPath,
      args: ['-e', `console.log('75% ${marker}')`],
      shell: false,
      label: 'recovery-policy',
      progressPattern: '(\\d+)% .*',
      metadata: { note: marker },
    });
    await writer.waitForTerminal(started.id, 5_000);
    expect(readFileSync(statePath, 'utf8')).toContain(marker);

    const recovered = new LifecycleManager({ statePath });
    const snapshot = recovered.snapshot(started.id, 50);
    expect(snapshot.tail).toEqual([]);
    expect(snapshot.metadata).toBeUndefined();
    expect(snapshot.progress?.message).toBeUndefined();
    expect(readFileSync(statePath, 'utf8')).not.toContain(marker);
  });

  test('deduplicates job starts with a caller-provided idempotency key', async () => {
    const manager = new LifecycleManager({ statePath });
    const input = {
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 50)'],
      shell: false,
      idempotencyKey: 'deploy-release-123',
    };
    const first = manager.start(input);
    const retried = manager.start(input);

    expect(retried.id).toBe(first.id);
    await manager.waitForTerminal(first.id, 5_000);
  });

  test('releases an event-driven wait when its abort signal fires', async () => {
    const manager = new LifecycleManager({ statePath });
    const started = manager.start({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 5000)'],
      shell: false,
    });
    const controller = new AbortController();
    const waiting = manager.waitForTerminal(
      started.id,
      10_000,
      20,
      controller.signal
    );
    controller.abort();

    await expect(waiting).rejects.toThrow(/aborted/);
    manager.cancel(started.id);
    await manager.waitForTerminal(started.id, 5_000);
  });

  test('preserves split UTF-8 output and keeps the in-memory ring bounded', async () => {
    const manager = new LifecycleManager({
      statePath,
      maxOutputBytes: 64 * 1024,
    });
    const script = [
      "const value = Buffer.from('中文进度 100% 完成\\n')",
      "process.stdout.write('x'.repeat(128 * 1024))",
      'setTimeout(() => process.stdout.write(value.subarray(0, 1)), 20)',
      'setTimeout(() => process.stdout.write(value.subarray(1)), 40)',
      'setTimeout(() => process.exit(0), 70)',
    ].join(';');
    const started = manager.start({
      command: process.execPath,
      args: ['-e', script],
      shell: false,
    });
    const completed = await manager.waitForTerminal(started.id, 5_000, 500);

    expect(completed.job.state).toBe('succeeded');
    expect(completed.job.outputBytes).toBeLessThanOrEqual(64 * 1024);
    expect(completed.job.outputTruncated).toBe(true);
    expect(completed.job.progress?.percentage).toBe(100);
    expect(completed.job.tail.map((chunk) => chunk.data).join('')).toContain(
      '中文进度 100% 完成'
    );
  });

  test('retains only the configured number of terminal jobs', async () => {
    const manager = new LifecycleManager({
      statePath,
      maxRetainedJobs: 2,
    });
    for (let index = 0; index < 3; index += 1) {
      const started = manager.start({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        shell: false,
        label: `retention-${index}`,
      });
      await manager.waitForTerminal(started.id, 5_000);
    }

    expect(manager.list(0, 100)).toHaveLength(2);
    expect(new LifecycleManager({ statePath }).list(0, 100)).toHaveLength(2);
  });

  test('ignores malformed persisted job records during recovery', () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        jobs: [{ id: 'broken-record' }],
      })
    );

    const manager = new LifecycleManager({ statePath });
    expect(manager.list()).toEqual([]);
  });

  test('requires SSH host verification unless explicitly overridden', () => {
    const manager = new LifecycleManager({ statePath });
    expect(() =>
      manager.start({
        command: 'echo hello',
        target: {
          kind: 'ssh',
          host: '127.0.0.1',
          port: 1,
          username: 'test',
          password: 'memory-only-password',
        },
      })
    ).toThrow(/hostKeySha256/);
  });

  test('never persists an inline SSH password', async () => {
    const manager = new LifecycleManager({ statePath });
    const password = 'RJM_INLINE_PASSWORD_MUST_NOT_PERSIST';
    const started = manager.start({
      command: 'echo hello',
      timeoutMs: 500,
      target: {
        kind: 'ssh',
        host: '127.0.0.1',
        port: 1,
        username: 'test',
        password,
        allowUnverifiedHostKey: true,
      },
    });

    expect(JSON.stringify(started)).not.toContain(password);
    expect(readFileSync(statePath, 'utf8')).not.toContain(password);
    const completed = await manager.waitForTerminal(started.id, 5_000);
    expect(completed.job.state).toBe('failed');
    expect(readFileSync(statePath, 'utf8')).not.toContain(password);
  });
});

describe('lifecycle safety and UI helpers', () => {
  test('redacts common command-line secret forms', () => {
    expect(redactCommand('deploy --password hunter2 --api-key=abc')).toBe(
      'deploy --password [REDACTED] --api-key=[REDACTED]'
    );
    expect(redactCommand('git push https://secret@github.com/acme/repo')).toBe(
      'git push https://[REDACTED]@github.com/acme/repo'
    );
  });

  test('dashboard uses the MCP Apps bridge and direct tool calls', () => {
    const html = createDashboardHtml();
    expect(html).toContain("request('ui/initialize'");
    expect(html).toContain("request('tools/call'");
    expect(html).toContain("callTool('job_list'");
    expect(html).toContain('no model polling');
    expect(html).toContain('data?.job');
    expect(html).toContain('job.progress.phase');
    expect(html).toContain("job.metadata?.kind === 'github_publish'");
  });

  test('plugin hook blocks raw SSH but leaves unrelated Bash commands alone', () => {
    const hook = join(process.cwd(), 'hooks', 'route-ssh.cjs');
    const ssh = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'ssh user@example.com python train.py' },
      }),
      encoding: 'utf8',
    });
    const decision = JSON.parse(ssh.stdout);
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toMatch(
      /job_start/
    );

    const unrelated = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm run build' },
      }),
      encoding: 'utf8',
    });
    expect(unrelated.stdout).toBe('');
  });
});
