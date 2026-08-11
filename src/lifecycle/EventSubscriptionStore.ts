import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
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
  urlEnvVar?: string;
  hmacSecretEnvVar?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveEventSubscription {
  id: string;
  kind: EventSubscriptionKind;
  enabled?: boolean;
  urlEnvVar?: string;
  hmacSecretEnvVar?: string;
}

export interface TerminalEvent {
  event: 'job_terminal';
  jobId: string;
  state: string;
  finishedAt: string;
}

interface SubscriptionDocument {
  version: 2;
  subscriptions: EventSubscription[];
}

const ENVIRONMENT_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const TERMINAL_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL_STATES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);

export type DesktopNotifier = (title: string, body: string) => Promise<void>;

export class EventSubscriptionStore {
  private readonly subscriptions = new Map<string, EventSubscription>();

  constructor(
    private readonly path: string,
    private readonly desktopNotifier: DesktopNotifier = sendDesktopNotification
  ) {
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
      if (!ENVIRONMENT_REFERENCE.test(input.urlEnvVar ?? '')) {
        throw new Error(
          'webhook subscription requires a valid URL environment variable reference'
        );
      }
      const configuredUrl = process.env[input.urlEnvVar!];
      if (configuredUrl) validateWebhookUrl(configuredUrl);
      if (!ENVIRONMENT_REFERENCE.test(input.hmacSecretEnvVar ?? '')) {
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
      urlEnvVar: input.kind === 'webhook' ? input.urlEnvVar : undefined,
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
    const body = serializeTerminalEvent(event);
    return Promise.all(
      ids.map(async (id) => {
        const subscription = this.get(id);
        if (!subscription.enabled || subscription.kind === 'codex') {
          return { id, delivered: subscription.enabled };
        }
        if (subscription.kind === 'desktop') {
          try {
            await this.desktopNotifier(
              'RunBeacon job finished',
              `${event.jobId}: ${event.state}`
            );
            return { id, delivered: true };
          } catch {
            return {
              id,
              delivered: false,
              error: 'Desktop notification delivery failed',
            };
          }
        }
        const configuredUrl = process.env[subscription.urlEnvVar!];
        if (!configuredUrl) {
          return {
            id,
            delivered: false,
            error: 'Webhook URL reference is unavailable',
          };
        }
        let webhookUrl: string;
        try {
          webhookUrl = validateWebhookUrl(configuredUrl);
        } catch {
          return {
            id,
            delivered: false,
            error: 'Webhook URL reference is invalid',
          };
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
          const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-runbeacon-signature': `sha256=${signature}`,
            },
            // This opt-in webhook receives only the bounded TerminalEvent allow-list
            // produced above, never persisted command, output, or credential data.
            // lgtm[js/file-access-to-http]
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
      if (document.version !== 2 || !Array.isArray(document.subscriptions))
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
      version: 2,
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

function sendDesktopNotification(title: string, body: string): Promise<void> {
  const safeTitle = boundedNotificationText(title, 80);
  const safeBody = boundedNotificationText(body, 240);
  if (process.platform === 'win32') {
    const script = [
      '$ErrorActionPreference="Stop"',
      '[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null',
      '[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] > $null',
      '$title=[System.Security.SecurityElement]::Escape($env:RUNBEACON_NOTIFICATION_TITLE)',
      '$body=[System.Security.SecurityElement]::Escape($env:RUNBEACON_NOTIFICATION_BODY)',
      '$xml=New-Object Windows.Data.Xml.Dom.XmlDocument',
      '$xml.LoadXml("<toast><visual><binding template=\'ToastGeneric\'><text>$title</text><text>$body</text></binding></visual></toast>")',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("RunBeacon").Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
    ].join(';');
    const systemRoot =
      process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    return runNotifier(
      `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        ...desktopNotificationEnvironment(),
        RUNBEACON_NOTIFICATION_TITLE: safeTitle,
        RUNBEACON_NOTIFICATION_BODY: safeBody,
      }
    );
  }
  if (process.platform === 'darwin') {
    return runNotifier(
      '/usr/bin/osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        '--',
        safeTitle,
        safeBody,
      ],
      desktopNotificationEnvironment()
    );
  }
  return runNotifier(
    '/usr/bin/notify-send',
    ['--app-name=RunBeacon', safeTitle, safeBody],
    desktopNotificationEnvironment()
  );
}

function runNotifier(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('notification timed out'));
    }, 10_000);
    timer.unref?.();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`notification exited with code ${code}`));
    });
  });
}

export function desktopNotificationEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const allowed = new Set(
    [
      'APPDATA',
      'DBUS_SESSION_BUS_ADDRESS',
      'DISPLAY',
      'HOME',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'LOCALAPPDATA',
      'LOGNAME',
      'SYSTEMROOT',
      'TEMP',
      'TMP',
      'TMPDIR',
      'USER',
      'USERPROFILE',
      'WAYLAND_DISPLAY',
      'WINDIR',
      'XDG_RUNTIME_DIR',
    ].map((key) => key.toUpperCase())
  );
  const result: NodeJS.ProcessEnv = {
    PATH:
      process.platform === 'win32'
        ? `${source.SystemRoot || source.WINDIR || 'C:\\Windows'}\\System32`
        : '/usr/bin:/bin',
  };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) {
      result[key] = value;
    }
  }
  return result;
}

function boundedNotificationText(value: string, limit: number): string {
  return String(value)
    .replace(/[\r\n\0\u0001-\u001f\u007f]/g, ' ')
    .slice(0, limit);
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
  return (
    ENVIRONMENT_REFERENCE.test(item.urlEnvVar ?? '') &&
    ENVIRONMENT_REFERENCE.test(item.hmacSecretEnvVar ?? '')
  );
}

function validateWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('webhook subscription requires a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(
      'webhook subscription requires an HTTPS URL without userinfo'
    );
  }
  return url.toString();
}

function serializeTerminalEvent(event: TerminalEvent): string {
  if (
    event.event !== 'job_terminal' ||
    !TERMINAL_JOB_ID.test(event.jobId) ||
    !TERMINAL_STATES.has(event.state) ||
    !isCanonicalTimestamp(event.finishedAt)
  ) {
    throw new Error('invalid terminal event');
  }
  return JSON.stringify({
    event: 'job_terminal',
    jobId: event.jobId,
    state: event.state,
    finishedAt: event.finishedAt,
  });
}

function isCanonicalTimestamp(value: string): boolean {
  if (value.length !== 24) return false;
  const timestamp = new Date(value);
  return (
    Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
  );
}
