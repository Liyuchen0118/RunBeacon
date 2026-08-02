import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  });

  test('dashboard uses the MCP Apps bridge and direct tool calls', () => {
    const html = createDashboardHtml();
    expect(html).toContain("request('ui/initialize'");
    expect(html).toContain("request('tools/call'");
    expect(html).toContain("callTool('job_list'");
    expect(html).toContain('no model polling');
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
