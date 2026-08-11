import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Client,
  ClientChannel,
  ConnectConfig,
  ServerHostKeyAlgorithm,
} from 'ssh2';
import { safeErrorMessage } from './security.js';
import { RUNNER_PROTOCOL_VERSION } from './protocol.js';
import { SshJobTarget } from './types.js';

const MAX_RUNNER_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_RPC_TIMEOUT_MS = 35_000;
const RUNNER_PATH_PATTERN = /^\/[A-Za-z0-9._/+@-]{1,1023}$/;
const SSH_SERVER_HOST_KEY_ALGORITHMS: ServerHostKeyAlgorithm[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
];

export interface RunnerRequest {
  protocolVersion: number;
  method: 'ping' | 'submit' | 'get' | 'watch' | 'cancel';
  params?: Record<string, unknown>;
}

export interface RunnerResponse<T = Record<string, unknown>> {
  protocolVersion: number;
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string };
}

export interface RunnerRPCClient {
  call<T = Record<string, unknown>>(
    method: RunnerRequest['method'],
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T>;
}

export class RunnerTransportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly ambiguous = false
  ) {
    super(message);
    this.name = 'RunnerTransportError';
  }
}

export async function probeSshHostKeyAlgorithm(
  target: SshJobTarget,
  clientFactory: () => Client = () => new Client(),
  timeoutMs = 8_000
): Promise<ServerHostKeyAlgorithm> {
  const expected = target.hostKeySha256
    ?.trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
  if (!expected) {
    throw new RunnerTransportError(
      'HOST_KEY_MISMATCH',
      'A pinned SHA-256 host fingerprint is required before probing its algorithm'
    );
  }
  for (const algorithm of SSH_SERVER_HOST_KEY_ALGORITHMS) {
    const matched = await probeHostKeyAttempt(
      target,
      expected,
      algorithm,
      clientFactory,
      timeoutMs
    );
    if (matched) return algorithm;
  }
  throw new RunnerTransportError(
    'HOST_KEY_MISMATCH',
    'No supported SSH host-key algorithm matched the pinned SHA-256 fingerprint'
  );
}

function probeHostKeyAttempt(
  target: SshJobTarget,
  expected: string,
  algorithm: ServerHostKeyAlgorithm,
  clientFactory: () => Client,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const client = clientFactory();
    let settled = false;
    let fingerprintMatched = false;
    const finish = (matched: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeAllListeners();
      client.destroy();
      if (error) reject(error);
      else resolve(matched);
    };
    const timer = setTimeout(
      () =>
        finish(
          false,
          fingerprintMatched
            ? new RunnerTransportError(
                'RUNNER_UNAVAILABLE',
                'SSH authentication did not complete after the pinned host key matched'
              )
            : undefined
        ),
      Math.max(1_000, Math.min(30_000, timeoutMs))
    );
    timer.unref?.();
    client.once('ready', () => finish(fingerprintMatched));
    client.once('error', (error) => {
      if (fingerprintMatched) {
        finish(
          false,
          new RunnerTransportError(
            'RUNNER_UNAVAILABLE',
            `SSH authentication failed after the pinned host key matched: ${safeErrorMessage(error)}`
          )
        );
      } else {
        finish(false);
      }
    });
    client.once('close', () => finish(false));
    try {
      const config: ConnectConfig = {
        host: target.host,
        port: target.port ?? 22,
        username: target.username,
        password: target.password,
        passphrase: target.passphrase,
        agent: target.agent,
        readyTimeout: Math.max(1_000, Math.min(30_000, timeoutMs)),
        algorithms: { serverHostKey: [algorithm] },
        hostVerifier: (key: Buffer) => {
          fingerprintMatched =
            createHash('sha256')
              .update(key)
              .digest('base64')
              .replace(/=+$/, '') === expected;
          return fingerprintMatched;
        },
      };
      if (target.privateKeyPath) {
        config.privateKey = readFileSync(target.privateKeyPath);
      }
      client.connect(config);
    } catch (error) {
      finish(
        false,
        fingerprintMatched
          ? new RunnerTransportError(
              'RUNNER_UNAVAILABLE',
              safeErrorMessage(error)
            )
          : undefined
      );
    }
  });
}

export class SshRunnerTransport implements RunnerRPCClient {
  constructor(
    private readonly target: SshJobTarget,
    private readonly clientFactory: () => Client = () => new Client()
  ) {}

  async call<T = Record<string, unknown>>(
    method: RunnerRequest['method'],
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS
  ): Promise<T> {
    const request: RunnerRequest = {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      method,
      params,
    };
    const response = await this.execute<T>(
      JSON.stringify(request),
      Math.max(1_000, Math.min(24 * 60 * 60 * 1_000, timeoutMs))
    );
    if (
      response.protocolVersion !== RUNNER_PROTOCOL_VERSION ||
      typeof response.ok !== 'boolean'
    ) {
      throw new RunnerTransportError(
        'RUNNER_PROTOCOL_MISMATCH',
        'Runner returned an incompatible protocol response'
      );
    }
    if (!response.ok) {
      throw new RunnerTransportError(
        response.error?.code || 'RUNNER_RPC_FAILED',
        response.error?.message || 'Runner RPC failed'
      );
    }
    return (response.result ?? {}) as T;
  }

