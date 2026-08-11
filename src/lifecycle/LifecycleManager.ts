import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  Client,
  ClientChannel,
  ConnectConfig,
  ServerHostKeyAlgorithm,
} from 'ssh2';
import { RE2JS } from 're2js';
import { JobStore } from './JobStore.js';
import { AuditLog, AuditQuery } from './AuditLog.js';
import { PolicyConfig, PolicyEngine, PolicyUpdate } from './PolicyEngine.js';
import { commandForAdapter, validateAdapterInput } from './Adapters.js';
import {
  EventSubscriptionStore,
  SaveEventSubscription,
} from './EventSubscriptionStore.js';
import {
  RunnerRPCClient,
  RunnerTransportError,
  SshRunnerTransport,
} from './RunnerTransport.js';
import { redactCommand, safeErrorMessage } from './security.js';
import {
  ApprovalContext,
  isTerminalJobState,
  JobOutputChunk,
  JobRecord,
  JobSnapshot,
  JobState,
  PublicJobTarget,
  SshJobTarget,
  StartJobInput,
  WaitResult,
  WatchResult,
} from './types.js';

interface LifecycleManagerOptions {
  statePath: string;
  maxConcurrentJobs?: number;
  maxOutputBytes?: number;
  persistOutput?: boolean;
  persistMetadata?: boolean;
  stalledAfterMs?: number;
  persistenceDebounceMs?: number;
  maxRetainedJobs?: number;
  cancellationGraceMs?: number;
  sshClientFactory?: () => Client;
  sshHandshakeAttempts?: number;
  sshRetryBaseDelayMs?: number;
  sshReadyTimeoutMs?: number;
  runnerTransportFactory?: (target: SshJobTarget) => RunnerRPCClient;
  recoverRunnerTarget?: (profileId: string) => Promise<SshJobTarget>;
  policyPath?: string;
  auditPath?: string;
  eventSubscriptionPath?: string;
}

interface ExecutionResult {
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  terminalState?: JobState;
  cancellationVerified?: boolean;
}

interface RunnerJobPayload {
  id: string;
  state: JobState;
  exitCode?: number | null;
  signal?: string;
  error?: string;
  cancellationVerified?: boolean;
  lastEventSequence?: number;
}

interface RunnerEventPayload {
  sequence: number;
  timestamp?: string;
  type: string;
  state?: JobState;
  stream?: 'stdout' | 'stderr';
  data?: string;
}

interface RuntimeHandle {
  cancel: () => void;
  cancellationVerified: boolean;
}

interface Waiter {
  id: number;
  tailLines: number;
  expiresAt: number;
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve: (result: WaitResult) => void;
  reject: (error: Error) => void;
}

interface WaitCoordinator {
  jobId: string;
  waiters: Map<number, Waiter>;
  timer?: NodeJS.Timeout;
}

interface ChangeWaiter {
  id: number;
  afterVersion: number;
  tailLines: number;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve: (result: WatchResult) => void;
  reject: (error: Error) => void;
}

const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
const MAX_PROGRESS_PATTERN_LENGTH = 256;
const MAX_PROGRESS_LINE_LENGTH = 16 * 1024;
const MAX_WAITERS_PER_JOB = 8;
const MAX_WAITERS_GLOBAL = 128;
const DEFAULT_SSH_HANDSHAKE_ATTEMPTS = 5;
const DEFAULT_SSH_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_SSH_READY_TIMEOUT_MS = 12_000;
const SSH_CLIENT_CLEANUP_TIMEOUT_MS = 250;
const SSH_SERVER_HOST_KEY_ALGORITHMS: ServerHostKeyAlgorithm[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
];

function normalizeSshSha256Fingerprint(value: string): string {
  return value
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
}

function hostKeyAlgorithmsForRawKey(key: Buffer): ServerHostKeyAlgorithm[] {
  if (key.length < 4) return [];
  const typeLength = key.readUInt32BE(0);
  if (typeLength < 1 || typeLength > key.length - 4) return [];

  const keyType = key.subarray(4, 4 + typeLength).toString('ascii');
  if (keyType === 'ssh-rsa') {
    return ['rsa-sha2-512', 'rsa-sha2-256'];
  }
  if (
    keyType === 'ssh-ed25519' ||
    keyType === 'ecdsa-sha2-nistp256' ||
    keyType === 'ecdsa-sha2-nistp384' ||
    keyType === 'ecdsa-sha2-nistp521'
  ) {
    return [keyType];
  }
  return [];
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value!)));
}

export class LifecycleManager extends EventEmitter {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly pendingInputs = new Map<string, StartJobInput>();
  private readonly queue: string[] = [];
  private readonly activeJobs = new Set<string>();
  private readonly approvalContexts = new Map<string, ApprovalContext>();
  private readonly runtimeHandles = new Map<string, RuntimeHandle>();
  private readonly store: JobStore;
  private readonly policyEngine: PolicyEngine;
  private readonly auditLog: AuditLog;
  private readonly eventSubscriptions: EventSubscriptionStore;
  private readonly maxConcurrentJobs: number;
  private readonly maxOutputBytes: number;
  private readonly stalledAfterMs: number;
  private readonly persistenceDebounceMs: number;
  private readonly maxRetainedJobs: number;
  private readonly cancellationGraceMs: number;
  private readonly sshClientFactory: () => Client;
  private readonly sshHandshakeAttempts: number;
  private readonly sshRetryBaseDelayMs: number;
  private readonly sshReadyTimeoutMs: number;
  private readonly runnerTransportFactory: (
    target: SshJobTarget
  ) => RunnerRPCClient;
  private readonly recoverRunnerTarget?: (
    profileId: string
  ) => Promise<SshJobTarget>;
  private readonly progressRemainders = new Map<string, string>();
  private readonly progressPatterns = new Map<string, RE2JS>();
  private readonly waitCoordinators = new Map<string, WaitCoordinator>();
  private readonly changeWaiters = new Map<string, Map<number, ChangeWaiter>>();
  private persistenceTimer?: NodeJS.Timeout;
  private lastPersistenceError?: string;
  private lastPersistenceSuccessAt?: string;
  private sequence = 0;
  private waiterSequence = 0;
  private totalWaiters = 0;
  private drainScheduled = false;
  private disposed = false;

