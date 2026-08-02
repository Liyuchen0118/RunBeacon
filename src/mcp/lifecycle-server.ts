#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  TextContent,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { LifecycleManager } from '../lifecycle/LifecycleManager.js';
import { DaemonClient, LifecycleService } from '../lifecycle/DaemonClient.js';
import {
  CredentialProfile,
  CredentialProfileStore,
  GitHubCredentialProfile,
  SaveCredentialProfileInput,
  SshCredentialProfile,
} from '../lifecycle/CredentialProfileStore.js';
import {
  createDashboardHtml,
  DASHBOARD_RESOURCE_URI,
  MCP_APP_MIME_TYPE,
} from '../lifecycle/DashboardApp.js';
import { safeErrorMessage } from '../lifecycle/security.js';
import { SshJobTarget, StartJobInput } from '../lifecycle/types.js';
import { RUNBEACON_VERSION } from '../lifecycle/protocol.js';

process.env.MCP_SERVER_MODE = 'true';

const pluginData =
  process.env.PLUGIN_DATA ||
  process.env.CLAUDE_PLUGIN_DATA ||
  join(homedir(), '.remote-job-monitor');
const githubPublishRunner = fileURLToPath(
  new URL('../daemon/github-publish-runner.js', import.meta.url)
);
const credentialProfiles = new CredentialProfileStore(
  join(pluginData, 'credential-profiles.json')
);

let manager: LifecycleService;
if (process.env.RJM_INLINE_MANAGER === 'true') {
  manager = new LifecycleManager({
    statePath: process.env.RJM_STATE_PATH || join(pluginData, 'jobs.json'),
    maxConcurrentJobs: Number(process.env.RJM_MAX_CONCURRENT_JOBS || 4),
    maxOutputBytes: Number(process.env.RJM_MAX_OUTPUT_BYTES || 1024 * 1024),
    persistOutput: process.env.RJM_PERSIST_OUTPUT === 'true',
    persistMetadata: process.env.RJM_PERSIST_METADATA === 'true',
    persistenceDebounceMs: Number(process.env.RJM_PERSIST_DEBOUNCE_MS || 250),
    maxRetainedJobs: Number(process.env.RJM_MAX_RETAINED_JOBS || 1000),
    cancellationGraceMs: Number(process.env.RJM_CANCEL_GRACE_MS || 5000),
  });
} else {
  const daemon = new DaemonClient(
    pluginData,
    fileURLToPath(new URL('../daemon/lifecycle-daemon.js', import.meta.url))
  );
  await daemon.ensureReady();
  manager = daemon;
}

const sshTargetSchema = {
  type: 'object',
  description:
    'SSH connection. Password and passphrase are memory-only; prefer agent or privateKeyPath.',
  properties: {
    kind: { type: 'string', enum: ['ssh'] },
    host: { type: 'string' },
    port: { type: 'integer', minimum: 1, maximum: 65535, default: 22 },
    username: { type: 'string' },
    password: {
      type: 'string',
      description: 'Memory-only SSH password. Never persisted by this plugin.',
    },
    privateKeyPath: { type: 'string' },
    passphrase: {
      type: 'string',
      description: 'Memory-only private-key passphrase.',
    },
    agent: { type: 'string', description: 'SSH_AUTH_SOCK path.' },
    hostKeySha256: {
      type: 'string',
      description:
        'Pinned SSH host-key fingerprint, with or without SHA256: prefix.',
    },
    allowUnverifiedHostKey: {
      type: 'boolean',
      default: false,
      description:
        'Explicit insecure override when no pinned host key is available.',
    },
  },
  required: ['kind', 'host', 'username'],
};