  private execute<T>(
    request: string,
    timeoutMs: number
  ): Promise<RunnerResponse<T>> {
    return new Promise((resolve, reject) => {
      let runnerCommand: string;
      try {
        runnerCommand = this.runnerCommand();
      } catch (error) {
        reject(error);
        return;
      }
      const client = this.clientFactory();
      let stream: ClientChannel | undefined;
      let settled = false;
      let ready = false;
      let rpcStarted = false;
      let hostKeyRejected = false;
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);

      const finish = (
        response?: RunnerResponse<T>,
        error?: RunnerTransportError
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stream?.removeAllListeners();
        client.removeAllListeners();
        client.destroy();
        if (error) reject(error);
        else resolve(response!);
      };

      const appendBounded = (current: Buffer, value: Buffer): Buffer => {
        if (current.length + value.length > MAX_RUNNER_RESPONSE_BYTES) {
          finish(
            undefined,
            new RunnerTransportError(
              'RUNNER_RESPONSE_TOO_LARGE',
              'Runner response exceeded 8 MiB',
              rpcStarted
            )
          );
          return current;
        }
        return Buffer.concat([current, value]);
      };

      const timer = setTimeout(() => {
        finish(
          undefined,
          new RunnerTransportError(
            rpcStarted ? 'RUNNER_RESPONSE_LOST' : 'RUNNER_UNAVAILABLE',
            'Runner RPC timed out',
            rpcStarted
          )
        );
      }, timeoutMs);
      timer.unref?.();

      client.once('ready', () => {
        ready = true;
        client.exec(runnerCommand, (error, channel) => {
          if (error || !channel) {
            finish(
              undefined,
              new RunnerTransportError(
                'RUNNER_UNAVAILABLE',
                safeErrorMessage(error ?? new Error('Runner channel missing'))
              )
            );
            return;
          }
          stream = channel;
          rpcStarted = true;
          channel.on('data', (value: Buffer) => {
            stdout = appendBounded(stdout, Buffer.from(value));
          });
          channel.stderr.on('data', (value: Buffer) => {
            stderr = appendBounded(stderr, Buffer.from(value));
          });
          channel.once('error', (channelError: Error) => {
            finish(
              undefined,
              new RunnerTransportError(
                'RUNNER_RESPONSE_LOST',
                safeErrorMessage(channelError),
                true
              )
            );
          });
          channel.once('close', (code: number | null) => {
            if (settled) return;
            if (code !== 0) {
              const safeMessage = stderr
                .toString('utf8')
                .trim()
                .slice(0, 1_000);
              finish(
                undefined,
                new RunnerTransportError(
                  code === 127 || /not found|no such file/i.test(safeMessage)
                    ? 'RUNNER_NOT_INSTALLED'
                    : 'RUNNER_UNAVAILABLE',
                  safeMessage || `Runner RPC exited with code ${code}`
                )
              );
              return;
            }
            try {
              finish(JSON.parse(stdout.toString('utf8')) as RunnerResponse<T>);
            } catch {
              finish(
                undefined,
                new RunnerTransportError(
                  'RUNNER_PROTOCOL_MISMATCH',
                  'Runner returned invalid JSON',
                  true
                )
              );
            }
          });
          channel.end(`${request}\n`);
        });
      });
      client.once('error', (error) => {
        finish(
          undefined,
          new RunnerTransportError(
            hostKeyRejected
              ? 'HOST_KEY_MISMATCH'
              : ready
                ? 'RUNNER_RESPONSE_LOST'
                : 'RUNNER_UNAVAILABLE',
            hostKeyRejected
              ? 'SSH host key did not match the pinned SHA-256 fingerprint'
              : safeErrorMessage(error),
            ready && rpcStarted
          )
        );
      });
      client.once('close', () => {
        finish(
          undefined,
          new RunnerTransportError(
            hostKeyRejected
              ? 'HOST_KEY_MISMATCH'
              : rpcStarted
                ? 'RUNNER_RESPONSE_LOST'
                : 'RUNNER_UNAVAILABLE',
            hostKeyRejected
              ? 'SSH host key did not match the pinned SHA-256 fingerprint'
              : rpcStarted
                ? 'SSH connection closed before the Runner response'
                : 'SSH connection closed before the Runner handshake',
            rpcStarted
          )
        );
      });

      try {
        client.connect(
          this.connectConfig(() => {
            hostKeyRejected = true;
          })
        );
      } catch (error) {
        finish(
          undefined,
          new RunnerTransportError(
            'RUNNER_UNAVAILABLE',
            safeErrorMessage(error)
          )
        );
      }
    });
  }

  private connectConfig(onHostKeyRejected: () => void): ConnectConfig {
    const expected = this.target.hostKeySha256
      ?.trim()
      .replace(/^SHA256:/i, '')
      .replace(/=+$/, '');
    const config: ConnectConfig = {
      host: this.target.host,
      port: this.target.port ?? 22,
      username: this.target.username,
      password: this.target.password,
      passphrase: this.target.passphrase,
      agent: this.target.agent,
      readyTimeout: 12_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 6,
      hostVerifier: expected
        ? (key: Buffer) => {
            const matches =
              createHash('sha256')
                .update(key)
                .digest('base64')
                .replace(/=+$/, '') === expected;
            if (!matches) onHostKeyRejected();
            return matches;
          }
        : () => Boolean(this.target.allowUnverifiedHostKey),
    };
    if (this.target.privateKeyPath) {
      config.privateKey = readFileSync(this.target.privateKeyPath);
    }
    if (this.target.hostKeyAlgorithm) {
      config.algorithms = {
        serverHostKey: [this.target.hostKeyAlgorithm as ServerHostKeyAlgorithm],
      };
    }
    return config;
  }

  private runnerCommand(): string {
    if (!this.target.runnerPath) {
      return '$HOME/.local/bin/runbeacon-runner rpc';
    }
    if (!RUNNER_PATH_PATTERN.test(this.target.runnerPath)) {
      throw new RunnerTransportError(
        'RUNNER_UNAVAILABLE',
        'runnerPath must be an absolute path containing only safe path characters'
      );
    }
    return `'${this.target.runnerPath}' rpc`;
  }
}
