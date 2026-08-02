#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { createServer, Socket } from 'node:net';
import { LifecycleManager } from '../lifecycle/LifecycleManager.js';
import { ensureDaemonToken, getDaemonPaths } from '../lifecycle/DaemonPaths.js';
import { safeErrorMessage } from '../lifecycle/security.js';
import { StartJobInput } from '../lifecycle/types.js';

process.env.MCP_SERVER_MODE = 'true';

const dataDirIndex = process.argv.indexOf('--data-dir');
const dataDir =
  dataDirIndex >= 0 ? process.argv[dataDirIndex + 1] : process.env.PLUGIN_DATA;
if (!dataDir) throw new Error('--data-dir is required');

const paths = getDaemonPaths(dataDir);
const token = ensureDaemonToken(paths);
const manager = new LifecycleManager({
  statePath: process.env.RJM_STATE_PATH || paths.statePath,
  maxConcurrentJobs: Number(process.env.RJM_MAX_CONCURRENT_JOBS || 4),
  maxOutputBytes: Number(process.env.RJM_MAX_OUTPUT_BYTES || 1024 * 1024),
  persistOutput: process.env.RJM_PERSIST_OUTPUT === 'true',
});

interface RpcRequest {
  id: string;
  token: string;
  method: string;
  args?: Record<string, any>;
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
  socket.write(`${JSON.stringify({ id, result, error })}\n`);
  socket.end();
}

async function handle(socket: Socket, request: RpcRequest): Promise<void> {
  if (!tokenMatches(request.token)) {
    respond(socket, request.id, undefined, 'Unauthorized daemon request');
    return;
  }
  const args = request.args ?? {};
  try {
    switch (request.method) {
      case 'ping':
        respond(socket, request.id, { ready: true, pid: process.pid });
        break;
      case 'start':
        respond(socket, request.id, manager.start(args.input as StartJobInput));
        break;
      case 'wait':
        respond(
          socket,
          request.id,
          await manager.waitForTerminal(args.jobId, args.timeoutMs, args.tailLines)
        );
        break;
      case 'snapshot':
        respond(socket, request.id, manager.snapshot(args.jobId, args.tailLines));
        break;
      case 'list':
        respond(socket, request.id, manager.list(args.tailLines));
        break;
      case 'cancel':
        respond(socket, request.id, manager.cancel(args.jobId));
        break;
      case 'shutdown':
        respond(socket, request.id, { stopped: true });
        setTimeout(() => process.exit(0), 25).unref();
        break;
      default:
        respond(socket, request.id, undefined, `Unknown daemon method: ${request.method}`);
    }
  } catch (error) {
    respond(socket, request.id, undefined, safeErrorMessage(error));
  }
}

const server = createServer((socket) => {
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
      void handle(socket, request);
    } catch {
      socket.destroy();
    }
  });
});

if (process.platform !== 'win32' && existsSync(paths.socketPath)) {
  rmSync(paths.socketPath, { force: true });
}
server.listen(paths.socketPath, () => {
  if (process.platform !== 'win32') chmodSync(paths.socketPath, 0o600);
});