const tools: Tool[] = [
  {
    name: 'credential_profile_save',
    description:
      'Create or update a passwordless credential reference profile. SSH profiles store only host, user, host-key verification, and an SSH-agent/private-key path. GitHub profiles reuse Git Credential Manager. Passwords, passphrases, private-key contents, and tokens are rejected and never persisted.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
          description:
            'Reusable profile name, for example production or github-main.',
        },
        kind: { type: 'string', enum: ['ssh', 'github'] },
        host: {
          type: 'string',
          description: 'SSH host or github.com for a GitHub profile.',
        },
        port: { type: 'integer', minimum: 1, maximum: 65535, default: 22 },
        username: { type: 'string' },
        privateKeyPath: {
          type: 'string',
          description:
            'Path to an SSH private key. Prefer loading encrypted keys into ssh-agent instead of storing a passphrase.',
        },
        agent: {
          type: 'string',
          description:
            'SSH agent socket/pipe path, or "auto" to use SSH_AUTH_SOCK and the Windows OpenSSH agent pipe.',
        },
        hostKeySha256: {
          type: 'string',
          description: 'Pinned SSH host-key fingerprint.',
        },
        allowUnverifiedHostKey: {
          type: 'boolean',
          default: false,
          description:
            'Explicit insecure override when no fingerprint is available.',
        },
        credentialSource: {
          type: 'string',
          enum: ['git'],
          default: 'git',
          description:
            'GitHub credentials come from the configured Git credential helper.',
        },
      },
      required: ['id', 'kind'],
    },
    annotations: {
      title: 'Save Credential Profile',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'credential_profile_list',
    description:
      'List safe credential reference profiles. Results never contain passwords, passphrases, private-key contents, or tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['ssh', 'github'] },
      },
    },
    annotations: {
      title: 'List Credential Profiles',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'credential_profile_delete',
    description:
      'Delete one RunBeacon credential reference profile. This does not delete keys from ssh-agent, private-key files, or credentials from Git Credential Manager.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    annotations: {
      title: 'Delete Credential Profile',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'github_publish_start',
    description:
      'Start a dashboard-tracked GitHub publish: optionally commit already-staged changes, push without force, then monitor GitHub Actions in the background. This never runs git add. Use job_wait once if the workflow should continue automatically after publishing.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          minLength: 1,
          description: 'Working tree or a directory inside it.',
        },
        remote: {
          type: 'string',
          default: 'origin',
          description: 'Git remote to push without force.',
        },
        branch: {
          type: 'string',
          description: 'Destination branch. Defaults to the current branch.',
        },
        commitMessage: {
          type: 'string',
          minLength: 1,
          maxLength: 10_000,
          description:
            'When present, commit only changes that are already staged. The tool never runs git add.',
        },
        watchActions: {
          type: 'boolean',
          default: true,
          description:
            'Discover and monitor GitHub Actions after the push. Disable for non-GitHub remotes.',
        },
        githubToken: {
          type: 'string',
          description:
            'Optional memory-only GitHub token override. By default RunBeacon safely reuses Git Credential Manager for private repositories and API limits.',
        },
        actionsTimeoutMs: {
          type: 'integer',
          minimum: 10_000,
          maximum: 82_800_000,
          default: 1_800_000,
        },
        discoveryTimeoutMs: {
          type: 'integer',
          minimum: 1_000,
          maximum: 600_000,
          default: 120_000,
        },
        pollIntervalMs: {
          type: 'integer',
          minimum: 1_000,
          maximum: 300_000,
          default: 15_000,
          description:
            'Background API interval. Anonymous GitHub API access is automatically limited to at least 60 seconds.',
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'Stable key that prevents a retry from creating another commit or push job.',
        },
        credentialProfile: {
          type: 'string',
          description:
            'Optional saved GitHub profile that reuses Git Credential Manager without exposing its token.',
        },
      },
      required: ['cwd'],
    },
    annotations: {
      title: 'Publish to GitHub',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    _meta: {
      ui: { resourceUri: DASHBOARD_RESOURCE_URI },
    },
  } as Tool,
  {
    name: 'job_start',
    description:
      'Start a tracked local or SSH command. This is the default tool for non-interactive remote execution: use it instead of raw shell/ssh whenever Codex calls a remote server so lifecycle events, output, progress, cancellation, and event-driven waiting remain available.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Local command or complete remote shell command.',
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'Stable caller-provided key that returns the existing job instead of launching a duplicate after a retry.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Local command arguments. For SSH, include arguments in command.',
        },
        cwd: { type: 'string', description: 'Local working directory.' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Local environment overrides. Values are never persisted.',
        },
        shell: {
          type: 'boolean',
          default: true,
          description: 'Use a local shell.',
        },
        label: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1, default: 86400000 },
        target: {
          oneOf: [
            {
              type: 'object',
              properties: { kind: { type: 'string', enum: ['local'] } },
              required: ['kind'],
            },
            sshTargetSchema,
          ],
        },
        progressPattern: {
          type: 'string',
          description:
            'Optional regex; capture group 1 must contain a percentage.',
        },
        metadata: {
          type: 'object',
          description:
            'In-memory caller metadata. It is not persisted unless RJM_PERSIST_METADATA=true, and sensitive-key values are redacted when persistence is enabled.',
        },
        credentialProfile: {
          type: 'string',
          description:
            'Saved SSH profile. If omitted, a unique profile matching target.host and target.username is selected automatically when no inline authentication is supplied.',
        },
      },
      required: ['command'],
    },
    annotations: {
      title: 'Start Tracked Job',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'job_wait',
    description:
      'Wait inside the MCP server until a tracked job reaches a terminal state. This is event-driven and consumes no repeated model turns while waiting. Call once after job_start, then continue the workflow from the returned result.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 86400000,
          default: 86400000,
          description:
            'Maximum server-side wait; no polling by the model occurs.',
        },
        tailLines: { type: 'integer', minimum: 0, maximum: 500, default: 120 },
      },
      required: ['jobId'],
    },
    annotations: {
      title: 'Wait for Job Completion',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'job_snapshot',
    description:
      'Read one tracked job and a bounded output tail. Use only for explicit status requests; prefer job_wait for completion.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        tailLines: { type: 'integer', minimum: 0, maximum: 500, default: 80 },
      },
      required: ['jobId'],
    },
    annotations: {
      title: 'Read Job Snapshot',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'job_list',
    description:
      'List tracked jobs with bounded output tails. The dashboard calls this directly without model tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        tailLines: { type: 'integer', minimum: 0, maximum: 50, default: 8 },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
    },
    annotations: {
      title: 'List Tracked Jobs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'job_cancel',
    description: 'Cancel a queued or running tracked job.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
    annotations: {
      title: 'Cancel Tracked Job',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'job_dashboard',
    description:
      'Render the live RunBeacon dashboard. The UI refreshes by calling job_list directly, so updates do not create model turns or consume model tokens.',
    inputSchema: { type: 'object', properties: {} },
    annotations: {
      title: 'Open Job Dashboard',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      ui: { resourceUri: DASHBOARD_RESOURCE_URI },
    },
  } as Tool,
];

