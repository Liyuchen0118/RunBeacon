'use strict';

const { createHash, randomUUID } = require('node:crypto');
const {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');

const TRACE_TTL_MS = 30 * 60 * 1000;
const MAX_TRACE_FILES = 256;
const MAX_STATE_BYTES = 4 * 1024;

function rememberPendingTrace(event, now = new Date()) {
  const location = traceLocation(event);
  if (!location) return undefined;
  ensureTraceDirectory(location.directory);
  clearSessionFiles(location.directory, location.sessionPrefix);
  cleanupTraceDirectory(location.directory, now.getTime());

  const trace = {
    version: 1,
    sessionHash: location.sessionHash,
    turnHash: location.turnHash,
    requestTraceId: randomUUID(),
    requestReceivedAt: now.toISOString(),
    createdAt: now.toISOString(),
  };
  const temporaryPath = `${location.filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(trace), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    if (process.platform !== 'win32') chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, location.filePath);
    if (process.platform !== 'win32') chmodSync(location.filePath, 0o600);
    cleanupTraceDirectory(location.directory, now.getTime());
    return trace;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function readPendingTrace(event, now = new Date()) {
  const location = traceLocation(event);
  if (!location) return undefined;
  try {
    let serialized;
    const descriptor = openSync(location.filePath, 'r');
    try {
      const stats = fstatSync(descriptor);
      if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_STATE_BYTES) {
        throw new Error('Invalid pending trace file');
      }
      serialized = readFileSync(descriptor, 'utf8');
    } finally {
      closeSync(descriptor);
    }
    const trace = JSON.parse(serialized);
    const createdAt = Date.parse(trace.createdAt);
    const requestReceivedAt = Date.parse(trace.requestReceivedAt);
    const ageMs = now.getTime() - createdAt;
    if (
      trace.version !== 1 ||
      trace.sessionHash !== location.sessionHash ||
      trace.turnHash !== location.turnHash ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        trace.requestTraceId
      ) ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(requestReceivedAt) ||
      ageMs < -5 * 60 * 1000 ||
      ageMs > TRACE_TTL_MS
    ) {
      rmSync(location.filePath, { force: true });
      return undefined;
    }
    return {
      requestTraceId: trace.requestTraceId,
      requestReceivedAt: new Date(requestReceivedAt).toISOString(),
    };
  } catch {
    rmSync(location.filePath, { force: true });
    return undefined;
  }
}

function clearPendingTracesForSession(event) {
  const location = traceLocation(event);
  if (!location || !existsSync(location.directory)) return;
  clearSessionFiles(location.directory, location.sessionPrefix);
  cleanupTraceDirectory(location.directory, Date.now());
}

function traceLocation(event) {
  const dataRoot = String(
    process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || ''
  ).trim();
  const sessionId = validHookId(event?.session_id);
  const turnId = validHookId(event?.turn_id);
  if (!dataRoot || !sessionId || !turnId) return undefined;
  const sessionHash = digest(sessionId);
  const turnHash = digest(turnId);
  const sessionPrefix = `${sessionHash}-`;
  const directory = join(dataRoot, 'hook-state', 'pending-traces');
  return {
    directory,
    filePath: join(directory, `${sessionPrefix}${turnHash}.json`),
    sessionHash,
    turnHash,
    sessionPrefix,
  };
}

function validHookId(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 512 ? trimmed : undefined;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function ensureTraceDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
}

function clearSessionFiles(directory, sessionPrefix) {
  for (const name of safeTraceFiles(directory)) {
    if (name.startsWith(sessionPrefix)) {
      rmSync(join(directory, name), { force: true });
    }
  }
}

function cleanupTraceDirectory(directory, nowMs) {
  const retained = [];
  for (const name of safeTraceFiles(directory)) {
    const filePath = join(directory, name);
    try {
      const stats = statSync(filePath);
      if (nowMs - stats.mtimeMs > TRACE_TTL_MS) {
        rmSync(filePath, { force: true });
      } else {
        retained.push({ filePath, mtimeMs: stats.mtimeMs });
      }
    } catch {
      // Another hook process may have completed cleanup first.
    }
  }
  retained.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const entry of retained.slice(MAX_TRACE_FILES)) {
    rmSync(entry.filePath, { force: true });
  }
}

function safeTraceFiles(directory) {
  try {
    return readdirSync(directory).filter((name) =>
      /^[0-9a-f]{32}-[0-9a-f]{32}\.json$/.test(name)
    );
  } catch {
    return [];
  }
}

module.exports = {
  clearPendingTracesForSession,
  readPendingTrace,
  rememberPendingTrace,
};
