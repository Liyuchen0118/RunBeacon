export const RUNBEACON_VERSION = '1.0.0';
export const DAEMON_PROTOCOL_VERSION = 4;

export interface DaemonPing {
  ready: true;
  pid: number;
  version: string;
  protocolVersion: number;
  buildId: string;
  buildVersion: string;
  runtime: {
    activeJobs: number;
    queuedJobs: number;
  };
  persistence: {
    healthy: boolean;
    lastError?: string;
    lastSuccessAt?: string;
  };
}