  constructor(options: LifecycleManagerOptions) {
    super();
    this.maxConcurrentJobs = Math.max(1, options.maxConcurrentJobs ?? 4);
    this.maxOutputBytes = Math.max(
      64 * 1024,
      options.maxOutputBytes ?? 1024 * 1024
    );
    this.stalledAfterMs = Math.max(10_000, options.stalledAfterMs ?? 120_000);
    this.persistenceDebounceMs = Math.max(
      25,
      options.persistenceDebounceMs ?? 250
    );
    this.maxRetainedJobs = Math.max(1, options.maxRetainedJobs ?? 1_000);
    this.cancellationGraceMs = Math.max(
      250,
      options.cancellationGraceMs ?? 5_000
    );
    this.sshClientFactory = options.sshClientFactory ?? (() => new Client());
    this.sshHandshakeAttempts = boundedInteger(
      options.sshHandshakeAttempts,
      DEFAULT_SSH_HANDSHAKE_ATTEMPTS,
      1,
      5
    );
    this.sshRetryBaseDelayMs = boundedInteger(
      options.sshRetryBaseDelayMs,
      DEFAULT_SSH_RETRY_BASE_DELAY_MS,
      0,
      30_000
    );
    this.sshReadyTimeoutMs = boundedInteger(
      options.sshReadyTimeoutMs,
      DEFAULT_SSH_READY_TIMEOUT_MS,
      1_000,
      30_000
    );
    this.runnerTransportFactory =
      options.runnerTransportFactory ??
      ((target) => new SshRunnerTransport(target, this.sshClientFactory));
    this.recoverRunnerTarget = options.recoverRunnerTarget;
    this.store = new JobStore(
      options.statePath,
      options.persistOutput ?? false,
      options.persistMetadata ?? false
    );
    this.policyEngine = new PolicyEngine(
      options.policyPath ?? join(dirname(options.statePath), 'policies.json')
    );
    this.auditLog = new AuditLog(
      options.auditPath ?? join(dirname(options.statePath), 'audit.jsonl')
    );
    this.eventSubscriptions = new EventSubscriptionStore(
      options.eventSubscriptionPath ??
        join(dirname(options.statePath), 'event-subscriptions.json')
    );
    this.setMaxListeners(Math.max(20, this.maxConcurrentJobs * 10));

    const recoverableJobs: JobRecord[] = [];
    for (const loaded of this.store.load()) {
      if (loaded.state === 'running' || loaded.state === 'queued') {
        if (
          loaded.execution.backend === 'ssh_runner' &&
          loaded.execution.durable &&
          loaded.execution.remoteJobId &&
          loaded.credentialProfileId &&
          this.recoverRunnerTarget
        ) {
          loaded.state = 'running';
          loaded.execution.phase = 'reconnecting';
          loaded.execution.connectionState = 'reconnecting';
          loaded.execution.resumable = true;
          loaded.execution.reconnectCount += 1;
          loaded.version += 1;
          loaded.updatedAt = new Date().toISOString();
          recoverableJobs.push(loaded);
        } else {
          loaded.state = 'lost';
          loaded.execution.phase = 'finished';
          loaded.execution.connectionState = 'disconnected';
          loaded.error =
            'The prior coordinator ended and this execution backend cannot be reattached.';
          loaded.finishedAt = new Date().toISOString();
          loaded.updatedAt = loaded.finishedAt;
          loaded.version += 1;
        }
      }
      this.jobs.set(loaded.id, loaded);
      if (loaded.progressPattern) {
        try {
          this.progressPatterns.set(
            loaded.id,
            this.compileProgressPattern(loaded.progressPattern)
          );
        } catch {
          loaded.progressPattern = undefined;
        }
      }
      for (const chunk of loaded.output) {
        this.sequence = Math.max(this.sequence, chunk.sequence);
      }
    }
    this.persistNow();
    for (const job of recoverableJobs) {
      setImmediate(() => void this.recoverRunnerJob(job));
    }
  }

  start(input: StartJobInput): JobSnapshot {
    this.assertNotDisposed();
    if (!input.command?.trim()) throw new Error('command is required');
    validateAdapterInput(input);
    if (input.timeoutMs !== undefined && input.timeoutMs <= 0) {
      throw new Error('timeoutMs must be greater than zero');
    }
    if (
      input.credentialProfileId !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.credentialProfileId)
    ) {
      throw new Error('credentialProfileId is invalid');
    }
    if (input.requireDurable && input.executionMode === 'direct') {
      throw new Error('DURABILITY_REQUIRED: direct execution is not durable');
    }
    if (
      input.adapter === 'apple-signing' &&
      (input.target?.kind !== 'ssh' || input.executionMode === 'direct')
    ) {
      throw new Error(
        'DURABILITY_REQUIRED: apple-signing requires a macOS LaunchAgent Runner'
      );
    }
    if (
      input.adapter === 'slurm' &&
      (input.target?.kind !== 'ssh' || input.executionMode === 'direct')
    ) {
      throw new Error(
        'DURABILITY_REQUIRED: slurm requires the durable Runner for verified scancel handling'
      );
    }
    if (input.timing?.requestTraceId) {
      const existing = Array.from(this.jobs.values()).find(
        (job) => job.timing?.requestTraceId === input.timing?.requestTraceId
      );
      if (existing) return this.snapshot(existing.id);
    }
    const target = this.publicTarget(input);
    const commandDigest = `sha256:${createHash('sha256')
      .update(
        JSON.stringify({
          command: input.command,
          args: input.args ?? [],
          cwd: input.cwd ?? null,
          target,
        })
      )
      .digest('hex')}`;
    if (input.idempotencyKey !== undefined) {
      const key = input.idempotencyKey.trim();
      if (!key || key.length > 200) {
        throw new Error('idempotencyKey must contain 1 to 200 characters');
      }
      const existing = Array.from(this.jobs.values()).find(
        (job) => job.idempotencyKey === key
      );
      if (existing) {
        if (existing.commandDigest !== commandDigest) {
          throw new Error(
            'IDEMPOTENCY_CONFLICT: idempotency key is already bound to a different execution digest'
          );
        }
        return this.snapshot(existing.id);
      }
      input = { ...input, idempotencyKey: key };
    }
    const progressPattern =
      input.progressPattern !== undefined
        ? this.compileProgressPattern(input.progressPattern)
        : undefined;

    const id = randomUUID();
    const now = new Date().toISOString();
    const policyDecision = this.policyEngine.classify(
      [input.command, ...(input.args ?? [])].join(' '),
      input.adapter ?? 'generic'
    );
    const runnerRequested =
      target.kind === 'ssh' && (input.executionMode ?? 'auto') !== 'direct';
    const eventSubscriptions = this.eventSubscriptions.validateIds(
      input.eventSubscriptions
    );
    const record: JobRecord = {
      id,
      idempotencyKey: input.idempotencyKey,
      commandDigest,
      label: redactCommand(
        input.label?.trim() || redactCommand(input.command)
      ).slice(0, 120),
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
      timing: input.timing,
      execution: {
        backend: runnerRequested
          ? 'ssh_runner'
          : target.kind === 'ssh'
            ? 'ssh_direct'
            : 'local',
        phase: policyDecision.requiresApproval ? 'awaiting_approval' : 'queued',
        connectionState:
          target.kind === 'ssh' ? 'disconnected' : 'not_applicable',
        durable: runnerRequested,
        resumable: runnerRequested && Boolean(input.credentialProfileId),
        reconnectCount: 0,
        lastEventSequence: 0,
      },
      policy: {
        risk: policyDecision.risk,
        approval: policyDecision.requiresApproval ? 'pending' : 'not_required',
      },
      adapter: input.adapter ?? 'generic',
      outputPolicy: this.normalizeOutputPolicy(input),
      eventSubscriptions:
        eventSubscriptions.length > 0 ? eventSubscriptions : undefined,
      credentialProfileId: input.credentialProfileId,
      progressPattern: input.progressPattern,
    };

