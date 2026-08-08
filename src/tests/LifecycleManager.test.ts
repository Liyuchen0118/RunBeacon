import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Script } from 'node:vm';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { LifecycleManager } from '../lifecycle/LifecycleManager.js';
import { createDashboardHtml } from '../lifecycle/DashboardApp.js';
import { compareBuildVersions } from '../lifecycle/BuildIdentity.js';
import { redactCommand } from '../lifecycle/security.js';

type FakeSshClient = EventEmitter & {
  connect: (config: ConnectConfig) => FakeSshClient;
  exec: (
    command: string,
    callback: (error?: Error, stream?: ClientChannel) => void
  ) => FakeSshClient;
  end: () => FakeSshClient;
};

function createFakeSshClient(
  onConnect: (client: FakeSshClient, config: ConnectConfig) => void,
  onExec?: (
    client: FakeSshClient,
    command: string,
    callback: (error?: Error, stream?: ClientChannel) => void
  ) => void
): Client {
  const client = new EventEmitter() as FakeSshClient;
  client.end = jest.fn(() => client);
  client.connect = jest.fn((config: ConnectConfig) => {
    onConnect(client, config);
    return client;
  });
  client.exec = jest.fn((command, callback) => {
    onExec?.(client, command, callback);
    return client;
  });
  return client as unknown as Client;
}