const server = new Server(
  { name: 'remote-job-monitor', version: RUNBEACON_VERSION },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: DASHBOARD_RESOURCE_URI,
      name: 'RunBeacon Dashboard',
      description: 'Live, token-free task lifecycle dashboard.',
      mimeType: MCP_APP_MIME_TYPE,
    },
  ],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== DASHBOARD_RESOURCE_URI) {
    throw new Error(`Unknown resource: ${request.params.uri}`);
  }
  return {
    contents: [
      {
        uri: DASHBOARD_RESOURCE_URI,
        mimeType: MCP_APP_MIME_TYPE,
        text: createDashboardHtml(),
      },
    ],
  };
});

function reply(structuredContent: Record<string, unknown>, message: string) {
  return {
    content: [{ type: 'text', text: message } as TextContent],
    structuredContent,
  } as any;
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const args = (request.params.arguments ?? {}) as Record<string, any>;
  try {
    switch (request.params.name) {
      case 'credential_profile_save': {
        const profile = credentialProfiles.save(
          args as SaveCredentialProfileInput
        );
        return reply(
          { profile },
          `Saved passwordless ${profile.kind} credential profile ${profile.id}. No secret material was stored.`
        );
      }
      case 'credential_profile_list': {
        const kind = optionalCredentialKind(args.kind);
        const profiles = credentialProfiles.list(kind);
        return reply(
          { profiles },
          `${profiles.length} safe credential reference profile(s).`
        );
      }
      case 'credential_profile_delete': {
        const profile = credentialProfiles.delete(String(args.id ?? ''));
        return reply(
          { profile },
          `Deleted RunBeacon profile ${profile.id}; OS-managed credentials and key files were not changed.`
        );
      }
      case 'github_publish_start': {
        const cwd = String(args.cwd ?? '').trim();
        if (!cwd) throw new Error('cwd is required');
        const remote = String(args.remote ?? 'origin');
        const watchActions = args.watchActions !== false;
        const branch = optionalString(args.branch);
        const commitMessage = optionalString(args.commitMessage);
        const actionsTimeoutMs = numericArgument(
          args.actionsTimeoutMs,
          1_800_000
        );
        const discoveryTimeoutMs = numericArgument(
          args.discoveryTimeoutMs,
          120_000
        );
        const pollIntervalMs = numericArgument(args.pollIntervalMs, 15_000);
        const runnerArgs = [
          githubPublishRunner,
          '--cwd',
          cwd,
          '--remote',
          remote,
          '--watch-actions',
          String(watchActions),
          '--actions-timeout-ms',
          String(actionsTimeoutMs),
          '--discovery-timeout-ms',
          String(discoveryTimeoutMs),
          '--poll-interval-ms',
          String(pollIntervalMs),
        ];
        if (branch) runnerArgs.push('--branch', branch);
        if (commitMessage) runnerArgs.push('--commit-message', commitMessage);

        const githubToken = optionalString(args.githubToken);
        const credentialProfileId = optionalString(args.credentialProfile);
        const credentialProfile = credentialProfileId
          ? requireGitHubProfile(credentialProfileId)
          : undefined;
        const job = await manager.start({
          command: process.execPath,
          args: runnerArgs,
          shell: false,
          label: `GitHub publish ${remote}/${branch ?? 'current branch'}`,
          timeoutMs: Math.min(
            24 * 60 * 60_000,
            actionsTimeoutMs + discoveryTimeoutMs + 15 * 60_000
          ),
          idempotencyKey: optionalString(args.idempotencyKey),
          progressPattern:
            '^(\\d{1,3}(?:\\.\\d+)?)%\\s+\\[[A-Za-z][A-Za-z0-9_-]{0,63}\\].*$',
          env:
            githubToken || credentialProfile
              ? {
                  ...(githubToken
                    ? { RUNBEACON_GITHUB_TOKEN: githubToken }
                    : {}),
                  ...(credentialProfile
                    ? { RUNBEACON_GITHUB_CREDENTIAL_SOURCE: 'git' }
                    : {}),
                }
              : undefined,
          metadata: {
            kind: 'github_publish',
            remote,
            branch: branch ?? 'current',
            watchActions,
            credentialProfile: credentialProfile?.id,
          },
        });
        return reply(
          { job },
          `GitHub publish job ${job.id} started. The dashboard tracks commit, push, and Actions without model polling; call job_wait once if you need to continue automatically.`
        );
      }
      case 'job_start': {
        const job = await manager.start(resolveJobStartInput(args));
        return reply(
          { job },
          `Tracked job ${job.id} queued. Call job_wait once to resume when it finishes; do not poll.`
        );
      }
      case 'job_wait': {
        const result = await manager.waitForTerminal(
          String(args.jobId),
          args.timeoutMs,
          args.tailLines,
          extra.signal
        );
        const message = result.timedOut
          ? `Server-side wait timed out; job ${result.job.id} is ${result.job.state}.`
          : `Job ${result.job.id} finished with state ${result.job.state}.`;
        return reply(result as unknown as Record<string, unknown>, message);
      }
      case 'job_snapshot': {
        const job = await manager.snapshot(String(args.jobId), args.tailLines);
        return reply({ job }, `Job ${job.id} is ${job.state}.`);
      }
      case 'job_list': {
        const jobs = await manager.list(args.tailLines, args.limit);
        return reply({ jobs }, `${jobs.length} tracked job(s).`);
      }
      case 'job_cancel': {
        const job = await manager.cancel(String(args.jobId));
        return reply({ job }, `Cancellation requested for job ${job.id}.`);
      }
      case 'job_dashboard': {
        const jobs = await manager.list(8);
        return reply({ jobs }, 'Opened the live job dashboard.');
      }
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: safeErrorMessage(error) } as TextContent],
    };
  }
});

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numericArgument(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('Expected a numeric argument');
  return Math.round(parsed);
}

