export const RUNBEACON_VERSION = '1.0.0';
export const DAEMON_PROTOCOL_VERSION = 2;

export interface DaemonPing {
  ready: true;
  pid: number;
  version: string;
  protocolVersion: number;
  persistence: {
    healthy: boolean;
    lastError?: string;
    lastSuccessAt?: string;
  };
}
