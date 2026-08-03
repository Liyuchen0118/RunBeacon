import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as winston from 'winston';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'console-automation-logs-')
);

process.env.MCP_SERVER_MODE = 'true';
process.env.MCP_LOG_DIR = logDirectory;
process.env.LOG_LEVEL = 'debug';

try {
  const { Logger } = await import('../dist/utils/logger.js');
  const logger = new Logger('redaction-smoke');
  const winstonLogger = logger.getWinstonLogger();
  const sinkChunks = [];
  winstonLogger.add(
    new winston.transports.Stream({
      stream: new Writable({
        write(chunk, _encoding, callback) {
          sinkChunks.push(String(chunk));
          callback();
        },
      }),
    })
  );

  const secrets = {
    message: `ghp_${'A'.repeat(36)}`,
    metadata: 'metadata-password-canary',
    error: 'error-authorization-canary',
    cause: 'cause-token-canary',
    stack: 'stack-environment-canary',
    header: 'header-authorization-canary',
    cookie: 'cookie-canary',
    url: 'url-userinfo-canary',
    command: 'command-password-canary',
    environment: 'environment-token-canary',
    privateKey: 'private-key-body-canary',
    cloud: 'AKIAABCDEFGHIJKLMNOP',
    cycle: 'cycle-token-canary',
    long: 'long-string-tail-canary',
    arrayLimit: 'array-limit-canary',
    objectLimit: 'object-limit-canary',
  };

  logger.info(`Message PAT ${secrets.message}`, {
    password: secrets.metadata,
    nested: {
      safeValue: 'visible-value',
    },
  });
  const cause = new Error(`deploy --token ${secrets.cause}`);
  const error = new Error(`Authorization: Bearer ${secrets.error}`, { cause });
  error.stack = `Error: request failed\nAWS_SECRET_ACCESS_KEY=${secrets.stack}`;
  logger.error('Error object test', error);
  logger.warn('Request object test', {
    headers: {
      authorization: `Bearer ${secrets.header}`,
      cookie: `session=${secrets.cookie}`,
      'x-safe-header': 'visible-header',
    },
    url: `https://user:${secrets.url}@example.com/path`,
    command: `deploy --password ${secrets.command}`,
    environment: `GITHUB_TOKEN=${secrets.environment}`,
    pem: `-----BEGIN PRIVATE KEY-----\n${secrets.privateKey}\n-----END PRIVATE KEY-----`,
    cloudAccessKey: secrets.cloud,
  });

  const cyclic = { safeCycleValue: 'visible-cycle', token: secrets.cycle };
  cyclic.self = cyclic;
  logger.debug('Cyclic object test', cyclic);

  const oversizedArray = Array.from({ length: 101 }, (_, index) => index);
  oversizedArray[100] = secrets.arrayLimit;
  const oversizedObject = Object.fromEntries(
    Array.from({ length: 101 }, (_, index) => [`safe_${index}`, index])
  );
  oversizedObject.safe_100 = secrets.objectLimit;
  logger.info('Limit test', {
    long: `${'x'.repeat(5000)}${secrets.long}`,
    oversizedArray,
    oversizedObject,
  });

  const finished = once(winstonLogger, 'finish');
  winstonLogger.end();
  await finished;

  const combinedLog = fs.readFileSync(
    path.join(logDirectory, 'mcp-combined.log'),
    'utf8'
  );
  const sinkOutput = sinkChunks.join('');
  for (const [name, secret] of Object.entries(secrets)) {
    assert.equal(combinedLog.includes(secret), false, `${name} leaked to file`);
    assert.equal(sinkOutput.includes(secret), false, `${name} leaked to sink`);
  }
  for (const safeValue of [
    'visible-value',
    'visible-header',
    'visible-cycle',
  ]) {
    assert.match(combinedLog, new RegExp(safeValue));
    assert.match(sinkOutput, new RegExp(safeValue));
  }
  assert.match(combinedLog, /\[REDACTED\]/);
  assert.match(combinedLog, /\[TRUNCATED\]/);

  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(logDirectory, 'mcp-combined.log')).mode;
    assert.equal(mode & 0o077, 0, 'file log permissions must be 0600');
  }

  process.stdout.write(
    `${JSON.stringify({ structuredLogRedaction: 'passed' })}\n`
  );
} finally {
  fs.rmSync(logDirectory, { recursive: true, force: true });
}
