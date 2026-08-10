import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { JobAdapter, JobPolicyStatus } from './types.js';

export type PolicyRisk = JobPolicyStatus['risk'];

export interface PolicyConfig {
  version: 1;
  requireApproval: Record<Exclude<PolicyRisk, 'standard'>, boolean>;
  approvalTtlSeconds: number;
}

export interface PolicyDecision {
  risk: PolicyRisk;
  requiresApproval: boolean;
  reason: string;
}

export interface PolicyUpdate {
  requireApproval?: Partial<PolicyConfig['requireApproval']>;
  approvalTtlSeconds?: number;
}

const DEFAULT_CONFIG: PolicyConfig = {
  version: 1,
  requireApproval: {
    privileged: true,
    credential: true,
    release: true,
    destructive: true,
  },
  approvalTtlSeconds: 300,
};

export class PolicyEngine {
  private config: PolicyConfig;

  constructor(private readonly path: string) {
    this.config = this.load();
  }

  classify(command: string, adapter: JobAdapter): PolicyDecision {
    const normalized = command.toLowerCase();
    let risk: PolicyRisk = 'standard';
    let reason = 'ordinary task';
    if (
      /(?:^|[;&|\s])(?:rm\s+-[^\n]*r[^\n]*f|mkfs(?:\.|\s)|shutdown|reboot|poweroff)(?:\s|$)/i.test(
        command
      ) ||
      /git\s+push\b[^\n]*(?:--force|-f\b)/i.test(command) ||
      /remove-item\b[^\n]*-(?:recurse|force)/i.test(command)
    ) {
      risk = 'destructive';
      reason = 'destructive or force operation';
    } else if (
      adapter === 'apple-signing' ||
      /\b(codesign|notarytool|security\s+(?:import|find-identity))\b/i.test(
        command
      )
    ) {
      risk = 'credential';
      reason = 'private signing identity or Keychain use';
    } else if (
      /\b(npm\s+publish|gh\s+release|git\s+push|docker\s+push)\b/i.test(command)
    ) {
      risk = 'release';
      reason = 'external publication';
    } else if (/\b(sudo|doas|su\s+-|launchctl\s+asuser)\b/i.test(normalized)) {
      risk = 'privileged';
      reason = 'privileged execution context';
    }
    return {
      risk,
      requiresApproval:
        risk !== 'standard' && this.config.requireApproval[risk] !== false,
      reason,
    };
  }

  get(): PolicyConfig {
    return JSON.parse(JSON.stringify(this.config)) as PolicyConfig;
  }

  update(input: PolicyUpdate): PolicyConfig {
    const approvalTtlSeconds = Number.isFinite(input.approvalTtlSeconds)
      ? Math.max(60, Math.min(900, Math.trunc(input.approvalTtlSeconds!)))
      : this.config.approvalTtlSeconds;
    this.config = {
      version: 1,
      approvalTtlSeconds,
      requireApproval: {
        ...this.config.requireApproval,
        ...(input.requireApproval ?? {}),
      },
    };
    this.save();
    return this.get();
  }

  private load(): PolicyConfig {
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as PolicyConfig;
      if (value.version !== 1 || !value.requireApproval) throw new Error();
      return {
        version: 1,
        approvalTtlSeconds: Math.max(
          60,
          Math.min(900, Number(value.approvalTtlSeconds) || 300)
        ),
        requireApproval: {
          ...DEFAULT_CONFIG.requireApproval,
          ...value.requireApproval,
        },
      };
    } catch {
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as PolicyConfig;
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.config, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (process.platform !== 'win32') chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    if (process.platform !== 'win32') chmodSync(this.path, 0o600);
  }
}
