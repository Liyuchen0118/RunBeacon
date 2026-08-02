import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { JobStore } from './JobStore.js';
import { redactCommand, safeErrorMessage } from './security.js';
import {
  isTerminalJobState,
  JobOutputChunk,
  JobRecord,
  JobSnapshot,
  JobState,
  PublicJobTarget,
  StartJobInput,
  WaitResult,
} from './types.js';

interface LifecycleManagerOptions {
  statePath: string;
  maxConcurrentJobs?: number;
  maxOutputBytes?: number;
  persistOutput?: boolean;
  stalledAfterMs?: number;
}

interface ExecutionResult {
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
}

interface RuntimeHandle {
  cancel: () => void;
}

const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

export class LifecycleManager extends EventEmitter {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly pendingInputs = new Map<string, StartJobInput>();
  private readonly queue: string[] = [];
  private readonly activeJobs = new Set<string>();
  private readonly runtimeHandles = new Map<string, RuntimeHandle>();
  private readonly store: JobStore;
  private readonly maxConcurrentJobs: number;
  private readonly maxOutputBytes: number;
  private readonly stalledAfterMs: number;
  private sequence = 0;
  private drainScheduled = false;

  constructor(options: LifecycleManagerOptions) {
    super();
    this.maxConcurrentJobs = Math.max(1, options.maxConcurrentJobs ?? 4);
    this.maxOutputBytes = Math.max(64 * 1024, options.maxOutputBytes ?? 1024 * 1024);
    this.stalledAfterMs = Math.max(10_000, options.stalledAfterMs ?? 120_000);
    this.store = new JobStore(options.statePath, options.persistOutput ?? false);

    for (const loaded of this.store.load()) {
      if (loaded.state === 'running' || loaded.state === 'queued') {
        loaded.state = 'orphaned';
        loaded.error =
          'The prior MCP runtime ended before this job reached a terminal state.';
        loaded.finishedAt = new Date().toISOString();
        loaded.updatedAt = loaded.finishedAt;
        loaded.version += 1;
      }
      this.jobs.set(loaded.id, loaded);
      for (const chunk of loaded.output) {
        this.sequence = Math.max(this.sequence, chunk.sequence);
      }
    }
    this.persist();
  }

