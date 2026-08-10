import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface AuditEvent {
  sequence: number;
  timestamp: string;
  action: string;
  outcome: string;
  jobId?: string;
  target?: string;
  risk?: string;
  commandDigest?: string;
  previousHash: string;
  hash: string;
}

export interface AuditQuery {
  jobId?: string;
  action?: string;
  since?: string;
  limit?: number;
}

const ZERO_HASH = '0'.repeat(64);

export class AuditLog {
  private sequence = 0;
  private previousHash = ZERO_HASH;

  constructor(private readonly path: string) {
    this.readVerified().forEach((event) => {
      this.sequence = event.sequence;
      this.previousHash = event.hash;
    });
  }

  append(
    event: Omit<AuditEvent, 'sequence' | 'timestamp' | 'previousHash' | 'hash'>
  ): AuditEvent {
    // Verify the complete chain before every mutation so an external edit can
    // never be hidden by appending a new, apparently valid suffix.
    const verified = this.readVerified();
    const last = verified.at(-1);
    this.sequence = last?.sequence ?? 0;
    this.previousHash = last?.hash ?? ZERO_HASH;
    const payload = {
      sequence: this.sequence + 1,
      timestamp: new Date().toISOString(),
      action: bounded(event.action, 80),
      outcome: bounded(event.outcome, 80),
      jobId: optionalBounded(event.jobId, 128),
      target: optionalBounded(event.target, 256),
      risk: optionalBounded(event.risk, 32),
      commandDigest: normalizeDigest(event.commandDigest),
      previousHash: this.previousHash,
    };
    const record: AuditEvent = {
      ...payload,
      hash: hashPayload(payload),
    };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = openSync(this.path, 'a', 0o600);
    try {
      writeSync(handle, `${JSON.stringify(record)}\n`, undefined, 'utf8');
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    if (process.platform !== 'win32') chmodSync(this.path, 0o600);
    this.sequence = record.sequence;
    this.previousHash = record.hash;
    return record;
  }

  query(query: AuditQuery = {}): AuditEvent[] {
    const since = query.since ? Date.parse(query.since) : Number.NaN;
    const limit = Math.max(1, Math.min(1_000, query.limit ?? 100));
    return this.readVerified()
      .filter(
        (event) =>
          (!query.jobId || event.jobId === query.jobId) &&
          (!query.action || event.action === query.action) &&
          (!Number.isFinite(since) || Date.parse(event.timestamp) >= since)
      )
      .slice(-limit)
      .reverse();
  }

  private readVerified(): AuditEvent[] {
    if (!existsSync(this.path)) return [];
    let previousHash = ZERO_HASH;
    let expectedSequence = 1;
    const verified: AuditEvent[] = [];
    for (const line of readFileSync(this.path, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as AuditEvent;
        const { hash, ...payload } = record;
        if (
          record.sequence !== expectedSequence ||
          record.previousHash !== previousHash ||
          hash !== hashPayload(payload)
        ) {
          throw new AuditIntegrityError();
        }
        verified.push(record);
        previousHash = hash;
        expectedSequence += 1;
      } catch (error) {
        if (error instanceof AuditIntegrityError) throw error;
        throw new AuditIntegrityError();
      }
    }
    return verified;
  }
}

export class AuditIntegrityError extends Error {
  readonly code = 'AUDIT_INTEGRITY_FAILURE';

  constructor() {
    super('AUDIT_INTEGRITY_FAILURE: audit hash chain verification failed');
    this.name = 'AuditIntegrityError';
  }
}

function hashPayload(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function bounded(value: string, limit: number): string {
  return String(value ?? '')
    .replace(/[\r\n\0]/g, ' ')
    .slice(0, limit);
}

function optionalBounded(
  value: string | undefined,
  limit: number
): string | undefined {
  return value ? bounded(value, limit) : undefined;
}

function normalizeDigest(value: string | undefined): string | undefined {
  return value && /^sha256:[0-9a-f]{64}$/i.test(value) ? value : undefined;
}