    this.jobs.set(id, record);
    if (policyDecision.requiresApproval) {
      this.approvalContexts.set(id, {
        jobId: id,
        commandDigest,
        target: { ...target },
        credentialProfileId: input.credentialProfileId,
        risk: policyDecision.risk,
      });
    }
    if (progressPattern) this.progressPatterns.set(id, progressPattern);
    this.pendingInputs.set(id, input);
    this.auditLog.append({
      action: 'job_start',
      outcome: policyDecision.requiresApproval ? 'awaiting_approval' : 'queued',
      jobId: id,
      target: this.auditTarget(target),
      risk: policyDecision.risk,
      commandDigest,
    });
    if (policyDecision.requiresApproval) {
      this.touch(
        record,
        `Approval required: ${policyDecision.reason}.`,
        'system',
        'immediate'
      );
    } else {
      this.queue.push(id);
      this.touch(record, 'Job queued.', 'system', 'immediate');
      this.scheduleDrain();
    }
    return this.snapshot(id);
  }

  approve(jobId: string): JobSnapshot {
    this.assertNotDisposed();
    const job = this.requireJob(jobId);
    if (
      job.execution.phase !== 'awaiting_approval' ||
      job.policy.approval !== 'pending'
    ) {
      throw new Error('APPROVAL_REQUIRED: job is not awaiting approval');
    }
    if (!this.pendingInputs.has(jobId)) {
      throw new Error('REMOTE_STATE_LOST: pending command is unavailable');
    }
    const approvalContext = this.approvalContext(jobId);
    const now = new Date();
    job.policy.approval = 'approved';
    job.policy.approvedAt = now.toISOString();
    job.policy.grantExpiresAt = new Date(
      now.getTime() + this.policyEngine.get().approvalTtlSeconds * 1_000
    ).toISOString();
    job.execution.phase = 'queued';
    this.queue.push(jobId);
    this.auditLog.append({
      action: 'approval',
      outcome: 'approved',
      jobId,
      target: this.auditTarget(job.target),
      risk: job.policy.risk,
      commandDigest: approvalContext.commandDigest,
    });
    this.approvalContexts.delete(jobId);
    this.touch(job, 'Approval granted.', 'system', 'immediate');
    this.scheduleDrain();
    return this.snapshot(jobId);
  }

  rejectApproval(jobId: string): JobSnapshot {
    this.assertNotDisposed();
    const job = this.requireJob(jobId);
    if (
      job.execution.phase !== 'awaiting_approval' ||
      job.policy.approval !== 'pending'
    ) {
      throw new Error('APPROVAL_REQUIRED: job is not awaiting approval');
    }
    const approvalContext = this.approvalContext(jobId);
    job.policy.approval = 'rejected';
    this.pendingInputs.delete(jobId);
    this.auditLog.append({
      action: 'approval',
      outcome: 'rejected',
      jobId,
      target: this.auditTarget(job.target),
      risk: job.policy.risk,
      commandDigest: approvalContext.commandDigest,
    });
    this.approvalContexts.delete(jobId);
    this.finish(job, 'cancelled', 'Approval was rejected.');
    return this.snapshot(jobId);
  }

  approvalContext(jobId: string): ApprovalContext {
    const job = this.requireJob(jobId);
    if (
      job.execution.phase !== 'awaiting_approval' ||
      job.policy.approval !== 'pending'
    ) {
      throw new Error('APPROVAL_REQUIRED: job is not awaiting approval');
    }
    const context = this.approvalContexts.get(jobId);
    if (!context) {
      throw new Error('REMOTE_STATE_LOST: approval context is unavailable');
    }
    return {
      ...context,
      target: { ...context.target },
    };
  }

  policyConfig(): PolicyConfig {
    return this.policyEngine.get();
  }

  updatePolicy(input: PolicyUpdate): PolicyConfig {
    const config = this.policyEngine.update(input);
    this.auditLog.append({
      action: 'policy_update',
      outcome: 'updated',
    });
    return config;
  }

  queryAudit(query: AuditQuery = {}) {
    return this.auditLog.query(query);
  }

  listEventSubscriptions() {
    return this.eventSubscriptions.list();
  }

  saveEventSubscription(input: SaveEventSubscription) {
    const saved = this.eventSubscriptions.save(input);
    this.auditLog.append({
      action: 'event_subscription',
      outcome: 'saved',
    });
    return saved;
  }

  deleteEventSubscription(id: string) {
    const deleted = this.eventSubscriptions.delete(id);
    this.auditLog.append({
      action: 'event_subscription',
      outcome: 'deleted',
    });
    return deleted;
  }

  list(tailLines = 8, limit = 100): JobSnapshot[] {
    const safeLimit = Math.max(1, Math.min(500, limit));
    return Array.from(this.jobs.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, safeLimit)
      .map((job) => this.snapshot(job.id, tailLines));
  }

  snapshot(jobId: string, tailLines = 80): JobSnapshot {
    const job = this.requireJob(jobId);
    const safeTailLines = Math.max(0, Math.min(500, tailLines));
    const tail = safeTailLines === 0 ? [] : job.output.slice(-safeTailLines);
    const summary = { ...job } as Partial<JobRecord>;
    delete summary.output;
    delete summary.commandDigest;
    return {
      ...(summary as Omit<JobRecord, 'output' | 'commandDigest'>),
      tail,
      assessment: this.assess(job),
    };
  }

  async waitForTerminal(
    jobId: string,
    timeoutMs = MAX_WAIT_MS,
    tailLines = 120,
    signal?: AbortSignal
  ): Promise<WaitResult> {
    this.assertNotDisposed();
    if (signal?.aborted) throw new Error('Job wait was aborted');
    const current = this.requireJob(jobId);
    if (isTerminalJobState(current.state)) {
      return { timedOut: false, job: this.snapshot(jobId, tailLines) };
    }

    const existing = this.waitCoordinators.get(jobId);
    if ((existing?.waiters.size ?? 0) >= MAX_WAITERS_PER_JOB) {
      throw new Error('job_wait limit reached for job');
    }
    if (this.totalWaiters >= MAX_WAITERS_GLOBAL) {
      throw new Error('global job_wait limit reached');
    }

    const boundedTimeout = Math.max(1, Math.min(timeoutMs, MAX_WAIT_MS));
    const coordinator = existing ?? {
      jobId,
      waiters: new Map<number, Waiter>(),
    };
    if (!existing) this.waitCoordinators.set(jobId, coordinator);

    return new Promise<WaitResult>((resolve, reject) => {
      const waiter: Waiter = {
        id: ++this.waiterSequence,
        tailLines,
        expiresAt: Date.now() + boundedTimeout,
        signal,
        resolve,
        reject,
      };
      waiter.abortListener = () => {
        this.rejectWaiter(
          coordinator,
          waiter,
          new Error('Job wait was aborted')
        );
      };
      coordinator.waiters.set(waiter.id, waiter);
      this.totalWaiters += 1;
      signal?.addEventListener('abort', waiter.abortListener, { once: true });
      this.armWaitTimer(coordinator);

      // Recheck after registration so a terminal transition or abort cannot be lost.
      const latest = this.jobs.get(jobId);
      if (!latest) {
        this.rejectWaiter(
          coordinator,
          waiter,
          new Error(`Unknown job: ${jobId}`)
        );
      } else if (isTerminalJobState(latest.state)) {
        this.resolveCoordinator(coordinator, false);
      } else if (signal?.aborted) {
        waiter.abortListener();
      }
    });
  }

  async watchForChange(
    jobId: string,
    afterVersion: number,
    timeoutMs = 25_000,
    tailLines = 20,
    signal?: AbortSignal
  ): Promise<WatchResult> {
    this.assertNotDisposed();
    if (signal?.aborted) throw new Error('Job watch was aborted');
    const current = this.requireJob(jobId);
    if (current.version > afterVersion || isTerminalJobState(current.state)) {
      return { changed: true, job: this.snapshot(jobId, tailLines) };
    }

    const existing = this.changeWaiters.get(jobId);
    if ((existing?.size ?? 0) >= MAX_WAITERS_PER_JOB) {
      throw new Error('job_watch limit reached for job');
    }
    const total = Array.from(this.changeWaiters.values()).reduce(
      (sum, waiters) => sum + waiters.size,
      0
    );
    if (total >= MAX_WAITERS_GLOBAL) {
      throw new Error('global job_watch limit reached');
    }

    const boundedTimeout = normalizeWatchTimeout(timeoutMs);
    const waiters = existing ?? new Map<number, ChangeWaiter>();
    if (!existing) this.changeWaiters.set(jobId, waiters);

    return new Promise<WatchResult>((resolve, reject) => {
      const id = ++this.waiterSequence;
      const waiter = {} as ChangeWaiter;
      const cleanup = () => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', waiter.abortListener!);
        waiters.delete(id);
        if (waiters.size === 0) this.changeWaiters.delete(jobId);
      };
      const finish = (error?: Error, changed = false) => {
        if (!waiters.has(id)) return;
        cleanup();
        if (error) reject(error);
        else resolve({ changed, job: this.snapshot(jobId, tailLines) });
      };
      Object.assign(waiter, {
        id,
        afterVersion,
        tailLines,
        signal,
        resolve,
        reject,
        timer: setTimeout(() => finish(undefined, false), boundedTimeout),
        abortListener: () => finish(new Error('Job watch was aborted')),
      });
      waiter.timer.unref?.();
      waiters.set(id, waiter);
      signal?.addEventListener('abort', waiter.abortListener, { once: true });

      const latest = this.jobs.get(jobId);
      if (!latest) finish(new Error(`Unknown job: ${jobId}`));
      else if (
        latest.version > afterVersion ||
        isTerminalJobState(latest.state)
      ) {
        finish(undefined, true);
      }
    });
  }

  waitCoordinatorStatus() {
    let timers = 0;
    for (const coordinator of this.waitCoordinators.values()) {
      if (coordinator.timer) timers += 1;
    }
    return {
      waiters: this.totalWaiters,
      jobs: this.waitCoordinators.size,
      timers,
    };
  }

  runtimeStatus() {
    return {
      activeJobs: this.activeJobs.size,
      queuedJobs: this.queue.length,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.persistNow();
    this.disposed = true;
    for (const coordinator of Array.from(this.waitCoordinators.values())) {
      this.rejectCoordinator(
        coordinator,
        new Error('LifecycleManager was disposed')
      );
    }
    for (const [jobId, waiters] of this.changeWaiters) {
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener('abort', waiter.abortListener!);
        waiter.reject(new Error('LifecycleManager was disposed'));
      }
      this.changeWaiters.delete(jobId);
    }
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
    this.persistenceTimer = undefined;
    this.progressPatterns.clear();
    this.progressRemainders.clear();
    this.approvalContexts.clear();
    this.removeAllListeners();
  }

  cancel(jobId: string): JobSnapshot {
    const job = this.requireJob(jobId);
    if (isTerminalJobState(job.state)) return this.snapshot(jobId);

    job.cancelRequested = true;
    job.execution.phase = 'cancelling';
    const runtime = this.runtimeHandles.get(jobId);
    job.cancellationVerified = runtime?.cancellationVerified ?? true;
    this.touch(job, 'Cancellation requested.', 'system', 'immediate');

    if (job.state === 'queued') {
      const index = this.queue.indexOf(jobId);
      if (index >= 0) this.queue.splice(index, 1);
      this.pendingInputs.delete(jobId);
      this.finish(job, 'cancelled');
    } else {
      runtime?.cancel();
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
    const normalizedFingerprint = target.hostKeySha256
      ? normalizeSshSha256Fingerprint(target.hostKeySha256)
      : undefined;
    if (
      normalizedFingerprint &&
      !/^[A-Za-z0-9+/]{43}$/.test(normalizedFingerprint)
    ) {
      throw new Error('SSH hostKeySha256 must be a SHA-256 SSH fingerprint');
    }
    return {
      kind: 'ssh',
      host: target.host,
      port: target.port ?? 22,
      username: target.username,
      verifiedHostKey: Boolean(target.hostKeySha256),
      hostKeySha256: normalizedFingerprint
        ? `SHA256:${normalizedFingerprint}`
        : undefined,
      hostKeyAlgorithm: target.hostKeyAlgorithm,
      runnerPath: target.runnerPath,
    };
  }

  private auditTarget(target: PublicJobTarget): string {
    return target.kind === 'ssh'
      ? `${target.username ?? ''}@${target.host ?? ''}:${target.port ?? 22}`
      : 'local';
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
      if (
        job.policy.approval === 'approved' &&
        job.policy.grantExpiresAt &&
        Date.parse(job.policy.grantExpiresAt) <= Date.now()
      ) {
        job.policy.approval = 'expired';
        this.pendingInputs.delete(jobId);
        this.auditLog.append({
          action: 'approval',
          outcome: 'expired',
          jobId,
          target: this.auditTarget(job.target),
          risk: job.policy.risk,
        });
        this.finish(job, 'failed', 'APPROVAL_REQUIRED: approval grant expired');
        continue;
      }
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
    job.execution.phase =
      input.target?.kind === 'ssh' ? 'connecting' : 'executing';
    job.execution.connectionState =
      input.target?.kind === 'ssh' ? 'connecting' : 'not_applicable';
    job.startedAt = new Date().toISOString();
    this.touch(job, 'Job started.', 'system', 'immediate');

    try {
      const result =
        (input.target?.kind ?? 'local') === 'ssh'
          ? await this.runSshJob(job, input)
          : await this.runLocal(job, input);
      this.completeExecution(job, input, result);
    } catch (error) {
      this.flushProgress(job, input);
      if (job.cancelRequested) {
        this.finish(
          job,
          'cancelled',
          job.cancellationVerified === false
            ? 'The SSH channel was closed, but remote process termination could not be verified.'
            : undefined
        );
      } else if (
        error instanceof RunnerTransportError &&
        error.code === 'REMOTE_STATE_LOST'
      ) {
        this.finish(job, 'lost', error.message);
      } else this.finish(job, 'failed', safeErrorMessage(error));
    }
  }

  private completeExecution(
    job: JobRecord,
    input: StartJobInput,
    result: ExecutionResult
  ): void {
    this.flushProgress(job, input);
    job.exitCode = result.exitCode;
    job.signal = result.signal;
    if (typeof result.cancellationVerified === 'boolean') {
      job.cancellationVerified = result.cancellationVerified;
    }
    if (job.cancelRequested) {
      this.finish(
        job,
        'cancelled',
        job.cancellationVerified === false
          ? 'The SSH channel was closed, but remote process termination could not be verified.'
          : undefined
      );
    } else if (result.terminalState === 'lost') {
      this.finish(job, 'lost', 'REMOTE_STATE_LOST');
    } else if (result.timedOut || result.terminalState === 'timed_out') {
      this.finish(job, 'timed_out', 'Job timed out.');
    } else if (result.terminalState === 'cancelled') {
      this.finish(job, 'cancelled');
    } else if (result.exitCode === 0) {
      this.finish(job, 'succeeded');
    } else {
      this.finish(
        job,
        'failed',
        `Process exited with code ${result.exitCode}.`
      );
    }
  }

  private async runSshJob(
    job: JobRecord,
    input: StartJobInput
  ): Promise<ExecutionResult> {
    const mode = input.executionMode ?? 'auto';
    if (mode === 'direct') return this.runSsh(job, input);
    try {
      return await this.runRunner(job, input);
    } catch (error) {
      const runnerUnavailable =
        error instanceof RunnerTransportError &&
        (error.code === 'RUNNER_UNAVAILABLE' ||
          error.code === 'RUNNER_NOT_INSTALLED') &&
        !error.ambiguous;
      if (mode !== 'auto' || input.requireDurable || !runnerUnavailable) {
        throw error;
      }
      job.execution = {
        backend: 'ssh_direct',
        phase: 'connecting',
        connectionState: 'connecting',
        durable: false,
        resumable: false,
        reconnectCount: job.execution.reconnectCount,
        lastEventSequence: 0,
      };
      this.append(
        job,
        'system',
        'Runner unavailable before submission; using non-durable direct SSH.\n',
        input
      );
      return this.runSsh(job, input);
    }
  }

  private async runRunner(
    job: JobRecord,
    input: StartJobInput
  ): Promise<ExecutionResult> {
    const target = input.target;
    if (!target || target.kind !== 'ssh') {
      throw new RunnerTransportError(
        'RUNNER_UNAVAILABLE',
        'Runner execution requires an SSH target'
      );
    }
    const transport = this.runnerTransportFactory(target);
    let ping: { version?: string };
    try {
      ping = await transport.call<{ version?: string }>('ping', {}, 20_000);
    } catch (error) {
      if (error instanceof RunnerTransportError) throw error;
      throw new RunnerTransportError(
        'RUNNER_UNAVAILABLE',
        `RUNNER_UNAVAILABLE: ${safeErrorMessage(error)}`
      );
    }

    job.execution.phase = 'submitting';
    job.execution.connectionState = 'connected';
    job.execution.runnerVersion = ping.version?.slice(0, 64);
    this.changed(job);

    const runnerCommand = commandForAdapter(input);
    const commandDigest = `sha256:${createHash('sha256')
      .update(runnerCommand)
      .digest('hex')}`;
    const submitParams = {
      jobId: job.id,
      idempotencyKey: input.idempotencyKey ?? job.id,
      commandDigest,
      command: runnerCommand,
      cwd: input.cwd,
      env: input.env,
      timeoutMillis: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cancellationMode:
        input.adapter === 'slurm' ? 'external' : 'process_group',
      outputPolicy: job.outputPolicy,
    };
    let submit: { job: RunnerJobPayload; created?: boolean } | undefined;
    let lastSubmitError: unknown;
    for (let attempt = 1; attempt <= this.sshHandshakeAttempts; attempt += 1) {
      try {
        submit = await transport.call<{
          job: RunnerJobPayload;
          created?: boolean;
        }>('submit', submitParams, 35_000);
        break;
      } catch (error) {
        lastSubmitError = error;
        if (
          !(error instanceof RunnerTransportError) ||
          error.code === 'IDEMPOTENCY_CONFLICT'
        ) {
          throw error;
        }
        if (attempt < this.sshHandshakeAttempts) {
          await this.runnerRetryDelay(attempt);
        }
      }
    }
    if (!submit?.job) {
      throw new RunnerTransportError(
        'REMOTE_STATE_LOST',
        `REMOTE_STATE_LOST: Runner submission acknowledgement was not recovered (${safeErrorMessage(
          lastSubmitError
        )})`,
        true
      );
    }

    job.execution.backend = 'ssh_runner';
    job.execution.durable = true;
    job.execution.resumable = Boolean(job.credentialProfileId);
    job.execution.remoteJobId = submit.job.id;
    job.execution.phase = 'executing';
    job.execution.connectionState = 'connected';
    // A retried submit may return a job that already produced output. Always
    // attach from sequence zero so retained events are not skipped after an
    // acknowledgement was lost.
    job.execution.lastEventSequence = 0;
    job.timing = {
      ...job.timing,
      runnerAcceptedAt: new Date().toISOString(),
      sshReadyAt: job.timing?.sshReadyAt ?? new Date().toISOString(),
      commandStartedAt:
        job.timing?.commandStartedAt ?? new Date().toISOString(),
    };
    this.changed(job);

    const deadline =
      Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 60_000;
    return this.watchRunnerJob(job, input, transport, submit.job, deadline);
  }

  private async watchRunnerJob(
    job: JobRecord,
    input: StartJobInput,
    transport: RunnerRPCClient,
    initialRemoteJob: RunnerJobPayload,
    deadline: number
  ): Promise<ExecutionResult> {
    const remoteJobId = initialRemoteJob.id;
    let cancelling = false;
    const runtimeHandle: RuntimeHandle = {
      cancellationVerified: false,
      cancel: () => {
        if (cancelling) return;
        cancelling = true;
        job.execution.phase = 'cancelling';
        this.changed(job);
        void transport
          .call<{ job: RunnerJobPayload }>(
            'cancel',
            { jobId: remoteJobId },
            15_000
          )
          .then((result) => {
            job.cancellationVerified = result.job.cancellationVerified === true;
            this.changed(job);
          })
          .catch((error) => {
            this.append(
              job,
              'system',
              `Runner cancellation could not be verified: ${safeErrorMessage(
                error
              )}\n`,
              input
            );
          });
      },
    };
    this.runtimeHandles.set(job.id, runtimeHandle);
    if (job.cancelRequested) runtimeHandle.cancel();

    let remoteJob = initialRemoteJob;
    while (
      !isTerminalJobState(remoteJob.state) ||
      job.execution.lastEventSequence < Number(remoteJob.lastEventSequence ?? 0)
    ) {
      try {
        const watched = await transport.call<{
          job: RunnerJobPayload;
          events?: RunnerEventPayload[];
          truncated?: boolean;
          nextSequence?: number;
          timedOut?: boolean;
        }>(
          'watch',
          {
            jobId: remoteJobId,
            afterSequence: job.execution.lastEventSequence,
            timeoutMillis: 25_000,
          },
          40_000
        );
        job.execution.connectionState = 'connected';
        job.execution.phase = job.cancelRequested ? 'cancelling' : 'executing';
        if (watched.truncated) {
          job.outputTruncated = true;
          this.append(
            job,
            'system',
            'Runner output retention omitted older events.\n',
            input
          );
        }
        for (const event of watched.events ?? []) {
          if (!Number.isFinite(event.sequence)) continue;
          job.execution.lastEventSequence = Math.max(
            job.execution.lastEventSequence,
            Number(event.sequence)
          );
          if (
            event.type === 'output' &&
            event.data &&
            (event.stream === 'stdout' || event.stream === 'stderr')
          ) {
            this.append(job, event.stream, event.data, input);
          }
        }
        if (
          watched.truncated &&
          (watched.events?.length ?? 0) === 0 &&
          Number.isFinite(watched.nextSequence)
        ) {
          job.execution.lastEventSequence = Math.max(
            job.execution.lastEventSequence,
            Number(watched.nextSequence)
          );
        }
        remoteJob = watched.job;
        if (!watched.timedOut) this.changed(job);
      } catch (error) {
        if (
          error instanceof RunnerTransportError &&
          error.code === 'IDEMPOTENCY_CONFLICT'
        ) {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new RunnerTransportError(
            'REMOTE_STATE_LOST',
            'REMOTE_STATE_LOST: Runner could not be reattached before the recovery deadline',
            true
          );
        }
        job.execution.phase = 'reconnecting';
        job.execution.connectionState = 'reconnecting';
        job.execution.reconnectCount += 1;
        job.timing = {
          ...job.timing,
          disconnectedAt: new Date().toISOString(),
        };
        this.changed(job);
        await this.runnerRetryDelay(job.execution.reconnectCount);
      }
    }

    job.execution.phase = 'finalizing';
    job.execution.connectionState = 'connected';
    job.timing = {
      ...job.timing,
      recoveredAt:
        job.execution.reconnectCount > 0
          ? new Date().toISOString()
          : job.timing?.recoveredAt,
    };
    this.changed(job);
    return {
      exitCode: remoteJob.exitCode ?? null,
      signal: remoteJob.signal,
      timedOut: remoteJob.state === 'timed_out',
      terminalState: remoteJob.state,
      cancellationVerified: remoteJob.cancellationVerified,
    };
  }

  private async recoverRunnerJob(job: JobRecord): Promise<void> {
    const profileId = job.credentialProfileId;
    const remoteJobId = job.execution.remoteJobId;
    if (!profileId || !remoteJobId || !this.recoverRunnerTarget) return;
    this.activeJobs.add(job.id);
    const input: StartJobInput = {
      command: '[durable runner recovery]',
      target: { kind: 'local' },
      adapter: job.adapter,
      outputPolicy: job.outputPolicy,
      progressPattern: job.progressPattern,
      credentialProfileId: profileId,
    };
    try {
      const recoveryDeadline = Date.now() + DEFAULT_TIMEOUT_MS;
      let transport: RunnerRPCClient | undefined;
      let remote: { job: RunnerJobPayload } | undefined;
      let ping: { version?: string } | undefined;
      while (!transport || !remote || !ping) {
        try {
          const target = await this.recoverRunnerTarget(profileId);
          input.target = target;
          const candidate = this.runnerTransportFactory(target);
          ping = await candidate.call<{ version?: string }>('ping', {}, 20_000);
          remote = await candidate.call<{ job: RunnerJobPayload }>(
            'get',
            { jobId: remoteJobId },
            20_000
          );
          transport = candidate;
        } catch (error) {
          if (Date.now() >= recoveryDeadline) throw error;
          job.execution.phase = 'reconnecting';
          job.execution.connectionState = 'reconnecting';
          job.execution.reconnectCount += 1;
          this.changed(job);
          await this.runnerRetryDelay(job.execution.reconnectCount);
        }
      }
      job.execution.runnerVersion = ping.version?.slice(0, 64);
      job.execution.connectionState = 'connected';
      job.execution.phase = 'executing';
      job.timing = {
        ...job.timing,
        recoveredAt: new Date().toISOString(),
      };
      this.changed(job);
      const result = await this.watchRunnerJob(
        job,
        input,
        transport,
        remote.job,
        recoveryDeadline
      );
      this.completeExecution(job, input, result);
    } catch (error) {
      this.flushProgress(job, input);
      this.finish(job, 'lost', `REMOTE_STATE_LOST: ${safeErrorMessage(error)}`);
    } finally {
      this.activeJobs.delete(job.id);
      this.runtimeHandles.delete(job.id);
      this.scheduleDrain();
    }
  }

  private runnerRetryDelay(attempt: number): Promise<void> {
    const delayMs = Math.min(
      5_000,
      this.sshRetryBaseDelayMs * 2 ** Math.min(5, Math.max(0, attempt - 1))
    );
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      timer.unref?.();
    });
  }

  private runLocal(
    job: JobRecord,
    input: StartJobInput
  ): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let child: ChildProcess;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
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
          detached: process.platform !== 'win32',
        });
      } catch (error) {
        reject(error);
        return;
      }

      job.pid = child.pid;
      job.timing = {
        ...job.timing,
        commandStartedAt: new Date().toISOString(),
      };
      this.changed(job);
      child.stdout?.on('data', (data) =>
        this.append(job, 'stdout', stdoutDecoder.write(data), input)
      );
      child.stderr?.on('data', (data) =>
        this.append(job, 'stderr', stderrDecoder.write(data), input)
      );
      child.once('error', (error) => settle(undefined, error));
      child.once('close', (code, signal) => {
        this.append(job, 'stdout', stdoutDecoder.end(), input);
        this.append(job, 'stderr', stderrDecoder.end(), input);
        settle({ exitCode: code, signal, timedOut });
      });

      this.runtimeHandles.set(job.id, {
        cancellationVerified: true,
        cancel: () => this.terminateLocalProcessTree(child, false),
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        this.terminateLocalProcessTree(child, true);
      }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timeout.unref?.();
    });
  }

  private runSsh(
    job: JobRecord,
    input: StartJobInput
  ): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      const target = input.target;
      if (!target || target.kind !== 'ssh') {
        reject(new Error('SSH target is missing'));
        return;
      }

      let settled = false;
      let timedOut = false;
      let channel: ClientChannel | undefined;
      let client: Client | undefined;
      let retryTimer: NodeJS.Timeout | undefined;
      let attempt = 0;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      const settle = (result?: ExecutionResult, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = undefined;
        client?.destroy();
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
        readyTimeout: Math.max(
          1,
          Math.min(
            input.timeoutMs ?? this.sshReadyTimeoutMs,
            this.sshReadyTimeoutMs
          )
        ),
        keepaliveInterval: 10_000,
        keepaliveCountMax: 6,
      };
      if (target.privateKeyPath) {
        config.privateKey = readFileSync(target.privateKeyPath);
      }
      const expectedHostKey = target.hostKeySha256
        ? normalizeSshSha256Fingerprint(target.hostKeySha256)
        : undefined;
      const excludedHostKeyAlgorithms = new Set<ServerHostKeyAlgorithm>();

      const connect = () => {
        if (settled) return;
        attempt += 1;
        const currentClient = this.sshClientFactory();
        client = currentClient;
        let ready = false;
        let failureHandled = false;
        let hostKeyRejected = false;
        let rejectedHostKeyAlgorithms: ServerHostKeyAlgorithm[] = [];

        const scheduleRetry = () => {
          if (settled) return;
          const delayMs = this.sshRetryBaseDelayMs * 2 ** (attempt - 1);
          this.append(
            job,
            'system',
            `SSH handshake attempt ${attempt}/${this.sshHandshakeAttempts} failed; retrying in ${delayMs} ms.\n`,
            input
          );
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            connect();
          }, delayMs);
          retryTimer.unref?.();
        };

        const destroyBeforeRetry = (alreadyClosed: boolean) => {
          if (alreadyClosed) {
            currentClient.destroy();
            scheduleRetry();
            return;
          }

          let cleanupFinished = false;
          let cleanupTimer: NodeJS.Timeout | undefined;
          const finishCleanup = () => {
            if (cleanupFinished) return;
            cleanupFinished = true;
            if (cleanupTimer) clearTimeout(cleanupTimer);
            currentClient.removeListener('close', finishCleanup);
            scheduleRetry();
          };
          currentClient.once('close', finishCleanup);
          currentClient.destroy();
          if (!cleanupFinished) {
            cleanupTimer = setTimeout(
              finishCleanup,
              SSH_CLIENT_CLEANUP_TIMEOUT_MS
            );
            cleanupTimer.unref?.();
          }
        };

        const failAttempt = (error: Error, alreadyClosed = false) => {
          if (settled || failureHandled || currentClient !== client) return;
          failureHandled = true;

          let addedHostKeyAlgorithm = false;
          if (!target.hostKeyAlgorithm) {
            for (const algorithm of rejectedHostKeyAlgorithms) {
              if (!excludedHostKeyAlgorithms.has(algorithm)) {
                excludedHostKeyAlgorithms.add(algorithm);
                addedHostKeyAlgorithm = true;
              }
            }
          }

          // Once SSH is ready, an exec request may have reached the server. Never
          // retry at that point because doing so could duplicate training/deploys.
          if (
            ready ||
            attempt >= this.sshHandshakeAttempts ||
            timedOut ||
            (hostKeyRejected &&
              (Boolean(target.hostKeyAlgorithm) ||
                rejectedHostKeyAlgorithms.length === 0 ||
                !addedHostKeyAlgorithm))
          ) {
            settle(
              undefined,
              hostKeyRejected
                ? new Error(
                    'HOST_KEY_MISMATCH: SSH host key did not match the pinned SHA-256 fingerprint'
                  )
                : error
            );
            return;
          }

          destroyBeforeRetry(alreadyClosed);
        };

        currentClient.once('ready', () => {
          if (settled || currentClient !== client) return;
          ready = true;
          const readyAt = new Date().toISOString();
          job.execution.phase = 'executing';
          job.execution.connectionState = 'connected';
          job.timing = {
            ...job.timing,
            sshReadyAt: readyAt,
            commandStartedAt: readyAt,
          };
          this.changed(job);
          currentClient.exec(input.command, (error, stream) => {
            if (settled || currentClient !== client) {
              stream?.close();
              return;
            }
            if (error) {
              failAttempt(error);
              return;
            }
            channel = stream;
            stream.on('data', (data: Buffer) =>
              this.append(job, 'stdout', stdoutDecoder.write(data), input)
            );
            stream.stderr.on('data', (data: Buffer) =>
              this.append(job, 'stderr', stderrDecoder.write(data), input)
            );
            stream.once('error', (streamError: Error) =>
              settle(undefined, streamError)
            );
            stream.once('close', (code: number | null, signal?: string) => {
              this.append(job, 'stdout', stdoutDecoder.end(), input);
              this.append(job, 'stderr', stderrDecoder.end(), input);
              settle({ exitCode: code, signal, timedOut });
            });
          });
        });
        currentClient.once('error', (error) => failAttempt(error));
        currentClient.once('close', () =>
          failAttempt(
            new Error(
              ready
                ? 'SSH connection closed before job completion'
                : 'SSH connection closed before handshake'
            ),
            true
          )
        );
        const attemptConfig: ConnectConfig = {
          ...config,
          hostVerifier: expectedHostKey
            ? (key: Buffer) => {
                const actual = normalizeSshSha256Fingerprint(
                  createHash('sha256').update(key).digest('base64')
                );
                if (actual === expectedHostKey) return true;
                hostKeyRejected = true;
                rejectedHostKeyAlgorithms = hostKeyAlgorithmsForRawKey(key);
                return false;
              }
            : () => Boolean(target.allowUnverifiedHostKey),
        };
        if (excludedHostKeyAlgorithms.size > 0) {
          attemptConfig.algorithms = {
            serverHostKey: SSH_SERVER_HOST_KEY_ALGORITHMS.filter(
              (algorithm) => !excludedHostKeyAlgorithms.has(algorithm)
            ),
          };
        } else if (
          target.hostKeyAlgorithm &&
          SSH_SERVER_HOST_KEY_ALGORITHMS.includes(
            target.hostKeyAlgorithm as ServerHostKeyAlgorithm
          )
        ) {
          attemptConfig.algorithms = {
            serverHostKey: [target.hostKeyAlgorithm as ServerHostKeyAlgorithm],
          };
        }
        try {
          currentClient.connect(attemptConfig);
        } catch (error) {
          failAttempt(
            error instanceof Error ? error : new Error(safeErrorMessage(error))
          );
        }
      };

      this.runtimeHandles.set(job.id, {
        cancellationVerified: false,
        cancel: () => {
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = undefined;
          channel?.close();
          client?.destroy();
          settle({ exitCode: null, signal: 'cancelled' });
        },
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        channel?.close();
        client?.destroy();
        settle({ exitCode: null, signal: 'timeout', timedOut: true });
      }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timeout.unref?.();
      connect();
    });
  }

  private append(
    job: JobRecord,
    stream: 'stdout' | 'stderr' | 'system',
    data: string,
    input?: StartJobInput
  ): void {
    if (!data) return;
    const bounded = this.boundOutputChunk(data);
    if (bounded.truncated) job.outputTruncated = true;
    const chunk: JobOutputChunk = {
      sequence: ++this.sequence,
      stream,
      data: bounded.data,
      timestamp: new Date().toISOString(),
    };
    job.output.push(chunk);
    job.outputBytes += Buffer.byteLength(chunk.data);
    job.outputLines += Math.max(1, chunk.data.split(/\r\n|\r|\n/).length - 1);
    if (stream !== 'system') {
      job.lastOutputAt = chunk.timestamp;
      if (!job.timing?.firstOutputAt) {
        job.timing = { ...job.timing, firstOutputAt: chunk.timestamp };
      }
    }

    this.trimOutputBuffer(job);

    if (input && stream !== 'system') {
      this.updateProgress(job, chunk.data, input);
    }
    this.changed(job);
  }

  private updateProgress(
    job: JobRecord,
    data: string,
    input: StartJobInput
  ): void {
    const previous = this.progressRemainders.get(job.id) ?? '';
    const combined = `${previous}${data}`;
    const lines = combined.split(/\r\n|\r|\n/);
    const remainder = lines.pop() ?? '';
    this.progressRemainders.set(
      job.id,
      remainder.slice(-MAX_PROGRESS_LINE_LENGTH)
    );
    for (const line of lines) this.parseProgress(job, line, input);
  }

  private parseProgress(
    job: JobRecord,
    data: string,
    input: StartJobInput
  ): void {
    let percentage: number | undefined;
    let phase: string | undefined;
    let message: string | undefined;
    let structuredEvent = false;
    let metrics: JobRecord['progress'] extends infer P
      ? P extends { metrics?: infer M }
        ? M
        : never
      : never;
    try {
      const boundedData = data.slice(-MAX_PROGRESS_LINE_LENGTH);
      const structuredPrefix = 'RUNBEACON_EVENT ';
      const structuredIndex = boundedData.indexOf(structuredPrefix);
      if (structuredIndex >= 0) {
        structuredEvent = true;
        const event = JSON.parse(
          boundedData.slice(structuredIndex + structuredPrefix.length)
        ) as Record<string, unknown>;
        const parsed = Number(event.percentage);
        if (Number.isFinite(parsed)) percentage = parsed;
        if (typeof event.phase === 'string') phase = event.phase.slice(0, 64);
        if (typeof event.message === 'string') {
          message = event.message.slice(0, 240);
        }
        if (job.adapter === 'training') {
          metrics = {};
          for (const key of ['epoch', 'step', 'loss', 'etaSeconds'] as const) {
            const value = Number(event[key]);
            if (Number.isFinite(value)) metrics[key] = value;
          }
          if (typeof event.checkpoint === 'string') {
            metrics.checkpoint = event.checkpoint.slice(0, 240);
          }
          if (typeof event.gpu === 'string') {
            metrics.gpu = event.gpu.slice(0, 240);
          }
          if (Object.keys(metrics).length === 0) metrics = undefined;
        }
      }
      if (input.progressPattern) {
        const compiled = this.progressPatterns.get(job.id);
        if (!compiled) return;
        const matcher = compiled.matcher(boundedData);
        let matchedText: string | null = null;
        let capturedPercentage: string | null = null;
        while (matcher.find()) {
          matchedText = matcher.group(0);
          capturedPercentage = matcher.group(1);
        }
        if (matchedText !== null) {
          const parsed = Number(capturedPercentage);
          if (Number.isFinite(parsed)) percentage = parsed;
          message = matchedText.slice(0, 240);
        }
      } else if (!structuredEvent && job.adapter === 'generic') {
        const matches = Array.from(
          boundedData.matchAll(/(?:^|\s)(\d{1,3}(?:\.\d+)?)\s*%/g)
        );
        const match = matches.at(-1);
        if (match?.[0]) {
          percentage = Number(match[1]);
          message = boundedData.trim().slice(0, 240);
        }
      }
      const phaseMatch = /\[([A-Za-z][A-Za-z0-9_-]{0,63})\]/.exec(boundedData);
      if (!phase && phaseMatch) phase = phaseMatch[1];
    } catch {
      // A malformed optional progress pattern must not interrupt the job.
    }
    if (
      percentage === undefined &&
      !(structuredEvent && (phase || message || metrics))
    ) {
      return;
    }
    job.progress = {
      percentage:
        percentage === undefined
          ? job.progress?.percentage
          : Math.max(0, Math.min(100, percentage)),
      phase,
      message,
      metrics,
      updatedAt: new Date().toISOString(),
    };
    job.lastProgressAt = job.progress.updatedAt;
  }

  private flushProgress(job: JobRecord, input: StartJobInput): void {
    const remainder = this.progressRemainders.get(job.id);
    this.progressRemainders.delete(job.id);
    if (remainder) this.parseProgress(job, remainder, input);
  }

  private touch(
    job: JobRecord,
    message: string,
    stream: 'system',
    persistence: 'immediate' | 'debounced' = 'debounced'
  ): void {
    this.append(job, stream, message, undefined);
    if (persistence === 'immediate') this.persistNow();
  }

  private finish(job: JobRecord, state: JobState, error?: string): void {
    if (isTerminalJobState(job.state)) return;
    job.state = state;
    job.execution.phase = 'finished';
    job.execution.connectionState =
      job.execution.backend === 'local' ? 'not_applicable' : 'disconnected';
    job.error = error;
    job.finishedAt = new Date().toISOString();
    this.approvalContexts.delete(job.id);
    const terminalMessage =
      state === 'succeeded'
        ? 'Job completed successfully.'
        : state === 'cancelled'
          ? 'Job cancelled.'
          : error || `Job finished with state ${state}.`;
    this.touch(job, terminalMessage, 'system', 'immediate');
    try {
      this.auditLog.append({
        action: 'job_terminal',
        outcome: state,
        jobId: job.id,
        target: this.auditTarget(job.target),
        risk: job.policy.risk,
      });
    } catch (auditError) {
      this.emit('auditError', safeErrorMessage(auditError));
    }
    if (job.eventSubscriptions?.length) {
      void this.eventSubscriptions
        .dispatch(job.eventSubscriptions, {
          event: 'job_terminal',
          jobId: job.id,
          state,
          finishedAt: job.finishedAt,
        })
        .then((results) => {
          for (const result of results) {
            this.auditLog.append({
              action: 'event_delivery',
              outcome: result.delivered ? 'delivered' : 'failed',
              jobId: job.id,
              target: result.id,
            });
          }
        })
        .catch((deliveryError) => {
          this.emit('eventDeliveryError', safeErrorMessage(deliveryError));
        });
    }
    this.progressPatterns.delete(job.id);
  }

  private changed(job: JobRecord): void {
    job.version += 1;
    job.updatedAt = new Date().toISOString();
    this.schedulePersist();
    this.emit('jobChanged', job);
    const changeWaiters = this.changeWaiters.get(job.id);
    if (changeWaiters) {
      for (const waiter of Array.from(changeWaiters.values())) {
        if (job.version <= waiter.afterVersion) continue;
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener('abort', waiter.abortListener!);
        changeWaiters.delete(waiter.id);
        waiter.resolve({
          changed: true,
          job: this.snapshot(job.id, waiter.tailLines),
        });
      }
      if (changeWaiters.size === 0) this.changeWaiters.delete(job.id);
    }
    if (isTerminalJobState(job.state)) {
      const coordinator = this.waitCoordinators.get(job.id);
      if (coordinator) this.resolveCoordinator(coordinator, false);
    }
  }

  private schedulePersist(): void {
    if (this.persistenceTimer) return;
    this.persistenceTimer = setTimeout(
      () => this.persistNow(),
      this.persistenceDebounceMs
    );
    this.persistenceTimer.unref?.();
  }

  private persistNow(): void {
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
    this.persistenceTimer = undefined;
    this.pruneHistory();
    try {
      this.store.save(Array.from(this.jobs.values()));
      this.lastPersistenceError = undefined;
      this.lastPersistenceSuccessAt = new Date().toISOString();
    } catch (error) {
      this.lastPersistenceError = safeErrorMessage(error);
      this.emit('persistenceError', this.lastPersistenceError);
    }
  }

  persistenceStatus() {
    return {
      healthy: !this.lastPersistenceError,
      lastError: this.lastPersistenceError,
      lastSuccessAt: this.lastPersistenceSuccessAt,
    };
  }

  private pruneHistory(): void {
    const expired = Array.from(this.jobs.values())
      .filter((job) => isTerminalJobState(job.state))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(this.maxRetainedJobs);
    for (const job of expired) {
      this.jobs.delete(job.id);
      this.pendingInputs.delete(job.id);
      this.runtimeHandles.delete(job.id);
      this.progressRemainders.delete(job.id);
      this.progressPatterns.delete(job.id);
      const coordinator = this.waitCoordinators.get(job.id);
      if (coordinator) {
        this.rejectCoordinator(
          coordinator,
          new Error(`Unknown job: ${job.id}`)
        );
      }
    }
  }

  private compileProgressPattern(pattern: string): RE2JS {
    if (pattern.length > MAX_PROGRESS_PATTERN_LENGTH) {
      throw new Error('progressPattern must not exceed 256 characters');
    }
    try {
      const compiled = RE2JS.compile(pattern, RE2JS.MULTILINE);
      if (compiled.groupCount() < 1) {
        throw new Error('capture-group-required');
      }
      return compiled;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'capture-group-required'
      ) {
        throw new Error('progressPattern must contain capture group 1');
      }
      throw new Error(
        'progressPattern must be a valid RE2-compatible regular expression'
      );
    }
  }

  private armWaitTimer(coordinator: WaitCoordinator): void {
    if (coordinator.timer) clearTimeout(coordinator.timer);
    coordinator.timer = undefined;
    if (coordinator.waiters.size === 0) {
      this.waitCoordinators.delete(coordinator.jobId);
      return;
    }
    const nextExpiry = Math.min(
      ...Array.from(coordinator.waiters.values(), (waiter) => waiter.expiresAt)
    );
    coordinator.timer = setTimeout(
      () => this.expireWaiters(coordinator),
      Math.max(1, nextExpiry - Date.now())
    );
    coordinator.timer.unref?.();
  }

  private expireWaiters(coordinator: WaitCoordinator): void {
    coordinator.timer = undefined;
    const now = Date.now();
    for (const waiter of Array.from(coordinator.waiters.values())) {
      if (waiter.expiresAt <= now) {
        this.resolveWaiter(coordinator, waiter, true);
      }
    }
    this.armWaitTimer(coordinator);
  }

  private resolveCoordinator(
    coordinator: WaitCoordinator,
    timedOut: boolean
  ): void {
    for (const waiter of Array.from(coordinator.waiters.values())) {
      this.resolveWaiter(coordinator, waiter, timedOut);
    }
    this.clearCoordinator(coordinator);
  }

  private rejectCoordinator(coordinator: WaitCoordinator, error: Error): void {
    for (const waiter of Array.from(coordinator.waiters.values())) {
      this.rejectWaiter(coordinator, waiter, error);
    }
    this.clearCoordinator(coordinator);
  }

  private resolveWaiter(
    coordinator: WaitCoordinator,
    waiter: Waiter,
    timedOut: boolean
  ): void {
    if (!this.removeWaiter(coordinator, waiter)) return;
    try {
      waiter.resolve({
        timedOut,
        job: this.snapshot(coordinator.jobId, waiter.tailLines),
      });
    } catch (error) {
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rejectWaiter(
    coordinator: WaitCoordinator,
    waiter: Waiter,
    error: Error
  ): void {
    if (!this.removeWaiter(coordinator, waiter)) return;
    waiter.reject(error);
    this.armWaitTimer(coordinator);
  }

  private removeWaiter(coordinator: WaitCoordinator, waiter: Waiter): boolean {
    if (!coordinator.waiters.delete(waiter.id)) return false;
    this.totalWaiters -= 1;
    if (waiter.abortListener) {
      waiter.signal?.removeEventListener('abort', waiter.abortListener);
    }
    return true;
  }

  private clearCoordinator(coordinator: WaitCoordinator): void {
    if (coordinator.timer) clearTimeout(coordinator.timer);
    coordinator.timer = undefined;
    this.waitCoordinators.delete(coordinator.jobId);
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('LifecycleManager was disposed');
  }

  private normalizeOutputPolicy(
    input: StartJobInput
  ): Required<NonNullable<StartJobInput['outputPolicy']>> {
    const mode = input.outputPolicy?.mode ?? 'tail';
    const maxBytes = boundedInteger(
      input.outputPolicy?.maxBytes,
      64 * 1024 * 1024,
      64 * 1024,
      1024 * 1024 * 1024
    );
    const retentionHours = boundedInteger(
      input.outputPolicy?.retentionHours,
      7 * 24,
      1,
      90 * 24
    );
    return { mode, maxBytes, retentionHours };
  }

  private boundOutputChunk(data: string): {
    data: string;
    truncated: boolean;
  } {
    const encoded = Buffer.from(data);
    if (encoded.length <= this.maxOutputBytes) {
      return { data, truncated: false };
    }
    let start = encoded.length - this.maxOutputBytes;
    while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) {
      start += 1;
    }
    return { data: encoded.subarray(start).toString('utf8'), truncated: true };
  }

  private trimOutputBuffer(job: JobRecord): void {
    while (job.outputBytes > this.maxOutputBytes && job.output.length > 0) {
      const overflow = job.outputBytes - this.maxOutputBytes;
      const first = job.output[0];
      const encoded = Buffer.from(first.data);
      if (encoded.length <= overflow && job.output.length > 1) {
        job.output.shift();
        job.outputBytes -= encoded.length;
      } else {
        let start = Math.min(overflow, encoded.length);
        while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) {
          start += 1;
        }
        first.data = encoded.subarray(start).toString('utf8');
        job.outputBytes -= start;
        if (!first.data) job.output.shift();
      }
      job.outputTruncated = true;
    }
  }

  private terminateLocalProcessTree(child: ChildProcess, force: boolean): void {
    const pid = child.pid;
    if (!pid || child.exitCode !== null || child.signalCode !== null) return;

    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => child.kill());
      killer.once('close', (code) => {
        if (code !== 0 && child.exitCode === null) child.kill();
      });
      killer.unref();
      return;
    }

    const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
    try {
      process.kill(-pid, signal);
    } catch {
      child.kill(signal);
    }
    if (!force) {
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }, this.cancellationGraceMs);
      forceTimer.unref?.();
    }
  }

  private assess(job: JobRecord) {
    const now = Date.now();
    const started = job.startedAt
      ? Date.parse(job.startedAt)
      : Date.parse(job.createdAt);
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

export function normalizeWatchTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return 25_000;
  if (timeoutMs <= 100) return 100;
  if (timeoutMs <= 1_000) return 1_000;
  if (timeoutMs <= 5_000) return 5_000;
  if (timeoutMs <= 15_000) return 15_000;
  if (timeoutMs <= 25_000) return 25_000;
  return 30_000;
}
