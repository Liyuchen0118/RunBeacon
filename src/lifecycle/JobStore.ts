import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import {
  JobOutputChunk,
  JobRecord,
  JobState,
  JobTiming,
  PublicJobTarget,
  TERMINAL_JOB_STATES,
} from './types.js';
import { JOB_STORE_VERSION } from './protocol.js';
import { redactPersistedText, sanitizeMetadata } from './security.js';

interface StoreDocument {
  version: 1 | 2;
  savedAt: string;
  jobs: JobRecord[];
}

export class JobStore {
  private readonly journalPath: string;
  private readonly v1BackupPath: string;
  private readonly persistedVersions = new Map<string, number>();
  private journalSequence = 0;

  constructor(
    private readonly filePath: string,
    private readonly persistOutput = false,
    private readonly persistMetadata = false
  ) {
    this.journalPath = `${filePath}.events.jsonl`;
    this.v1BackupPath = `${filePath}.v1.backup.json`;
  }

  load(): JobRecord[] {
    const jobs = new Map<string, JobRecord>();
    if (existsSync(this.filePath)) {
      try {
        const document = JSON.parse(
          readFileSync(this.filePath, 'utf8')
        ) as StoreDocument;
        if (
          (document.version === 1 || document.version === JOB_STORE_VERSION) &&
          Array.isArray(document.jobs)
        ) {
          if (document.version === 1) this.backupV1Snapshot();
          for (const raw of document.jobs) {
            const job = normalizeJob(
              raw,
              this.persistOutput,
              this.persistMetadata
            );
            if (job) jobs.set(job.id, job);
          }
        }
      } catch {
        // A valid journal may recover a missing or partially written snapshot.
      }
    }
    this.replayJournal(jobs);
    for (const job of jobs.values()) {
      this.persistedVersions.set(job.id, job.version);
    }
    return Array.from(jobs.values());
  }

  save(jobs: JobRecord[]): void {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });

    const serializedJobs = jobs.map((job) => this.serialize(job));
    const document: StoreDocument = {
      version: JOB_STORE_VERSION,
      savedAt: new Date().toISOString(),
      jobs: serializedJobs,
    };

    const currentIds = new Set(serializedJobs.map((job) => job.id));
    const payload: JournalPayload = {
      version: 2,
      sequence: this.journalSequence + 1,
      savedAt: document.savedAt,
      jobs: serializedJobs.filter(
        (job) => this.persistedVersions.get(job.id) !== job.version
      ),
      deleted: Array.from(this.persistedVersions.keys()).filter(
        (id) => !currentIds.has(id)
      ),
    };
    if (payload.jobs.length > 0 || payload.deleted.length > 0) {
      this.appendJournal(payload);
      this.journalSequence = payload.sequence;
    }

    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(document, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    // Windows rejects fsync on a read-only handle even when the file itself is
    // writable. Open the completed snapshot for update so the durability step
    // behaves consistently across all coordinator platforms.
    const temporaryHandle = openSync(temporaryPath, 'r+');
    try {
      fsyncSync(temporaryHandle);
    } finally {
      closeSync(temporaryHandle);
    }
    if (process.platform !== 'win32') chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.filePath);
    if (process.platform !== 'win32') chmodSync(this.filePath, 0o600);
    this.persistedVersions.clear();
    for (const job of serializedJobs) {
      this.persistedVersions.set(job.id, job.version);
    }
    this.compactJournalIfNeeded();
  }

  private backupV1Snapshot(): void {
    if (existsSync(this.v1BackupPath)) return;
    try {
      copyFileSync(this.filePath, this.v1BackupPath);
      if (process.platform !== 'win32') chmodSync(this.v1BackupPath, 0o600);
    } catch {
      // Migration can continue because the source snapshot remains untouched.
    }
  }

  private appendJournal(payload: JournalPayload): void {
    const line = `${JSON.stringify({
      ...payload,
      checksum: checksumPayload(payload),
    })}\n`;
    const handle = openSync(this.journalPath, 'a', 0o600);
    try {
      writeSync(handle, line, undefined, 'utf8');
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    if (process.platform !== 'win32') chmodSync(this.journalPath, 0o600);
  }

  private replayJournal(jobs: Map<string, JobRecord>): void {
    if (!existsSync(this.journalPath)) return;
    try {
      const lines = readFileSync(this.journalPath, 'utf8').split(/\r?\n/);
      let expectedSequence = 1;
      for (const line of lines) {
        if (!line.trim()) continue;
        let record: JournalRecord;
        try {
          record = JSON.parse(line) as JournalRecord;
        } catch {
          break;
        }
        const { checksum, ...payload } = record;
        if (
          payload.version !== 2 ||
          payload.sequence !== expectedSequence ||
          checksum !== checksumPayload(payload)
        )
          break;
        this.journalSequence = Math.max(this.journalSequence, payload.sequence);
        expectedSequence += 1;
        for (const id of payload.deleted ?? []) jobs.delete(String(id));
        for (const raw of payload.jobs ?? []) {
          const job = normalizeJob(
            raw,
            this.persistOutput,
            this.persistMetadata
          );
          if (!job) continue;
          const current = jobs.get(job.id);
          if (!current || current.version <= job.version) jobs.set(job.id, job);
        }
      }
    } catch {
      // Ignore a corrupt tail; complete journal records remain independently valid.
    }
  }

  private compactJournalIfNeeded(): void {
    try {
      if (statSync(this.journalPath).size <= MAX_JOURNAL_BYTES) return;
      truncateSync(this.journalPath, 0);
      this.journalSequence = 0;
    } catch {
      // Compaction is best effort after a durable snapshot succeeds.
    }
  }

  private serialize(job: JobRecord): JobRecord {
    const output = this.persistOutput
      ? job.output.map((chunk) => ({
          ...chunk,
          data: redactPersistedText(chunk.data, 64 * 1024),
        }))
      : [];
    return {
      ...job,
      label: redactPersistedText(job.label, 120),
      displayCommand: redactPersistedText(job.displayCommand, 4_000),
      error: job.error ? redactPersistedText(job.error) : undefined,
      progress: job.progress
        ? {
            ...job.progress,
            // Progress messages are output-derived and follow the same opt-in.
            message:
              this.persistOutput && job.progress.message
                ? redactPersistedText(job.progress.message, 240)
                : undefined,
            phase: this.persistOutput ? job.progress.phase : undefined,
            metrics: this.persistOutput
              ? sanitizeProgressMetrics(job.progress.metrics)
              : undefined,
          }
        : undefined,
      metadata: this.persistMetadata
        ? sanitizeMetadata(job.metadata)
        : undefined,
      // Command output can contain secrets. Persistence is explicit opt-in.
      output,
      outputBytes: output.reduce(
        (total, chunk) => total + Buffer.byteLength(chunk.data),
        0
      ),
      outputLines: output.reduce(
        (total, chunk) =>
          total + Math.max(1, chunk.data.split(/\r?\n/).length - 1),
        0
      ),
    };
  }
}

