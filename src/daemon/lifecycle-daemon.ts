#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer, Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { LifecycleManager } from '../lifecycle/LifecycleManager.js';
import {
  compareBuildVersions,
  readPluginBuildVersion,
  validateBuildVersion,
} from '../lifecycle/BuildIdentity.js';
import { ensureDaemonToken, getDaemonPaths } from '../lifecycle/DaemonPaths.js';
import { safeErrorMessage } from '../lifecycle/security.js';
import { StartJobInput } from '../lifecycle/types.js';
import {
  DAEMON_PROTOCOL_VERSION,
  RUNBEACON_VERSION,
} from '../lifecycle/protocol.js';

process.env.MCP_SERVER_MODE = 'true';

const dataDirIndex = process.argv.indexOf('--data-dir');
const dataDir =
  dataDirIndex >= 0 ? process.argv[dataDirIndex + 1] : process.env.PLUGIN_DATA;
if (!dataDir) throw new Error('--data-dir is required');

const paths = getDaemonPaths(dataDir);
const token = ensureDaemonToken(paths);
const buildId = createHash('sha256')
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest('hex');
const buildVersion = readPluginBuildVersion(import.meta.url);
let shuttingDown = false;
const manager = new LifecycleManager({
  statePath: process.env.RJM_STATE_PATH || paths.statePath,
  maxConcurrentJobs: Number(process.env.RJM_MAX_CONCURRENT_JOBS || 4),
  maxOutputBytes: Number(process.env.RJM_MAX_OUTPUT_BYTES || 1024 * 1024),
  persistOutput: process.env.RJM_PERSIST_OUTPUT === 'true',
  persistMetadata: process.env.RJM_PERSIST_METADATA === 'true',
  persistenceDebounceMs: Number(process.env.RJM_PERSIST_DEBOUNCE_MS || 250),
  maxRetainedJobs: Number(process.env.RJM_MAX_RETAINED_JOBS || 1000),
  cancellationGraceMs: Number(process.env.RJM_CANCEL_GRACE_MS || 5000),
  sshHandshakeAttempts: Number(process.env.RJM_SSH_HANDSHAKE_ATTEMPTS || 5),
  sshRetryBaseDelayMs: Number(process.env.RJM_SSH_RETRY_BASE_DELAY_MS || 250),
  sshReadyTimeoutMs: Number(process.env.RJM_SSH_READY_TIMEOUT_MS || 12_000),
});

interface RpcRequest {
  id: string;
  token: string;
  method: string;
  args?: Record<string, unknown>;
}

function tokenMatches(candidate: string): boolean {
  const expectedBuffer = Buffer.from(token);
  const candidateBuffer = Buffer.from(candidate || '');
  return (
    expectedBuffer.length === candidateBuffer.length &&
    timingSafeEqual(expectedBuffer, candidateBuffer)
  );
}

function respond(socket: Socket, id: string, result?: unknown, error?: string) {
  if (socket.destroyed || socket.writableEnded) return;
  socket.write(`${JSON.stringify({ id, result, error })}\n`);
  socket.end();
}

async function handle(
  socket: Socket,
  request: RpcRequest,
  signal: AbortSignal
): Promise<void> {
  if (!tokenMatches(request.token)) {
    respond(socket, request.id, undefined, 'Unauthorized daemon request');
    return;
  }
  if (shuttingDown && request.method !== 'ping') {
    respond(socket, request.id, undefined, 'RunBeacon daemon is restarting');
    return;
  }
  const args = request.args ?? {};
  try {
    switch (request.method) {
      case 'ping':
        respond(socket, request.id, {
          ready: true,
          pid: process.pid,
          version: RUNBEACON_VERSION,
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          buildId,
          buildVersion,
          runtime: manager.runtimeStatus(),
          persistence: manager.persistenceStatus(),
        });
        break;
      case 'start':
        respond(socket, request.id, manager.start(args.input as StartJobInput));
        break;
      case 'wait':
        respond(
          socket,
          request.id,
          await manager.waitForTerminal(
            String(args.jobId),
            args.timeoutMs as number | undefined,
            args.tailLines as number | undefined,
            signal
          )
        );
        break;
      case 'snapshot':
        respond(
          socket,
          request.id,
          manager.snapshot(
            String(args.jobId),
            args.tailLines as number | undefined
          )
        );
        break;
      case 'list':
        respond(
          socket,
          request.id,
          manager.list(
            args.tailLines as number | undefined,
            args.limit as number | undefined
          )
        );
        break;
      case 'cancel':
        respond(socket, request.id, manager.cancel(String(args.jobId)));
        break;
      case 'shutdown':
        if (args.replacement) {
          const replacement = args.replacement as Record<string, unknown>;
          const expectedBuildId = String(args.expectedBuildId ?? '');
          const replacementProtocol = Number(replacement.protocolVersion);
          const replacementBuildVersion = validateBuildVersion(
            String(replacement.buildVersion ?? '')
          );
          const isNewer =
            replacementProtocol > DAEMON_PROTOCOL_VERSION ||
            (replacementProtocol === DAEMON_PROTOCOL_VERSION &&
              compareBuildVersions(replacementBuildVersion, buildVersion) > 0);
          if (expectedBuildId !== buildId || !isNewer) {
            respond(
              socket,
              request.id,
              undefined,
              'Refusing a stale, same-version, or downgrade daemon replacement'
            );
            break;
          }
        }
        const runtime = manager.runtimeStatus();
        if (runtime.activeJobs > 0 || runtime.queuedJobs > 0) {
          respond(
            socket,
            request.id,
            undefined,
            `Cannot restart RunBeacon daemon while ${runtime.activeJobs} job(s) are active and ${runtime.queuedJobs} are queued`
          );
          break;
        }
        shuttingDown = true;
        respond(socket, request.id, { stopped: true });
        server.close(() => {
          manager.dispose();
          process.exit(0);
        });
        setTimeout(() => process.exit(0), 500).unref();
        break;
      default:
        respond(
          socket,
          request.id,
          undefined,
          `Unknown daemon method: ${request.method}`
        );
    }
  } catch (error) {
    respond(socket, request.id, undefined, safeErrorMessage(error));
  }
}

const server = createServer((socket) => {
  const abortController = new AbortController();
  socket.once('close', () => abortController.abort());
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) {
      socket.destroy();
      return;
    }
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    try {
      const request = JSON.parse(buffer.slice(0, newline)) as RpcRequest;
      void handle(socket, request, abortController.signal);
    } catch {
      socket.destroy();
    }
  });
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') process.exitCode = 0;
  else process.exitCode = 1;
});

if (process.platform !== 'win32' && existsSync(paths.socketPath)) {
  rmSync(paths.socketPath, { force: true });
}
server.listen(paths.socketPath, () => {
  if (process.platform !== 'win32') chmodSync(paths.socketPath, 0o600);
});