function optionalCredentialKind(
  value: unknown
): CredentialProfile['kind'] | undefined {
  if (value === undefined) return undefined;
  if (value === 'ssh' || value === 'github') return value;
  throw new Error('Credential profile kind must be ssh or github');
}

function requireGitHubProfile(id: string): GitHubCredentialProfile {
  const profile = credentialProfiles.get(id);
  if (profile.kind !== 'github') {
    throw new Error(`Credential profile ${id} is not a GitHub profile`);
  }
  return profile;
}

function resolveJobStartInput(args: Record<string, any>): StartJobInput {
  const input = { ...args } as Record<string, any>;
  delete input.credentialProfile;
  const requestedProfile = optionalString(args.credentialProfile);
  const suppliedTarget =
    args.target && typeof args.target === 'object'
      ? ({ ...args.target } as Record<string, any>)
      : undefined;
  let profile: SshCredentialProfile | undefined;

  if (requestedProfile) {
    const selected = credentialProfiles.get(requestedProfile);
    if (selected.kind !== 'ssh') {
      throw new Error(
        `Credential profile ${requestedProfile} is not an SSH profile`
      );
    }
    profile = selected;
  } else if (
    suppliedTarget?.kind === 'ssh' &&
    !suppliedTarget.password &&
    !suppliedTarget.privateKeyPath &&
    !suppliedTarget.agent
  ) {
    const matches = credentialProfiles.findSsh(
      String(suppliedTarget.host ?? ''),
      optionalString(suppliedTarget.username)
    );
    if (matches.length === 1) profile = matches[0];
    if (matches.length > 1) {
      throw new Error(
        `Multiple SSH profiles match ${String(suppliedTarget.host)}; pass credentialProfile explicitly`
      );
    }
  }

  let target = suppliedTarget;
  if (profile) {
    if (target?.kind && target.kind !== 'ssh') {
      throw new Error(
        'An SSH credential profile cannot be used with a local target'
      );
    }
    if (
      target?.host &&
      String(target.host).toLowerCase() !== profile.host.toLowerCase()
    ) {
      throw new Error(
        `SSH profile ${profile.id} is for ${profile.host}, not ${String(target.host)}`
      );
    }
    if (
      target?.username &&
      String(target.username).toLowerCase() !== profile.username.toLowerCase()
    ) {
      throw new Error(
        `SSH profile ${profile.id} is for user ${profile.username}, not ${String(target.username)}`
      );
    }
    target = {
      kind: 'ssh',
      host: profile.host,
      port: profile.port,
      username: profile.username,
      privateKeyPath: profile.privateKeyPath,
      agent: profile.agent,
      hostKeySha256: profile.hostKeySha256,
      allowUnverifiedHostKey: profile.allowUnverifiedHostKey,
      ...target,
    };
    const metadata =
      input.metadata &&
      typeof input.metadata === 'object' &&
      !Array.isArray(input.metadata)
        ? input.metadata
        : {};
    input.metadata = { ...metadata, credentialProfile: profile.id };
  }

  if (target?.kind === 'ssh') {
    if (target.agent === 'auto') target.agent = resolveSshAgent();
    if (!target.password && !target.privateKeyPath && !target.agent) {
      throw new Error(
        'SSH authentication is missing. Save a passwordless credential profile with credential_profile_save, or provide a memory-only password for this job.'
      );
    }
    input.target = target as unknown as SshJobTarget;
  } else if (target) {
    input.target = target;
  }

  return input as StartJobInput;
}

function resolveSshAgent(): string {
  const configured = process.env.SSH_AUTH_SOCK?.trim();
  if (configured) return configured;
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\openssh-ssh-agent';
  }
  throw new Error(
    'agent="auto" requires SSH_AUTH_SOCK outside Windows; start ssh-agent or save an explicit agent path'
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
