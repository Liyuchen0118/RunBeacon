const SECRET_FLAG =
  /(--?(?:pass(?:word|phrase)?|token|secret|credential|authorization|api[-_]?key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;

const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^@\s/]+)(@)/gi;

const SECRET_ENV_ASSIGNMENT =
  /\b((?:[A-Z0-9_]*(?:PASS(?:WORD|PHRASE)?|TOKEN|SECRET|CREDENTIAL|AUTHORIZATION|API_?KEY)[A-Z0-9_]*)=)("[^"]*"|'[^']*'|\S+)/gi;

const SENSITIVE_METADATA_KEY =
  /(?:pass(?:word|phrase)?|token|secret|credential|authorization|api[-_]?key|private[-_]?key)/i;

const MAX_METADATA_DEPTH = 6;
const MAX_METADATA_ENTRIES = 100;
const MAX_PERSISTED_STRING_LENGTH = 4_000;

export function redactCommand(command: string): string {
  return command
    .replace(SECRET_FLAG, '$1[REDACTED]')
    .replace(SECRET_ENV_ASSIGNMENT, '$1[REDACTED]')
    .replace(URL_CREDENTIALS, '$1[REDACTED]$3')
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]'
    );
}

export function redactPersistedText(
  value: string,
  maxLength = MAX_PERSISTED_STRING_LENGTH
): string {
  return redactCommand(value).slice(0, Math.max(0, maxLength));
}

export function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const seen = new WeakSet<object>();
  const sanitized = sanitizeValue(metadata, 0, seen);
  return isPlainRecord(sanitized) ? sanitized : undefined;
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>
): unknown {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (typeof value === 'string') return redactPersistedText(value);
  if (typeof value !== 'object') return String(value).slice(0, 200);
  if (depth >= MAX_METADATA_DEPTH) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_METADATA_ENTRIES)
      .map((item) => sanitizeValue(item, depth + 1, seen));
  }

  const entries = Object.entries(value as Record<string, unknown>).slice(
    0,
    MAX_METADATA_ENTRIES
  );
  return Object.fromEntries(
    entries.map(([key, item]) => [
      key.slice(0, 200),
      SENSITIVE_METADATA_KEY.test(key)
        ? '[REDACTED]'
        : sanitizeValue(item, depth + 1, seen),
    ])
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactPersistedText(message);
}
