import { createHmac } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export type EventSubscriptionKind = 'codex' | 'desktop' | 'webhook';

export interface EventSubscription {
  id: string;
  kind: EventSubscriptionKind;
  enabled: boolean;
  url?: string;
  hmacSecretEnvVar?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveEventSubscription {
  id: string;
  kind: EventSubscriptionKind;
  enabled?: boolean;
  url?: string;
  hmacSecretEnvVar?: string;
}

export interface TerminalEvent {
  event: 'job_terminal';
  jobId: string;
  state: string;
  finishedAt: string;
}

interface SubscriptionDocument {
  version: 1;
  subscriptions: EventSubscription[];
}

export class EventSubscriptionStore {
  private readonly subscriptions = new Map<string, EventSubscription>();

  constructor(private readonly path: string) {
    this.load();
  }

  list(): EventSubscription[] {
    return Array.from(this.subscriptions.values(), (item) => ({
      ...item,
    })).sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): EventSubscription {
    const subscription = this.subscriptions.get(id);
    if (!subscription) throw new Error(`Unknown event subscription: ${id}`);
    return { ...subscription };
  }

  save(input: SaveEventSubscription): EventSubscription {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(input.id)) {
      throw new Error('subscription id must contain 1 to 64 safe characters');
    }
    if (!['codex', 'desktop', 'webhook'].includes(input.kind)) {
      throw new Error('unsupported event subscription kind');
    }
    if (input.kind === 'webhook') {
      let url: URL;
      try {
        url = new URL(input.url ?? '');
      } catch {
        throw new Error('webhook subscription requires a valid HTTPS URL');
      }
      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error(
          'webhook subscription requires an HTTPS URL without userinfo'
        );
      }
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.hmacSecretEnvVar ?? '')
      ) {
        throw new Error(
          'webhook subscription requires a valid HMAC secret environment variable reference'
        );
      }
    }
    const existing = this.subscriptions.get(input.id);
    const now = new Date().toISOString();
    const saved: EventSubscription = {
      id: input.id,
      kind: input.kind,
      enabled: input.enabled !== false,
      url: input.kind === 'webhook' ? input.url : undefined,
      hmacSecretEnvVar:
        input.kind === 'webhook' ? input.hmacSecretEnvVar : undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.subscriptions.set(saved.id, saved);
    this.persist();
    return saved;
  }

  delete(id: string): EventSubscription {
    const existing = this.get(id);
    this.subscriptions.delete(id);
    this.persist();
    return existing;
  }

  validateIds(ids: string[] | undefined): string[] {
    const unique = Array.from(new Set(ids ?? []));
    if (unique.length > 16)
      throw new Error('at most 16 event subscriptions are allowed');
    for (const id of unique) this.get(id);
    return unique;
  }

  async dispatch(
    ids: string[],
    event: TerminalEvent
  ): Promise<Array<{ id: string; delivered: boolean; error?: string }>> {
    const body = JSON.stringify(event);
    return Promise.all(
      ids.map(async (id) => {
        const subscription = this.get(id);
        if (!subscription.enabled || subscription.kind === 'codex') {
          return { id, delivered: subscription.enabled };
        }
        if (subscription.kind === 'desktop') {
          // Desktop delivery is consumed by the Codex host integration. The
          // daemon records the durable event even when no host is attached.
          return { id, delivered: true };
        }
        const secret = process.env[subscription.hmacSecretEnvVar!];
        if (!secret) {
          return {
            id,
            delivered: false,
            error: 'HMAC secret reference is unavailable',
          };
        }
        const signature = createHmac('sha256', secret)
          .update(body)
          .digest('hex');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        timer.unref?.();
        try {
          const response = await fetch(subscription.url!, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-runbeacon-signature': `sha256=${signature}`,
            },
            body,
            signal: controller.signal,
          });
          return response.ok
            ? { id, delivered: true }
            : { id, delivered: false, error: `HTTP ${response.status}` };
        } catch (error) {
          return {
            id,
            delivered: false,
            error:
              error instanceof Error
                ? error.message.slice(0, 240)
                : 'delivery failed',
          };
        } finally {
          clearTimeout(timer);
        }
      })
    );
  }

  private load(): void {
    try {
      const document = JSON.parse(
        readFileSync(this.path, 'utf8')
      ) as SubscriptionDocument;
      if (document.version !== 1 || !Array.isArray(document.subscriptions))
        return;
      for (const item of document.subscriptions) {
        if (!isStoredSubscription(item)) continue;
        this.subscriptions.set(item.id, { ...item });
      }
    } catch {
      // Missing or malformed configuration starts with no subscriptions.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    const document: SubscriptionDocument = {
      version: 1,
      subscriptions: this.list(),
    };
    writeFileSync(temporary, JSON.stringify(document, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (process.platform !== 'win32') chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    if (process.platform !== 'win32') chmodSync(this.path, 0o600);
  }
}

function isStoredSubscription(value: unknown): value is EventSubscription {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<EventSubscription>;
  if (
    typeof item.id !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(item.id) ||
    !['codex', 'desktop', 'webhook'].includes(String(item.kind)) ||
    typeof item.enabled !== 'boolean' ||
    typeof item.createdAt !== 'string' ||
    typeof item.updatedAt !== 'string'
  ) {
    return false;
  }
  if (item.kind !== 'webhook') return true;
  try {
    const url = new URL(item.url ?? '');
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item.hmacSecretEnvVar ?? '')
    );
  } catch {
    return false;
  }
}
