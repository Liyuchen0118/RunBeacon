import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';

const SENSITIVE_KEY =
  /pass(word|phrase)?|private.?key|token|secret|credential|authorization|api.?key|access.?key|cookie/i;
const MAX_LOG_STRING_LENGTH = 4096;
const MAX_LOG_DEPTH = 6;
const MAX_LOG_KEYS = 100;
const MAX_LOG_ARRAY_ITEMS = 100;
const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';

function redactLogString(value: string): string {
  let redacted = value
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
      REDACTED
    )
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,255}\b/g, REDACTED)
    .replace(/\bglpat-[A-Za-z0-9_-]{20,255}\b/g, REDACTED)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/\bAIza[0-9A-Za-z_-]{30,60}\b/g, REDACTED)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/g, REDACTED)
    .replace(/\bsk_live_[A-Za-z0-9]{16,255}\b/g, REDACTED)
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi,
      `$1${REDACTED}@`
    )
    .replace(
      /((?:authorization|proxy-authorization)\s*[:=]\s*)(?:basic|bearer)?\s*[^\s,;}]+/gi,
      `$1${REDACTED}`
    )
    .replace(/\b(basic|bearer)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/((?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+/gi, `$1${REDACTED}`)
    .replace(
      /((?:--?(?:password|passwd|passphrase|token|api[-_]?key|secret|client[-_]?secret|access[-_]?key|github[-_]?token)|-pw)\s*(?:=|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      `$1${REDACTED}`
    )
    .replace(
      /(\b[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|PASSPHRASE|TOKEN|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|COOKIE)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;]+)/g,
      `$1${REDACTED}`
    )
    .replace(
      /([?&](?:access_token|token|api_key|secret|password)=)[^&#\s]+/gi,
      `$1${REDACTED}`
    );

  if (redacted.length > MAX_LOG_STRING_LENGTH) {
    redacted = `${redacted.slice(
      0,
      MAX_LOG_STRING_LENGTH - TRUNCATED.length
    )}${TRUNCATED}`;
  }
  return redacted;
}

function redactLogValue(
  value: unknown,
  key = '',
  seen = new WeakSet<object>(),
  depth = 0
): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return redactLogString(value);
  }
  if (typeof value === 'bigint') return redactLogString(value.toString());
  if (typeof value !== 'object') return value;
  if (depth >= MAX_LOG_DEPTH || seen.has(value)) return TRUNCATED;
  seen.add(value);

  if (value instanceof Error) {
    const safeError: Record<string, unknown> = {
      name: redactLogString(value.name),
      message: redactLogString(value.message),
    };
    if (value.stack) safeError.stack = redactLogString(value.stack);
    if ('cause' in value) {
      safeError.cause = redactLogValue(value.cause, 'cause', seen, depth + 1);
    }
    const errorKeys = Object.keys(value).filter(
      (childKey) => !(childKey in safeError) && childKey !== 'cause'
    );
    const remainingSlots = MAX_LOG_KEYS - Object.keys(safeError).length;
    const keptErrorKeys = errorKeys.slice(
      0,
      errorKeys.length > remainingSlots
        ? Math.max(0, remainingSlots - 1)
        : remainingSlots
    );
    for (const childKey of keptErrorKeys) {
      if (childKey in safeError || childKey === 'cause') continue;
      safeError[childKey] = redactObjectProperty(value, childKey, seen, depth);
    }
    if (errorKeys.length > keptErrorKeys.length) {
      safeError.__truncated__ = TRUNCATED;
    }
    return safeError;
  }

  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[BINARY ${value.byteLength} bytes]`;
  }

  if (Array.isArray(value)) {
    const keptItems =
      value.length > MAX_LOG_ARRAY_ITEMS
        ? MAX_LOG_ARRAY_ITEMS - 1
        : MAX_LOG_ARRAY_ITEMS;
    const result = value
      .slice(0, keptItems)
      .map((item) => redactLogValue(item, key, seen, depth + 1));
    if (value.length > MAX_LOG_ARRAY_ITEMS) result.push(TRUNCATED);
    return result;
  }

  const result: Record<string, unknown> = {};
  const childKeys = Object.keys(value);
  const keptKeys =
    childKeys.length > MAX_LOG_KEYS ? MAX_LOG_KEYS - 1 : MAX_LOG_KEYS;
  for (const childKey of childKeys.slice(0, keptKeys)) {
    result[childKey] = redactObjectProperty(value, childKey, seen, depth);
  }
  if (childKeys.length > MAX_LOG_KEYS) result.__truncated__ = TRUNCATED;
  return result;
}

function redactObjectProperty(
  value: object,
  childKey: string,
  seen: WeakSet<object>,
  depth: number
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, childKey);
    if (descriptor && !('value' in descriptor)) return TRUNCATED;
    return redactLogValue(
      descriptor
        ? descriptor.value
        : (value as Record<string, unknown>)[childKey],
      childKey,
      seen,
      depth + 1
    );
  } catch {
    return TRUNCATED;
  }
}

const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (key !== 'level') {
      info[key] = redactLogValue(info[key], key);
    }
  }

  const splat = Symbol.for('splat');
  if (Array.isArray(info[splat])) {
    info[splat] = info[splat].map((value: unknown) => redactLogValue(value));
  }
  return info;
});

export class Logger {
  private static instance: Logger;
  private logger: winston.Logger;

  constructor(context: string) {
    // Detect if we're running as an MCP server (stdio transport)
    const isMCPServer =
      process.env.MCP_SERVER_MODE === 'true' ||
      process.argv.includes('--mcp-server') ||
      this.detectStdioMCPMode();

    const transports: winston.transport[] = [];

    // CRITICAL: Never log to console/stdout/stderr in MCP mode to avoid stdio corruption
    if (!isMCPServer) {
      transports.push(
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          ),
        })
      );
    }

    // MCP file logging is deliberately opt-in. Console commands and SSH
    // failures can contain sensitive values, so a stdio server must not leave
    // persistent logs merely because it was started.
    const configuredLogDir = process.env.MCP_LOG_DIR?.trim();
    if (configuredLogDir) {
      const logDir = path.resolve(configuredLogDir);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
      }

      transports.push(
        new winston.transports.File({
          filename: path.join(logDir, 'mcp-error.log'),
          level: 'error',
          options: { mode: 0o600 },
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
        }),
        new winston.transports.File({
          filename: path.join(logDir, 'mcp-combined.log'),
          options: { mode: 0o600 },
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
        })
      );
    }

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        redactFormat(),
        winston.format.json()
      ),
      defaultMeta: {
        service: 'mcp-console',
        context: redactLogString(context),
        mcpMode: isMCPServer,
      },
      transports,
      // Never write application logs to stdout in MCP mode. Stdout belongs
      // exclusively to the JSON-RPC transport.
      silent: isMCPServer && transports.length === 0,
    });
  }

  private detectStdioMCPMode(): boolean {
    // Detect if we're likely running as an MCP server via stdio
    return process.stdin.isTTY === false && process.stdout.isTTY === false;
  }

  info(message: string, meta?: any) {
    this.write('info', message, meta);
  }

  error(message: string, meta?: any) {
    this.write('error', message, meta);
  }

  warn(message: string, meta?: any) {
    this.write('warn', message, meta);
  }

  debug(message: string, meta?: any) {
    this.write('debug', message, meta);
  }

  private write(
    level: 'info' | 'error' | 'warn' | 'debug',
    message: string,
    meta?: unknown
  ): void {
    const safeMessage = redactLogString(String(message));
    if (meta === undefined) {
      this.logger[level](safeMessage);
      return;
    }
    const safeMeta = redactLogValue(meta);
    this.logger[level](safeMessage, safeMeta);
  }

  getWinstonLogger(): winston.Logger {
    return this.logger;
  }

  static getInstance(context: string = 'default'): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(context);
    }
    return Logger.instance;
  }
}