  start(input: StartJobInput): JobSnapshot {
    if (!input.command?.trim()) throw new Error('command is required');
    if (input.timeoutMs !== undefined && input.timeoutMs <= 0) {
      throw new Error('timeoutMs must be greater than zero');
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const target = this.publicTarget(input);
    const record: JobRecord = {
      id,
      label: input.label?.trim() || redactCommand(input.command).slice(0, 120),
      displayCommand: redactCommand(input.command),
      target,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      version: 1,
      output: [],
      outputBytes: 0,
      outputLines: 0,
      outputTruncated: false,
      metadata: input.metadata,
    };

    this.jobs.set(id, record);
    this.pendingInputs.set(id, input);
    this.queue.push(id);
    this.touch(record, 'Job queued.', 'system');
    this.scheduleDrain();
    return this.snapshot(id);
  }

  list(tailLines = 8): JobSnapshot[] {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((job) => this.snapshot(job.id, tailLines));
  }

  snapshot(jobId: string, tailLines = 80): JobSnapshot {
    const job = this.requireJob(jobId);
    const safeTailLines = Math.max(0, Math.min(500, tailLines));
    const tail = safeTailLines === 0 ? [] : job.output.slice(-safeTailLines);
    const { output: _output, ...summary } = job;
    return { ...summary, tail, assessment: this.assess(job) };
  }

  async waitForTerminal(
    jobId: string,
    timeoutMs = MAX_WAIT_MS,
    tailLines = 120
  ): Promise<WaitResult> {
    const current = this.requireJob(jobId);
    if (isTerminalJobState(current.state)) {
      return { timedOut: false, job: this.snapshot(jobId, tailLines) };
    }

    const boundedTimeout = Math.max(1, Math.min(timeoutMs, MAX_WAIT_MS));
    return new Promise<WaitResult>((resolve) => {
      let settled = false;
      const finish = (timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('jobChanged', listener);
        resolve({ timedOut, job: this.snapshot(jobId, tailLines) });
      };
      const listener = (changed: JobRecord) => {
        if (changed.id === jobId && isTerminalJobState(changed.state)) {
          finish(false);
        }
      };
      const timer = setTimeout(() => finish(true), boundedTimeout);
      timer.unref?.();
      this.on('jobChanged', listener);
    });
  }

  cancel(jobId: string): JobSnapshot {
    const job = this.requireJob(jobId);
    if (isTerminalJobState(job.state)) return this.snapshot(jobId);

    job.cancelRequested = true;
    this.touch(job, 'Cancellation requested.', 'system');

    if (job.state === 'queued') {
      const index = this.queue.indexOf(jobId);
      if (index >= 0) this.queue.splice(index, 1);
      this.pendingInputs.delete(jobId);
      this.finish(job, 'cancelled');
    } else {
      this.runtimeHandles.get(jobId)?.cancel();
    }
    return this.snapshot(jobId);
  }

  private publicTarget(input: StartJobInput): PublicJobTarget {
    const target = input.target ?? { kind: 'local' as const };
    if (target.kind === 'local') return { kind: 'local' };
    if (!target.host?.trim() || !target.username?.trim()) {
      throw new Error('SSH target requires host and username');
    }
    if (!target.hostKeySha256 && !target.allowUnverifiedHostKey) {
      throw new Error(
        'SSH target requires hostKeySha256, or allowUnverifiedHostKey=true for an explicit insecure override'
      );
    }
    return {
      kind: 'ssh',
      host: target.host,
      port: target.port ?? 22,
      username: target.username,
      verifiedHostKey: Boolean(target.hostKeySha256),
    };
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    while (
      this.activeJobs.size < this.maxConcurrentJobs &&
      this.queue.length > 0
    ) {
      const jobId = this.queue.shift()!;
      const job = this.jobs.get(jobId);
      const input = this.pendingInputs.get(jobId);
      if (!job || !input || job.cancelRequested) continue;
      this.activeJobs.add(jobId);
      this.pendingInputs.delete(jobId);
      void this.run(job, input).finally(() => {
        this.activeJobs.delete(jobId);
        this.runtimeHandles.delete(jobId);
        this.scheduleDrain();
      });
    }
  }

  private async run(job: JobRecord, input: StartJobInput): Promise<void> {
    job.state = 'running';
    job.startedAt = new Date().toISOString();
    this.touch(job, 'Job started.', 'system');

    try {
      const result =
        (input.target?.kind ?? 'local') === 'ssh'
          ? await this.runSsh(job, input)
          : await this.runLocal(job, input);

      job.exitCode = result.exitCode;
      job.signal = result.signal;
      if (job.cancelRequested) this.finish(job, 'cancelled');
      else if (result.timedOut) this.finish(job, 'timed_out', 'Job timed out.');
      else if (result.exitCode === 0) this.finish(job, 'succeeded');
      else this.finish(job, 'failed', `Process exited with code ${result.exitCode}.`);
    } catch (error) {
      if (job.cancelRequested) this.finish(job, 'cancelled');
      else this.finish(job, 'failed', safeErrorMessage(error));
    }
  }

  private runLocal(job: JobRecord, input: StartJobInput): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let child: ChildProcess;
      const settle = (result?: ExecutionResult, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(result!);
      };

      try {
        child = spawn(input.command, input.args ?? [], {
          cwd: input.cwd,
          env: { ...process.env, ...input.env },
          shell: input.shell ?? true,
          windowsHide: true,
        });
      } catch (error) {
        reject(error);
        return;
      }

      job.pid = child.pid;
      this.changed(job);
      child.stdout?.on('data', (data) => this.append(job, 'stdout', String(data), input));
      child.stderr?.on('data', (data) => this.append(job, 'stderr', String(data), input));
      child.once('error', (error) => settle(undefined, error));
      child.once('close', (code, signal) =>
        settle({ exitCode: code, signal, timedOut })
      );

      this.runtimeHandles.set(job.id, {
        cancel: () => child.kill(),
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timeout.unref?.();
    });
  }

  private runSsh(job: JobRecord, input: StartJobInput): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      const target = input.target;
      if (!target || target.kind !== 'ssh') {
        reject(new Error('SSH target is missing'));
        return;
      }

      let settled = false;
      let timedOut = false;
      let channel: ClientChannel | undefined;
      const client = new Client();
      const settle = (result?: ExecutionResult, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.end();
        if (error) reject(error);
        else resolve(result!);
      };

      const config: ConnectConfig = {
        host: target.host,
        port: target.port ?? 22,
        username: target.username,
        password: target.password,
        passphrase: target.passphrase,
        agent: target.agent,
        readyTimeout: Math.min(input.timeoutMs ?? 30_000, 30_000),
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
      };
      if (target.privateKeyPath) {
        config.privateKey = readFileSync(target.privateKeyPath);
      }
      if (target.hostKeySha256) {
        const expected = target.hostKeySha256.replace(/^SHA256:/i, '').trim();
        config.hostVerifier = (key: Buffer) =>
          createHash('sha256').update(key).digest('base64') === expected;
      } else {
        config.hostVerifier = () => Boolean(target.allowUnverifiedHostKey);
      }

      client.once('ready', () => {
        client.exec(input.command, (error, stream) => {
          if (error) {
            settle(undefined, error);
            return;
          }
          channel = stream;
          stream.on('data', (data: Buffer) =>
            this.append(job, 'stdout', data.toString('utf8'), input)
          );
          stream.stderr.on('data', (data: Buffer) =>
            this.append(job, 'stderr', data.toString('utf8'), input)
          );
          stream.once('close', (code: number | null, signal?: string) =>
            settle({ exitCode: code, signal, timedOut })
          );
        });
      });
      client.once('error', (error) => settle(undefined, error));