function normalizeJob(
  value: unknown,
  persistOutput: boolean,
  persistMetadata: boolean
): JobRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<JobRecord>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.updatedAt !== 'string' ||
    !isJobState(raw.state) ||
    !isPublicTarget(raw.target)
  ) {
    return undefined;
  }

  const output =
    persistOutput && Array.isArray(raw.output)
      ? raw.output.filter(isOutputChunk).map((chunk) => ({
          ...chunk,
          data: String(chunk.data),
        }))
      : [];
  return {
    id: raw.id,
    idempotencyKey:
      typeof raw.idempotencyKey === 'string'
        ? raw.idempotencyKey.slice(0, 200)
        : undefined,
    label:
      typeof raw.label === 'string'
        ? redactPersistedText(raw.label, 120)
        : `Job ${raw.id.slice(0, 8)}`,
    displayCommand:
      typeof raw.displayCommand === 'string'
        ? redactPersistedText(raw.displayCommand)
        : '[unknown]',
    target: normalizePublicTarget(raw.target),
    state: raw.state === ('orphaned' as JobState) ? 'lost' : raw.state,
    createdAt: raw.createdAt,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : undefined,
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : undefined,
    updatedAt: raw.updatedAt,
    version: Number.isFinite(raw.version) ? Number(raw.version) : 1,
    pid: Number.isFinite(raw.pid) ? Number(raw.pid) : undefined,
    exitCode:
      raw.exitCode === null || Number.isFinite(raw.exitCode)
        ? (raw.exitCode as number | null)
        : undefined,
    signal:
      typeof raw.signal === 'string' || raw.signal === null
        ? raw.signal
        : undefined,
    error:
      typeof raw.error === 'string'
        ? redactPersistedText(raw.error)
        : undefined,
    cancelRequested: raw.cancelRequested === true ? true : undefined,
    cancellationVerified:
      typeof raw.cancellationVerified === 'boolean'
        ? raw.cancellationVerified
        : undefined,
    progress:
      raw.progress && typeof raw.progress.updatedAt === 'string'
        ? {
            ...raw.progress,
            message:
              persistOutput && typeof raw.progress.message === 'string'
                ? redactPersistedText(raw.progress.message, 240)
                : undefined,
            phase:
              persistOutput && typeof raw.progress.phase === 'string'
                ? raw.progress.phase.slice(0, 64)
                : undefined,
            metrics: persistOutput
              ? sanitizeProgressMetrics(raw.progress.metrics)
              : undefined,
          }
        : undefined,
    lastOutputAt:
      typeof raw.lastOutputAt === 'string' ? raw.lastOutputAt : undefined,
    lastProgressAt:
      typeof raw.lastProgressAt === 'string' ? raw.lastProgressAt : undefined,
    output,
    outputBytes: output.reduce(
      (total, chunk) => total + Buffer.byteLength(chunk.data),
      0
    ),
    outputLines: output.reduce(
      (total, chunk) =>
        total + Math.max(1, chunk.data.split(/\r?\n/).length - 1),
      0
    ),
    outputTruncated: raw.outputTruncated === true,
    metadata: persistMetadata
      ? sanitizeMetadata(
          raw.metadata &&
            typeof raw.metadata === 'object' &&
            !Array.isArray(raw.metadata)
            ? raw.metadata
            : undefined
        )
      : undefined,
    timing: normalizeTiming(raw.timing),
    execution: normalizeExecution(raw),
    policy: normalizePolicy(raw),
    adapter:
      raw.adapter === 'training' ||
      raw.adapter === 'slurm' ||
      raw.adapter === 'apple-signing'
        ? raw.adapter
        : 'generic',
    outputPolicy: normalizeOutputPolicy(raw),
    eventSubscriptions: Array.isArray(raw.eventSubscriptions)
      ? raw.eventSubscriptions
          .filter(
            (value): value is string =>
              typeof value === 'string' &&
              /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)
          )
          .slice(0, 16)
      : undefined,
    credentialProfileId:
      typeof raw.credentialProfileId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw.credentialProfileId)
        ? raw.credentialProfileId
        : undefined,
    progressPattern:
      typeof raw.progressPattern === 'string' &&
      raw.progressPattern.length <= 256
        ? raw.progressPattern
        : undefined,
  };
}

