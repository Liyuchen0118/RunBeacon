export const RUNBEACON_VERSION = '3.0.0';
export const DAEMON_PROTOCOL_VERSION = 5;
export const RUNNER_PROTOCOL_VERSION = 1;
export const JOB_STORE_VERSION = 2;

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