function createSuccessfulChannel(): ClientChannel {
  const channel = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    close: () => void;
  };
  channel.stderr = new EventEmitter();
  channel.close = jest.fn();
  return channel as unknown as ClientChannel;
}

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

  test('binds one prompt trace to one job and persists safe timing fields', async () => {
    const manager = new LifecycleManager({ statePath });
    const requestTraceId = 'd16ee49e-39a8-4d43-93bf-3f519f715d69';
    const requestReceivedAt = new Date(Date.now() - 1_000).toISOString();
    const first = manager.start({
      command: process.execPath,
      args: ['-e', "console.log('TRACE_FIRST_JOB')"],
      shell: false,
      idempotencyKey: 'trace-first-key',
      timing: {
        requestTraceId,
        requestReceivedAt,
        toolReceivedAt: new Date().toISOString(),
        credentialsResolvedAt: new Date().toISOString(),
      },
    });
    const duplicate = manager.start({
      command: process.execPath,
      args: ['-e', "throw new Error('MUST_NOT_RUN')"],
      shell: false,
      idempotencyKey: 'trace-second-key',
      timing: { requestTraceId },
    });

    expect(duplicate.id).toBe(first.id);
    expect(manager.list(0)).toHaveLength(1);
    const completed = await manager.waitForTerminal(first.id, 5_000, 20);
    expect(completed.job.state).toBe('succeeded');
    expect(completed.job.timing?.requestReceivedAt).toBe(requestReceivedAt);
    expect(completed.job.timing?.commandStartedAt).toBeDefined();
    expect(completed.job.timing?.firstOutputAt).toBeDefined();
    expect(JSON.stringify(completed.job.tail)).toContain('TRACE_FIRST_JOB');
    expect(JSON.stringify(completed.job.tail)).not.toContain('MUST_NOT_RUN');

    const recovered = new LifecycleManager({ statePath });
    expect(recovered.snapshot(first.id).timing?.requestTraceId).toBe(
      requestTraceId
    );
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
    expect(manager.waitCoordinatorStatus()).toEqual({
      waiters: 0,
      jobs: 0,
      timers: 0,
    });
    manager.cancel(started.id);
    await manager.waitForTerminal(started.id, 5_000);
  });

  test('uses RE2-compatible progress patterns compiled at job start', async () => {
    const manager = new LifecycleManager({ statePath });
    const started = manager.start({
      command: process.execPath,
      args: ['-e', "console.log('73% working')"],
      shell: false,
      progressPattern: '(\\d+)% .*',
    });

    const result = await manager.waitForTerminal(started.id, 5_000);
    expect(result.job.progress?.percentage).toBe(73);
    expect(() =>
      manager.start({ command: 'noop', progressPattern: '\\d+%' })
    ).toThrow(/capture group 1/);
    expect(() =>
      manager.start({ command: 'noop', progressPattern: '' })
    ).toThrow(/capture group 1/);
    expect(() =>
      manager.start({ command: 'noop', progressPattern: '(?<=(\\d+))%' })
    ).toThrow(/RE2-compatible/);
    expect(() =>
      manager.start({ command: 'noop', progressPattern: '(\\d+)%.*\\1' })
    ).toThrow(/RE2-compatible/);
    expect(() =>
      manager.start({
        command: 'noop',
        progressPattern: `(${'.'.repeat(256)})`,
      })
    ).toThrow(/256 characters/);
  });

  test('bounds progress matching to the final 16 KiB of a line', async () => {
    const manager = new LifecycleManager({ statePath });
    const script =
      "process.stdout.write('a'.repeat(64 * 1024) + ' 42% done\\n')";
    const started = manager.start({
      command: process.execPath,
      args: ['-e', script],
      shell: false,
      progressPattern: '(\\d+)% .*',
    });

    const before = Date.now();
    const result = await manager.waitForTerminal(started.id, 5_000);
    expect(result.job.progress?.percentage).toBe(42);
    expect(Date.now() - before).toBeLessThan(1_000);
  });

  test('shares one timer across eight waiters and rejects the ninth', async () => {
    const manager = new LifecycleManager({ statePath });
    const started = manager.start({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 150)'],
      shell: false,
    });
    const waiters = Array.from({ length: 8 }, () =>
      manager.waitForTerminal(started.id, 5_000)
    );

    expect(manager.waitCoordinatorStatus()).toEqual({
      waiters: 8,
      jobs: 1,
      timers: 1,
    });
    await expect(manager.waitForTerminal(started.id, 5_000)).rejects.toThrow(
      'job_wait limit reached for job'
    );
    await expect(Promise.all(waiters)).resolves.toHaveLength(8);
    expect(manager.waitCoordinatorStatus()).toEqual({
      waiters: 0,
      jobs: 0,
      timers: 0,
    });
  });

  test('enforces the global waiter limit without leaking resources', async () => {
    const manager = new LifecycleManager({
      statePath,
      maxConcurrentJobs: 17,
    });
    const jobs = Array.from({ length: 17 }, (_, index) =>
      manager.start({
        command: process.execPath,
        args: [
          '-e',
          `setTimeout(() => process.exit(0), ${index === 16 ? 250 : 180})`,
        ],
        shell: false,
      })
    );
    const waiters = jobs
      .slice(0, 16)
      .flatMap((job) =>
        Array.from({ length: 8 }, () => manager.waitForTerminal(job.id, 5_000))
      );

    expect(manager.waitCoordinatorStatus()).toEqual({
      waiters: 128,
      jobs: 16,
      timers: 16,
    });
    await expect(manager.waitForTerminal(jobs[16].id, 5_000)).rejects.toThrow(
      'global job_wait limit reached'
    );
    await Promise.all(waiters);
    await manager.waitForTerminal(jobs[16].id, 5_000);
    expect(manager.waitCoordinatorStatus()).toEqual({
      waiters: 0,
      jobs: 0,
      timers: 0,
    });
  });

  test('cleans up timed-out and disposed wait coordinators', async () => {
    const manager = new LifecycleManager({ statePath });
    const started = manager.start({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 200)'],
      shell: false,
    });
    const timedOut = await manager.waitForTerminal(started.id, 10);
    expect(timedOut.timedOut).toBe(true);
    expect(manager.waitCoordinatorStatus()).toEqual({
      waiters: 0,
      jobs: 0,
      timers: 0,
    });

    const waiting = manager.waitForTerminal(started.id, 5_000);
    manager.dispose();
    await expect(waiting).rejects.toThrow(/disposed/);
    expect(manager.waitCoordinatorStatus()).toEqual({
      waiters: 0,
      jobs: 0,
      timers: 0,
    });
    manager.cancel(started.id);
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
    const manager = new LifecycleManager({
      statePath,
      sshRetryBaseDelayMs: 1,
    });
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

  test('retries handshake failures before executing the remote command', async () => {
    let clientsCreated = 0;
    let execCalls = 0;
    const manager = new LifecycleManager({
      statePath,
      sshRetryBaseDelayMs: 1,
      sshClientFactory: () => {
        clientsCreated += 1;
        const currentAttempt = clientsCreated;
        return createFakeSshClient(
          (client) => {
            setImmediate(() => {
              if (currentAttempt < 5) {
                client.emit('error', new Error('handshake unavailable'));
              } else {
                client.emit('ready');
              }
            });
          },
          (_client, _command, callback) => {
            execCalls += 1;
            const channel = createSuccessfulChannel();
            callback(undefined, channel);
            setImmediate(() => channel.emit('close', 0));
          }
        );
      },
    });
    const started = manager.start({
      command: 'run-training',
      target: {
        kind: 'ssh',
        host: 'example.test',
        username: 'runner',
        allowUnverifiedHostKey: true,
      },
    });

    const completed = await manager.waitForTerminal(started.id, 5_000, 50);

    expect(completed.job.state).toBe('succeeded');
    expect(clientsCreated).toBe(5);
    expect(execCalls).toBe(1);
    expect(completed.job.tail.map((chunk) => chunk.data).join('')).toContain(
      'SSH handshake attempt 4/5 failed; retrying'
    );
  });

  test('bounds the configurable SSH ready timeout by the job timeout', async () => {
    const observedTimeouts: number[] = [];
    const manager = new LifecycleManager({
      statePath,
      sshReadyTimeoutMs: 7_000,
      sshClientFactory: () =>
        createFakeSshClient(
          (client, config) => {
            observedTimeouts.push(config.readyTimeout!);
            setImmediate(() => client.emit('ready'));
          },
          (_client, _command, callback) => {
            const channel = createSuccessfulChannel();
            callback(undefined, channel);
            setImmediate(() => channel.emit('close', 0));
          }
        ),
    });
    const first = manager.start({
      command: 'run-training',
      target: {
        kind: 'ssh',
        host: 'example.test',
        username: 'runner',
        allowUnverifiedHostKey: true,
      },
    });
    await manager.waitForTerminal(first.id, 5_000);

    const second = manager.start({
      command: 'run-training',
      timeoutMs: 2_000,
      target: {
        kind: 'ssh',
        host: 'example.test',
        username: 'runner',
        allowUnverifiedHostKey: true,
      },
    });
    await manager.waitForTerminal(second.id, 5_000);

    const defaultManager = new LifecycleManager({
      statePath,
      sshClientFactory: () =>
        createFakeSshClient(
          (client, config) => {
            observedTimeouts.push(config.readyTimeout!);
            setImmediate(() => client.emit('ready'));
          },
          (_client, _command, callback) => {
            const channel = createSuccessfulChannel();
            callback(undefined, channel);
            setImmediate(() => channel.emit('close', 0));
          }
        ),
    });
    const defaultTimeout = defaultManager.start({
      command: 'run-training',
      target: {
        kind: 'ssh',
        host: 'example.test',
        username: 'runner',
        allowUnverifiedHostKey: true,
      },
    });
    await defaultManager.waitForTerminal(defaultTimeout.id, 5_000);

    expect(observedTimeouts).toEqual([7_000, 2_000, 12_000]);
  });

  test('uses a short default backoff only before SSH becomes ready', async () => {
    let clientsCreated = 0;
    const manager = new LifecycleManager({
      statePath,
      sshClientFactory: () => {
        clientsCreated += 1;
        const attempt = clientsCreated;
        return createFakeSshClient(
          (client) =>
            setImmediate(() =>
              attempt === 1
                ? client.emit('error', new Error('transient handshake failure'))
                : client.emit('ready')
            ),
          (_client, _command, callback) => {
            const channel = createSuccessfulChannel();
            callback(undefined, channel);
            setImmediate(() => channel.emit('close', 0));
          }
        );
      },
    });
    const started = manager.start({
      command: 'run-training',
      target: {
        kind: 'ssh',
        host: 'example.test',
        username: 'runner',
        allowUnverifiedHostKey: true,
      },
    });
    const completed = await manager.waitForTerminal(started.id, 5_000, 20);

    expect(completed.job.state).toBe('succeeded');
    expect(completed.job.tail.map((chunk) => chunk.data).join('')).toContain(
      'retrying in 250 ms'
    );
  });

  test('never retries after SSH is ready and exec may have reached the host', async () => {
    let clientsCreated = 0;
    let execCalls = 0;
    const manager = new LifecycleManager({
      statePath,
      sshRetryBaseDelayMs: 1,
      sshClientFactory: () => {
        clientsCreated += 1;
        return createFakeSshClient(
          (client) => setImmediate(() => client.emit('ready')),
          (_client, _command, callback) => {
            execCalls += 1;
            callback(new Error('exec response lost'));
          }
        );
      },
    });
    const started = manager.start({
      command: 'run-training',
      target: {
        kind: 'ssh',
        host: 'example.test',
        username: 'runner',
        allowUnverifiedHostKey: true,
      },
    });

    const completed = await manager.waitForTerminal(started.id, 5_000);

    expect(completed.job.state).toBe('failed');
    expect(completed.job.error).toContain('exec response lost');
    expect(clientsCreated).toBe(1);
    expect(execCalls).toBe(1);
  });
});

