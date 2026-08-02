import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  JobOutputChunk,
  JobRecord,
  JobState,
  PublicJobTarget,
  TERMINAL_JOB_STATES,
} from './types.js';
import { redactPersistedText, sanitizeMetadata } from './security.js';

interface StoreDocument {
  version: 1;
  savedAt: string;
  jobs: JobRecord[];
}

export class JobStore {
  constructor(
    private readonly filePath: string,
    private readonly persistOutput = false,
    private readonly persistMetadata = false
  ) {}

  load(): JobRecord[] {
    if (!existsSync(this.filePath)) return [];

    try {
      const document = JSON.parse(
        readFileSync(this.filePath, 'utf8')
      ) as StoreDocument;
      if (document.version !== 1 || !Array.isArray(document.jobs)) return [];
      return document.jobs
        .map((job) =>
          normalizeJob(job, this.persistOutput, this.persistMetadata)
        )
        .filter((job): job is JobRecord => Boolean(job));
    } catch {
      return [];
    }
  }

  save(jobs: JobRecord[]): void {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });

    const document: StoreDocument = {
      version: 1,
      savedAt: new Date().toISOString(),
      jobs: jobs.map((job) => this.serialize(job)),
    };

    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(document, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (process.platform !== 'win32') chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.filePath);
    if (process.platform !== 'win32') chmodSync(this.filePath, 0o600);
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
    target: raw.target,
    state: raw.state,
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
  };
}

function isJobState(value: unknown): value is JobState {
  return (
    typeof value === 'string' &&
    (TERMINAL_JOB_STATES.has(value as JobState) ||
      value === 'queued' ||
      value === 'running')
  );
}

function isPublicTarget(value: unknown): value is PublicJobTarget {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as PublicJobTarget).kind;
  return kind === 'local' || kind === 'ssh';
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
