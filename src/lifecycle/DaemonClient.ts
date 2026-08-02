import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  DaemonPaths,
  ensureDaemonToken,
  getDaemonPaths,
} from './DaemonPaths.js';
import { JobSnapshot, StartJobInput, WaitResult } from './types.js';
import {
  DAEMON_PROTOCOL_VERSION,
  DaemonPing,
  RUNBEACON_VERSION,
} from './protocol.js';

interface RpcRequest {
  id: string;
  token: string;
  method: string;
  args?: Record<string, unknown>;
}

interface RpcResponse<T> {
  id: string;
  result?: T;
  error?: string;
}

export interface LifecycleService {
  start(input: StartJobInput): Promise<JobSnapshot> | JobSnapshot;
  waitForTerminal(
    jobId: string,
    timeoutMs?: number,
    tailLines?: number,
    signal?: AbortSignal
  ): Promise<WaitResult>;
  snapshot(
    jobId: string,
    tailLines?: number
  ): Promise<JobSnapshot> | JobSnapshot;
  list(
    tailLines?: number,
    limit?: number
  ): Promise<JobSnapshot[]> | JobSnapshot[];
  cancel(jobId: string): Promise<JobSnapshot> | JobSnapshot;
}

export class DaemonClient implements LifecycleService {
  private readonly paths: DaemonPaths;
  private readonly token: string;
  private readonly daemonEntry: string;

  constructor(dataDir: string, daemonEntry?: string) {
    this.paths = getDaemonPaths(dataDir);
    this.token = ensureDaemonToken(this.paths);
    this.daemonEntry =
      daemonEntry ??
      fileURLToPath(new URL('../daemon/lifecycle-daemon.js', import.meta.url));
  }

  async ensureReady(): Promise<void> {
    try {
      await this.ping();
      return;
    } catch (error) {
      if (error instanceof IncompatibleDaemonError) throw error;
      // Start the resident daemon below.
    }

    const child = spawn(
      process.execPath,
      [this.daemonEntry, '--data-dir', this.paths.dataDir],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          MCP_SERVER_MODE: 'true',
        },
      }
    );
    child.unref();

    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        await this.ping();
        return;
      } catch (error) {
        if (error instanceof IncompatibleDaemonError) throw error;
        lastError = error;
      }
    }
    throw new Error(`RunBeacon daemon did not start: ${String(lastError)}`);
  }

  start(input: StartJobInput): Promise<JobSnapshot> {
    return this.request('start', { input });
  }

  waitForTerminal(
    jobId: string,
    timeoutMs?: number,
    tailLines?: number,
    signal?: AbortSignal
  ): Promise<WaitResult> {
    const requestTimeout = Math.max(5_000, (timeoutMs ?? 86_400_000) + 5_000);
    return this.request(
      'wait',
      { jobId, timeoutMs, tailLines },
      requestTimeout,
      signal
    );
  }

  snapshot(jobId: string, tailLines?: number): Promise<JobSnapshot> {
    return this.request('snapshot', { jobId, tailLines });
  }

  list(tailLines?: number, limit?: number): Promise<JobSnapshot[]> {
    return this.request('list', { tailLines, limit });
  }

  cancel(jobId: string): Promise<JobSnapshot> {
    return this.request('cancel', { jobId });
  }

  shutdown(): Promise<{ stopped: boolean }> {
    return this.request('shutdown', {}, 2_000);
  }

  private async ping(): Promise<DaemonPing> {
    const result = await this.request<DaemonPing>('ping', {}, 1_000);
    if (result.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
      throw new IncompatibleDaemonError(
        `RunBeacon daemon protocol mismatch: expected ${DAEMON_PROTOCOL_VERSION}, received ${String(result.protocolVersion)}. Stop the old daemon after its active jobs finish, then restart Codex.`
      );
    }
    return result;
  }

  private request<T>(
    method: string,
    args: Record<string, unknown>,
    timeoutMs = 10_000,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new Error(`Daemon request ${method} was aborted`));
    }
    return new Promise<T>((resolve, reject) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const socket = createConnection(this.paths.socketPath);
      let buffer = '';
      let settled = false;
      const finish = (error?: unknown, result?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortListener);
        socket.destroy();
        if (error) reject(error);
        else resolve(result as T);
      };
      const timer = setTimeout(
        () => finish(new Error(`Daemon request ${method} timed out`)),
        timeoutMs
      );
      timer.unref?.();
      const abortListener = () =>
        finish(new Error(`Daemon request ${method} was aborted`));
      signal?.addEventListener('abort', abortListener, { once: true });

      socket.setEncoding('utf8');
      socket.once('connect', () => {
        const request: RpcRequest = { id, token: this.token, method, args };
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const response = JSON.parse(
            buffer.slice(0, newline)
          ) as RpcResponse<T>;
          if (response.id !== id) throw new Error('Mismatched daemon response');
          if (response.error) finish(new Error(response.error));
          else finish(undefined, response.result);
        } catch (error) {
          finish(error);
        }
      });
      socket.once('error', (error) => finish(error));
      socket.once('end', () => {
        if (!settled) finish(new Error('Daemon closed the connection'));
      });
    });
  }
}

class IncompatibleDaemonError extends Error {
  constructor(message: string) {
    super(`${message} Client version: ${RUNBEACON_VERSION}.`);
    this.name = 'IncompatibleDaemonError';
  }
}