describe('lifecycle safety and UI helpers', () => {
  test('orders cachebuster builds monotonically for daemon upgrades', () => {
    expect(
      compareBuildVersions(
        '1.0.0+codex.20260805120000',
        '1.0.0+codex.20260805115959'
      )
    ).toBeGreaterThan(0);
    expect(
      compareBuildVersions(
        '1.0.0+codex.20260805115959',
        '1.0.0+codex.20260805120000'
      )
    ).toBeLessThan(0);
    expect(compareBuildVersions('1.0.0', '1.0.0')).toBe(0);
  });

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
    const scriptStartMarker = '<script>';
    const scriptEndMarker = '</script>';
    const scriptStart = html.indexOf(scriptStartMarker);
    const scriptEnd = html.lastIndexOf(scriptEndMarker);
    const script =
      scriptStart >= 0 && scriptEnd > scriptStart
        ? html.slice(scriptStart + scriptStartMarker.length, scriptEnd)
        : undefined;
    expect(script).toBeDefined();
    expect(() => new Script(script)).not.toThrow();
    expect(html).toContain("request('ui/initialize'");
    expect(html).toContain("request('tools/call'");
    expect(html).toContain("callTool('job_snapshot'");
    expect(html).toContain('jobId:requestedJobId, tailLines:6');
    expect(html).not.toContain("callTool('job_list'");
    expect(html).toContain('focusedJobId');
    expect(html).toContain('document.hidden');
    expect(html).toContain('renderedSignature');
    expect(html).toContain('scheduleRefresh(0)');
    expect(html).not.toContain('setInterval(refresh');
    expect(html).toContain('no model polling');
    expect(html).toContain('data?.job');
    expect(html).toContain('job.progress.phase');
    expect(html).toContain("job.metadata?.kind === 'github_publish'");
    expect(html).toContain("callTool('job_start'");
    expect(html).toContain('useDefaultCredential:true');
    expect(html).toContain('requestTraceId:launcherAttempt.requestTraceId');
    expect(html).toContain('Direct default SSH start');
    expect(html).toContain("['prompt→tool'");
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

  test('plugin prompt hook selects RunBeacon only for remote execution intent', () => {
    const hook = join(process.cwd(), 'hooks', 'route-remote-prompt.cjs');
    const remote = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: '请登录远程服务器并运行训练脚本，然后等待完成',
      }),
      encoding: 'utf8',
    });
    const decision = JSON.parse(remote.stdout);
    expect(decision.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(decision.hookSpecificOutput.additionalContext).toMatch(
      /RunBeacon job_start MCP tool first/
    );

    const conceptual = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: '请解释 SSH 密钥认证的原理',
      }),
      encoding: 'utf8',
    });
    expect(conceptual.stdout).toBe('');
  });

  test('plugin prompt hook recognizes Chinese execution intent without matching explanations', () => {
    const hook = join(process.cwd(), 'hooks', 'route-remote-prompt.cjs');
    const remote = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: '请登录远程服务器并运行训练脚本，然后等待完成',
      }),
      encoding: 'utf8',
    });
    const decision = JSON.parse(remote.stdout);
    expect(decision.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');

    const conceptual = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: '请解释 SSH 密钥认证的原理',
      }),
      encoding: 'utf8',
    });
    expect(conceptual.stdout).toBe('');
  });

  test('plugin prompt hook selects the zero-exploration default SSH fast path', () => {
    const hook = join(process.cwd(), 'hooks', 'route-remote-prompt.cjs');
    const fastPath = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: '使用默认 SSH 服务器运行下面的训练命令并等待完成',
      }),
      encoding: 'utf8',
    });
    const decision = JSON.parse(fastPath.stdout);
    expect(decision.hookSpecificOutput.additionalContext).toMatch(
      /make job_start the first task action/
    );
    expect(decision.hookSpecificOutput.additionalContext).toMatch(
      /useDefaultCredential=true/
    );
    expect(decision.hookSpecificOutput.additionalContext).toMatch(
      /Do not inspect the working directory, README, tests/
    );
    expect(decision.hookSpecificOutput.additionalContext).toMatch(
      /attaches the prompt trace to job_start automatically/
    );
    expect(decision.hookSpecificOutput.additionalContext).not.toMatch(
      /requestTraceId="/
    );
    expect(decision.hookSpecificOutput.additionalContext).toMatch(
      /Never issue a second job_start/
    );
  });
});