      this.runtimeHandles.set(job.id, {
        cancel: () => {
          channel?.close();
          client.end();
        },
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        channel?.close();
        client.end();
        settle({ exitCode: null, signal: 'timeout', timedOut: true });
      }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timeout.unref?.();
      client.connect(config);
    });
  }

  private append(
    job: JobRecord,
    stream: 'stdout' | 'stderr' | 'system',
    data: string,
    input?: StartJobInput
  ): void {
    if (!data) return;
    const chunk: JobOutputChunk = {
      sequence: ++this.sequence,
      stream,
      data,
      timestamp: new Date().toISOString(),
    };
    job.output.push(chunk);
    job.outputBytes += Buffer.byteLength(data);
    job.outputLines += Math.max(1, data.split(/\r?\n/).length - 1);
    if (stream !== 'system') job.lastOutputAt = chunk.timestamp;

    while (job.outputBytes > this.maxOutputBytes && job.output.length > 1) {
      const removed = job.output.shift()!;
      job.outputBytes -= Buffer.byteLength(removed.data);
      job.outputTruncated = true;
    }

    if (input && stream !== 'system') this.updateProgress(job, data, input);
    this.changed(job);
  }

  private updateProgress(job: JobRecord, data: string, input: StartJobInput): void {
    let percentage: number | undefined;
    let message: string | undefined;
    try {
      if (input.progressPattern) {
        const match = new RegExp(input.progressPattern, 'm').exec(data);
        if (match) {
          const parsed = Number(match[1] ?? match[0]);
          if (Number.isFinite(parsed)) percentage = parsed;
          message = match[0].slice(0, 240);
        }
      } else {
        const match = /(?:^|\s)(\d{1,3}(?:\.\d+)?)\s*%/.exec(data);
        if (match) {
          percentage = Number(match[1]);
          message = match[0].trim();
        }
      }
    } catch {
      // A malformed optional progress pattern must not interrupt the job.
    }
    if (percentage === undefined) return;
    job.progress = {
      percentage: Math.max(0, Math.min(100, percentage)),
      message,
      updatedAt: new Date().toISOString(),
    };
    job.lastProgressAt = job.progress.updatedAt;
  }

  private touch(job: JobRecord, message: string, stream: 'system'): void {
    this.append(job, stream, message, undefined);
  }

  private finish(job: JobRecord, state: JobState, error?: string): void {
    if (isTerminalJobState(job.state)) return;
    job.state = state;
    job.error = error;
    job.finishedAt = new Date().toISOString();
    const terminalMessage =
      state === 'succeeded'
        ? 'Job completed successfully.'
        : state === 'cancelled'
          ? 'Job cancelled.'
          : error || `Job finished with state ${state}.`;
    this.touch(job, terminalMessage, 'system');
  }

  private changed(job: JobRecord): void {
    job.version += 1;
    job.updatedAt = new Date().toISOString();
    this.persist();
    this.emit('jobChanged', job);
  }

  private persist(): void {
    this.store.save(Array.from(this.jobs.values()));
  }

  private assess(job: JobRecord) {
    const now = Date.now();
    const started = job.startedAt ? Date.parse(job.startedAt) : Date.parse(job.createdAt);
    const finished = job.finishedAt ? Date.parse(job.finishedAt) : now;
    const lastActivity = Date.parse(
      job.lastOutputAt || job.lastProgressAt || job.startedAt || job.createdAt
    );
    const elapsedMs = Math.max(0, finished - started);
    const idleMs = isTerminalJobState(job.state)
      ? Math.max(0, finished - lastActivity)
      : Math.max(0, now - lastActivity);

    if (isTerminalJobState(job.state)) {
      return {
        phase: 'finished' as const,
        health: 'terminal' as const,
        elapsedMs,
        idleMs,
        summary: `Finished with state ${job.state}.`,
      };
    }
    if (job.state === 'queued') {
      return {
        phase: 'waiting' as const,
        health: 'queued' as const,
        elapsedMs: 0,
        idleMs,
        summary: 'Waiting for an execution slot.',
      };
    }

    const percentage = job.progress?.percentage;
    const estimatedRemainingMs =
      percentage !== undefined && percentage > 0 && percentage < 100
        ? Math.max(0, Math.round((elapsedMs * (100 - percentage)) / percentage))
        : undefined;
    const stalled = idleMs >= this.stalledAfterMs;
    return {
      phase: 'executing' as const,
      health: stalled ? ('stalled' as const) : ('active' as const),
      elapsedMs,
      idleMs,
      estimatedRemainingMs,
      summary: stalled
        ? `No output or progress for ${Math.round(idleMs / 1000)} seconds.`
        : percentage === undefined
          ? 'Running; no structured progress percentage has been observed.'
          : `Running at ${percentage}% progress.`,
    };
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    return job;
  }
}
