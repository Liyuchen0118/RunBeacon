export type JobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'orphaned';

export type JobOutputStream = 'stdout' | 'stderr' | 'system';

export interface JobOutputChunk {
  sequence: number;
  stream: JobOutputStream;
  data: string;
  timestamp: string;
}

export interface JobProgress {
  percentage?: number;
  phase?: string;
  message?: string;
  updatedAt: string;
}

export interface LifecycleAssessment {
  phase: 'waiting' | 'executing' | 'finished';
  health: 'queued' | 'active' | 'stalled' | 'terminal';
  elapsedMs: number;
  idleMs: number;
  estimatedRemainingMs?: number;
  summary: string;
}

export interface LocalJobTarget {
  kind: 'local';
}

export interface SshJobTarget {
  kind: 'ssh';
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  agent?: string;
  hostKeySha256?: string;
  allowUnverifiedHostKey?: boolean;
  /** Kept in memory only and never copied to JobRecord or the persistent store. */
  password?: string;
  passphrase?: string;
}

export type JobTarget = LocalJobTarget | SshJobTarget;

export interface StartJobInput {
  command: string;
  /** Stable caller-provided key that prevents duplicate starts after retries. */
  idempotencyKey?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean;
  label?: string;
  timeoutMs?: number;
  target?: JobTarget;
  progressPattern?: string;
  metadata?: Record<string, unknown>;
}

export interface PublicJobTarget {
  kind: 'local' | 'ssh';
  host?: string;
  port?: number;
  username?: string;
  verifiedHostKey?: boolean;
}

export interface JobRecord {
  id: string;
  idempotencyKey?: string;
  label: string;
  displayCommand: string;
  target: PublicJobTarget;
  state: JobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  version: number;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  cancelRequested?: boolean;
  cancellationVerified?: boolean;
  progress?: JobProgress;
  lastOutputAt?: string;
  lastProgressAt?: string;
  output: JobOutputChunk[];
  outputBytes: number;
  outputLines: number;
  outputTruncated: boolean;
  metadata?: Record<string, unknown>;
}

export interface JobSnapshot extends Omit<JobRecord, 'output'> {
  tail: JobOutputChunk[];
  assessment: LifecycleAssessment;
}

export interface WaitResult {
  timedOut: boolean;
  job: JobSnapshot;
}

export const TERMINAL_JOB_STATES = new Set<JobState>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'orphaned',
]);

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.has(state);
}
