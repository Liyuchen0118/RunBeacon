import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  compareBuildVersions,
  readPluginBuildVersion,
  validateBuildVersion,
} from './BuildIdentity.js';
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

export interface DaemonClientOptions {
  buildVersion?: string;
}

export class DaemonClient implements LifecycleService {
  private readonly paths: DaemonPaths;
  private readonly token: string;
  private readonly daemonEntry: string;
  private readonly expectedBuildId: string;
  private readonly expectedBuildVersion: string;

  constructor(
    dataDir: string,
    daemonEntry?: string,
    options: DaemonClientOptions = {}
  ) {
    this.paths = getDaemonPaths(dataDir);
    this.token = ensureDaemonToken(this.paths);
    this.daemonEntry =
      daemonEntry ??
      fileURLToPath(new URL('../daemon/lifecycle-daemon.js', import.meta.url));
    this.expectedBuildId = createHash('sha256')
      .update(readFileSync(this.daemonEntry))
      .digest('hex');
    this.expectedBuildVersion = validateBuildVersion(
      options.buildVersion ?? readPluginBuildVersion(import.meta.url)
    );
  }

  async ensureReady(): Promise<void> {
    try {
      await this.ping();
      return;
    } catch (error) {
      if (error instanceof UpgradeRequiredError) {
        await this.replaceOlderDaemon(error.ping);
      } else if (error instanceof IncompatibleDaemonError) {
        throw error;
      }
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
          RJM_BUILD_VERSION: this.expectedBuildVersion,
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

  status(): Promise<DaemonPing> {
    return this.ping();
  }

  private async ping(): Promise<DaemonPing> {
    const result = await this.request<DaemonPing>('ping', {}, 1_000);
    if (result.protocolVersion > DAEMON_PROTOCOL_VERSION) {
      throw new IncompatibleDaemonError(
        `A newer RunBeacon daemon protocol ${String(result.protocolVersion)} is already running; this client only supports protocol ${DAEMON_PROTOCOL_VERSION}. Start a new Codex task instead of downgrading the daemon.`
      );
    }
    if (result.protocolVersion < DAEMON_PROTOCOL_VERSION) {
      throw new UpgradeRequiredError(result, 'daemon protocol is older');
    }
    if (result.buildId !== this.expectedBuildId) {
      const comparison = compareBuildVersions(
        this.expectedBuildVersion,
        result.buildVersion
      );
      if (comparison > 0) {
        throw new UpgradeRequiredError(result, 'daemon build is older');
      }
      if (comparison < 0) {
        throw new IncompatibleDaemonError(
          `A newer RunBeacon daemon build ${result.buildVersion} is already running; client build ${this.expectedBuildVersion} will not replace it. Start a new Codex task.`
        );
      }
      throw new IncompatibleDaemonError(
        `RunBeacon daemon build IDs differ at the same version ${this.expectedBuildVersion}. Reinstall with a new cachebuster before restarting it.`
      );
    }
    return result;
  }

  private async replaceOlderDaemon(ping: DaemonPing): Promise<void> {
    if (ping.runtime.activeJobs > 0 || ping.runtime.queuedJobs > 0) {
      throw new IncompatibleDaemonError(
        `RunBeacon daemon upgrade is waiting while ${ping.runtime.activeJobs} job(s) are active and ${ping.runtime.queuedJobs} are queued. Wait for them to finish, then start a new Codex task.`
      );
    }
    try {
      await this.request(
        'shutdown',
        {
          expectedBuildId: ping.buildId,
          replacement: {
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            buildVersion: this.expectedBuildVersion,
            buildId: this.expectedBuildId,
          },
        },
        2_000
      );
    } catch {
      // Another MCP client may already be replacing the stale daemon.
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        await this.request<DaemonPing>('ping', {}, 250);
      } catch {
        return;
      }
    }
    throw new Error('Timed out waiting for the stale RunBeacon daemon to stop');
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

class UpgradeRequiredError extends Error {
  constructor(
    readonly ping: DaemonPing,
    reason: string
  ) {
    super(
      `RunBeacon upgrade required because ${reason}: daemon ${String(ping.protocolVersion)}/${String(ping.buildVersion)}, client ${DAEMON_PROTOCOL_VERSION}`
    );
    this.name = 'UpgradeRequiredError';
  }
}