interface JournalPayload {
  version: 2;
  sequence: number;
  savedAt: string;
  jobs: JobRecord[];
  deleted: string[];
}

interface JournalRecord extends JournalPayload {
  checksum: string;
}

const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;

function sanitizeProgressMetrics(
  value: JobRecord['progress'] extends infer P
    ? P extends { metrics?: infer M }
      ? M
      : never
    : never
): NonNullable<JobRecord['progress']>['metrics'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result: NonNullable<JobRecord['progress']>['metrics'] = {};
  for (const key of ['epoch', 'step', 'loss', 'etaSeconds'] as const) {
    if (Number.isFinite(value[key])) result[key] = Number(value[key]);
  }
  if (typeof value.checkpoint === 'string') {
    result.checkpoint = redactPersistedText(value.checkpoint, 240);
  }
  if (typeof value.gpu === 'string') {
    result.gpu = redactPersistedText(value.gpu, 240);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function checksumPayload(payload: JournalPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function normalizeExecution(raw: Partial<JobRecord>): JobRecord['execution'] {
  const execution =
    raw.execution && typeof raw.execution === 'object'
      ? raw.execution
      : undefined;
  const backend =
    execution?.backend === 'ssh_runner' ||
    execution?.backend === 'github' ||
    execution?.backend === 'local'
      ? execution.backend
      : raw.target?.kind === 'ssh'
        ? 'ssh_direct'
        : 'local';
  const terminal =
    raw.state === 'succeeded' ||
    raw.state === 'failed' ||
    raw.state === 'cancelled' ||
    raw.state === 'timed_out' ||
    raw.state === 'lost' ||
    raw.state === ('orphaned' as JobState);
  return {
    backend,
    phase: terminal ? 'finished' : (execution?.phase ?? 'queued'),
    connectionState:
      backend === 'local'
        ? 'not_applicable'
        : terminal
          ? 'disconnected'
          : (execution?.connectionState ?? 'disconnected'),
    durable: execution?.durable === true,
    resumable: execution?.resumable === true,
    runnerVersion:
      typeof execution?.runnerVersion === 'string'
        ? execution.runnerVersion.slice(0, 64)
        : undefined,
    remoteJobId:
      typeof execution?.remoteJobId === 'string'
        ? execution.remoteJobId.slice(0, 128)
        : undefined,
    reconnectCount: Number.isFinite(execution?.reconnectCount)
      ? Math.max(0, Number(execution?.reconnectCount))
      : 0,
    lastEventSequence: Number.isFinite(execution?.lastEventSequence)
      ? Math.max(0, Number(execution?.lastEventSequence))
      : 0,
  };
}

function normalizePolicy(raw: Partial<JobRecord>): JobRecord['policy'] {
  const policy =
    raw.policy && typeof raw.policy === 'object' ? raw.policy : undefined;
  return {
    risk:
      policy?.risk === 'privileged' ||
      policy?.risk === 'credential' ||
      policy?.risk === 'release' ||
      policy?.risk === 'destructive'
        ? policy.risk
        : 'standard',
    approval:
      policy?.approval === 'pending' ||
      policy?.approval === 'approved' ||
      policy?.approval === 'rejected' ||
      policy?.approval === 'expired'
        ? policy.approval
        : 'not_required',
    approvedAt:
      typeof policy?.approvedAt === 'string' ? policy.approvedAt : undefined,
    grantExpiresAt:
      typeof policy?.grantExpiresAt === 'string'
        ? policy.grantExpiresAt
        : undefined,
  };
}

function normalizeOutputPolicy(
  raw: Partial<JobRecord>
): JobRecord['outputPolicy'] {
  const policy =
    raw.outputPolicy && typeof raw.outputPolicy === 'object'
      ? raw.outputPolicy
      : undefined;
  return {
    mode:
      policy?.mode === 'full' || policy?.mode === 'none' ? policy.mode : 'tail',
    maxBytes: Number.isFinite(policy?.maxBytes)
      ? Math.max(64 * 1024, Math.min(1024 * 1024 * 1024, policy!.maxBytes!))
      : 64 * 1024 * 1024,
    retentionHours: Number.isFinite(policy?.retentionHours)
      ? Math.max(1, Math.min(90 * 24, policy!.retentionHours!))
      : 7 * 24,
  };
}

function normalizeTiming(value: unknown): JobTiming | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const timing: JobTiming = {};
  for (const key of [
    'requestReceivedAt',
    'toolReceivedAt',
    'credentialsResolvedAt',
    'commandStartedAt',
    'sshReadyAt',
    'firstOutputAt',
    'policyResolvedAt',
    'runnerAcceptedAt',
    'disconnectedAt',
    'recoveredAt',
  ] as const) {
    if (typeof raw[key] === 'string' && Number.isFinite(Date.parse(raw[key]))) {
      timing[key] = raw[key].slice(0, 40);
    }
  }
  if (
    typeof raw.requestTraceId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(raw.requestTraceId)
  ) {
    timing.requestTraceId = raw.requestTraceId.slice(0, 64);
  }
  return Object.keys(timing).length > 0 ? timing : undefined;
}

function isJobState(value: unknown): value is JobState {
  return (
    typeof value === 'string' &&
    (TERMINAL_JOB_STATES.has(value as JobState) ||
      value === 'queued' ||
      value === 'running' ||
      value === 'orphaned')
  );
}

function isPublicTarget(value: unknown): value is PublicJobTarget {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as PublicJobTarget).kind;
  return kind === 'local' || kind === 'ssh';
}

function normalizePublicTarget(value: PublicJobTarget): PublicJobTarget {
  if (value.kind === 'local') return { kind: 'local' };
  return {
    kind: 'ssh',
    host: typeof value.host === 'string' ? value.host.slice(0, 253) : undefined,
    port:
      Number.isInteger(value.port) && value.port! >= 1 && value.port! <= 65535
        ? value.port
        : 22,
    username:
      typeof value.username === 'string'
        ? value.username.slice(0, 128)
        : undefined,
    verifiedHostKey: value.verifiedHostKey === true,
    hostKeySha256:
      typeof value.hostKeySha256 === 'string' &&
      /^SHA256:[A-Za-z0-9+/]{43}=?$/.test(value.hostKeySha256)
        ? value.hostKeySha256
        : undefined,
    hostKeyAlgorithm:
      typeof value.hostKeyAlgorithm === 'string'
        ? value.hostKeyAlgorithm.slice(0, 64)
        : undefined,
    runnerPath:
      typeof value.runnerPath === 'string'
        ? value.runnerPath.slice(0, 4_000)
        : undefined,
  };
}

function isOutputChunk(value: unknown): value is JobOutputChunk {
  if (!value || typeof value !== 'object') return false;
  const chunk = value as Partial<JobOutputChunk>;
  return (
    Number.isFinite(chunk.sequence) &&
    (chunk.stream === 'stdout' ||
      chunk.stream === 'stderr' ||
      chunk.stream === 'system') &&
    typeof chunk.data === 'string' &&
    typeof chunk.timestamp === 'string'
  );
}
