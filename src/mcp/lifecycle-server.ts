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
  deleteGitHubTokenCredential,
  saveGitHubTokenCredential,
} from '../lifecycle/GitCredentialManager.js';
import { SshPasswordProfileManager } from '../lifecycle/SshPasswordProfileManager.js';
import {
  createDashboardHtml,
  DASHBOARD_RESOURCE_URI,
  MCP_APP_MIME_TYPE,
} from '../lifecycle/DashboardApp.js';
import { safeErrorMessage } from '../lifecycle/security.js';
import {
  isTerminalJobState,
  SshJobTarget,
  StartJobInput,
} from '../lifecycle/types.js';
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
const sshPasswordProfiles = new SshPasswordProfileManager(credentialProfiles);

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
    sshHandshakeAttempts: Number(process.env.RJM_SSH_HANDSHAKE_ATTEMPTS || 5),
    sshRetryBaseDelayMs: Number(process.env.RJM_SSH_RETRY_BASE_DELAY_MS || 250),
    sshReadyTimeoutMs: Number(process.env.RJM_SSH_READY_TIMEOUT_MS || 12_000),
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
        makeDefault: {
          type: 'boolean',
          default: false,
          description:
            'Make the saved profile the default for its SSH or GitHub kind.',
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
    name: 'credential_profile_set_default',
    description:
      'Make an existing safe credential profile the default for its kind. SSH and GitHub defaults are independent. This changes only RunBeacon profile selection and does not alter OS-managed secrets.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Existing SSH or GitHub credential profile id.',
        },
      },
      required: ['id'],
    },
    annotations: {
      title: 'Set Default Credential Profile',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'credential_profile_clear_default',
    description:
      'Clear the default SSH or GitHub credential profile without deleting the profile or any OS-managed secret.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['ssh', 'github'] },
      },
      required: ['kind'],
    },
    annotations: {
      title: 'Clear Default Credential Profile',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ssh_password_save',
    description:
      'Store an SSH password in the configured OS-backed Git credential helper and create a safe RunBeacon profile containing only host, port, username, host-key policy, and credentialKind="password". Prefer passwordEnvVar so the password never appears in conversation. The password is never written to RunBeacon profiles, jobs, dashboard state, logs, command arguments, or environment metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
          description: 'Reusable SSH credential profile name.',
        },
        host: {
          type: 'string',
          minLength: 1,
          maxLength: 253,
          description: 'SSH server IP address or hostname.',
        },
        port: { type: 'integer', minimum: 1, maximum: 65535, default: 22 },
        username: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: 'SSH account name.',
        },
        passwordEnvVar: {
          type: 'string',
          pattern: '^[A-Za-z_][A-Za-z0-9_]{0,127}$',
          description:
            'Preferred: read the password from this MCP server environment variable.',
        },
        password: {
          type: 'string',
          minLength: 1,
          maxLength: 4096,
          description:
            'Explicit memory-only password input. Use only when the user deliberately supplies it in this conversation.',
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
        makeDefault: {
          type: 'boolean',
          default: false,
          description:
            'Make this password profile the default SSH credential after saving.',
        },
      },
      required: ['id', 'host', 'username'],
    },
    annotations: {
      title: 'Save SSH Password',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ssh_password_delete',
    description:
      'Delete an SSH password created through ssh_password_save from the configured OS credential helper and remove its RunBeacon profile reference. Passwordless SSH profiles are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'RunBeacon SSH password profile to delete.',
        },
      },
      required: ['id'],
    },
    annotations: {
      title: 'Delete SSH Password',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'github_token_save',
    description:
      'Store a GitHub personal access token in the configured Git credential helper and create a safe RunBeacon profile reference. Prefer tokenEnvVar so the token never appears in conversation; use token only when the user explicitly provides it. The token is never written to RunBeacon profiles, jobs, dashboard state, or logs.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
          description: 'Reusable GitHub credential profile name.',
        },
        host: {
          type: 'string',
          enum: ['github.com'],
          default: 'github.com',
        },
        username: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: 'GitHub account name associated with the token.',
        },
        tokenEnvVar: {
          type: 'string',
          pattern: '^[A-Za-z_][A-Za-z0-9_]{0,127}$',
          description:
            'Preferred: read the token from this MCP server environment variable.',
        },
        token: {
          type: 'string',
          minLength: 20,
          maxLength: 2000,
          description:
            'Explicit memory-only token input. Use only when the user deliberately supplies a PAT in this conversation.',
        },
        makeDefault: {
          type: 'boolean',
          default: false,
          description:
            'Make this PAT profile the default GitHub credential after saving.',
        },
      },
      required: ['id', 'username'],
    },
    annotations: {
      title: 'Save GitHub Token',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'github_token_delete',
    description:
      'Delete a GitHub PAT created through github_token_save from the configured Git credential helper and remove its RunBeacon profile reference. This cannot delete generic OAuth/login profiles.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'RunBeacon GitHub PAT profile to delete.',
        },
      },
      required: ['id'],
    },
    annotations: {
      title: 'Delete GitHub Token',
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
            'Optional saved GitHub profile that reuses Git Credential Manager without exposing its token. When omitted, the default GitHub profile is selected unless githubToken is supplied.',
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
      'openai/outputTemplate': DASHBOARD_RESOURCE_URI,
    },
  } as Tool,
  {
    name: 'job_start',
    description:
      'Start one tracked local or SSH command. Pass remote shell commands verbatim without adding escapes. For a RunBeacon prompt trace, reuse requestTraceId on every retry so the server returns the original job instead of executing twice. When the user requests the default SSH server, set useDefaultCredential=true and call this tool directly without listing profiles first.',
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
          maxLength: 256,
          description:
            'Optional RE2-compatible regex (no backreferences or lookbehind); capture group 1 must contain a finite percentage.',
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
        useDefaultCredential: {
          type: 'boolean',
          default: false,
          description:
            'Fast path for an explicitly requested default SSH server. Set true directly without calling credential_profile_list first. Leave false for local commands.',
        },
        requestTraceId: {
          type: 'string',
          minLength: 36,
          maxLength: 64,
          description:
            'Opaque request UUID supplied by the RunBeacon prompt hook. Reuse it unchanged; a second start with the same trace returns the first job.',
        },
        requestReceivedAt: {
          type: 'string',
          description:
            'ISO timestamp supplied by the RunBeacon prompt hook for end-to-end latency measurement.',
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
    _meta: {
      ui: { resourceUri: DASHBOARD_RESOURCE_URI },
      'openai/outputTemplate': DASHBOARD_RESOURCE_URI,
    },
  } as Tool,
  {
    name: 'job_wait',
    description:
      'Wait inside the MCP server until a tracked job reaches a terminal state. This is event-driven and consumes no repeated model turns while waiting. Call it immediately as the next tool call after job_start, without intermediate commentary, profile listing, status checks, or extra planning.',
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
      'List tracked job history with bounded output tails. Live dashboards use job_snapshot for their single focused task.',
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
      'Render one live RunBeacon task. Pass jobId to reopen a known task; without it, the newest non-terminal task is selected. The UI calls job_snapshot directly, so updates do not create model turns or expose job history.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'Tracked task to display without showing other jobs.',
        },
      },
    },
    annotations: {
      title: 'Open Job Dashboard',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      ui: { resourceUri: DASHBOARD_RESOURCE_URI },
      'openai/outputTemplate': DASHBOARD_RESOURCE_URI,
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
        const makeDefault = args.makeDefault === true;
        const profileInput = { ...args };
        delete profileInput.makeDefault;
        if (
          profileInput.kind === 'ssh' &&
          profileInput.credentialKind === 'password'
        ) {
          throw new Error(
            'Use ssh_password_save to create an SSH password profile so its password is stored in the OS credential manager'
          );
        }
        const profile = credentialProfiles.save(
          profileInput as SaveCredentialProfileInput,
          makeDefault
        );
        return reply(
          { profile, isDefault: makeDefault },
          `Saved passwordless ${profile.kind} credential profile ${profile.id}${makeDefault ? ' as the default' : ''}. No secret material was stored.`
        );
      }
      case 'credential_profile_list': {
        const kind = optionalCredentialKind(args.kind);
        const defaults = credentialProfiles.defaults();
        const profiles = credentialProfiles.list(kind).map((profile) => ({
          ...profile,
          isDefault: defaults[profile.kind] === profile.id,
        }));
        return reply(
          { profiles, defaults },
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
      case 'credential_profile_set_default': {
        const profile = credentialProfiles.setDefault(String(args.id ?? ''));
        return reply(
          { profile, defaults: credentialProfiles.defaults() },
          `Set ${profile.id} as the default ${profile.kind} credential profile.`
        );
      }
      case 'credential_profile_clear_default': {
        const kind = optionalCredentialKind(args.kind);
        if (!kind) throw new Error('Credential profile kind is required');
        const profile = credentialProfiles.clearDefault(kind);
        return reply(
          {
            clearedProfileId: profile?.id,
            defaults: credentialProfiles.defaults(),
          },
          profile
            ? `Cleared ${profile.id} as the default ${kind} credential profile.`
            : `No default ${kind} credential profile was configured.`
        );
      }
      case 'ssh_password_save': {
        const makeDefault = args.makeDefault === true;
        const password = resolveSshPasswordInput(args);
        const profile = await sshPasswordProfiles.save({
          id: String(args.id ?? ''),
          host: String(args.host ?? ''),
          port: args.port === undefined ? 22 : Number(args.port),
          username: String(args.username ?? ''),
          password,
          hostKeySha256: optionalString(args.hostKeySha256),
          allowUnverifiedHostKey:
            args.allowUnverifiedHostKey === true ? true : undefined,
          makeDefault,
        });
        return reply(
          { profile, credentialStored: true, isDefault: makeDefault },
          `Saved SSH password profile ${profile.id}${makeDefault ? ' as the default' : ''} in the configured OS credential helper. RunBeacon stored only the safe connection reference.`
        );
      }
      case 'ssh_password_delete': {
        const deleted = await sshPasswordProfiles.delete(String(args.id ?? ''));
        return reply(
          {
            profileId: deleted.profile.id,
            credentialDeleted: deleted.credentialDeleted,
          },
          `Deleted SSH password profile ${deleted.profile.id} from the configured OS credential helper and RunBeacon.`
        );
      }
      case 'github_token_save': {
        const id = String(args.id ?? '').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
          throw new Error(
            'Credential profile id must contain 1 to 64 letters, numbers, dots, underscores, or hyphens'
          );
        }
        const existing = credentialProfiles
          .list()
          .find((profile) => profile.id === id);
        if (existing && existing.kind !== 'github') {
          throw new Error(`Credential profile ${id} is not a GitHub profile`);
        }
        const username = requiredString(args.username, 'username', 128);
        const token = resolveGitHubTokenInput(args);
        delete args.token;
        await saveGitHubTokenCredential({
          host: 'github.com',
          username,
          token,
        });
        const makeDefault = args.makeDefault === true;
        const profile = credentialProfiles.save(
          {
            id,
            kind: 'github',
            host: 'github.com',
            credentialSource: 'git',
            username,
            credentialKind: 'pat',
          },
          makeDefault
        );
        return reply(
          { profile, credentialStored: true, isDefault: makeDefault },
          `Saved GitHub PAT profile ${profile.id}${makeDefault ? ' as the default' : ''} in the configured Git credential helper. RunBeacon stored only the safe profile reference.`
        );
      }
      case 'github_token_delete': {
        const profile = requireGitHubProfile(String(args.id ?? ''));
        if (profile.credentialKind !== 'pat' || !profile.username) {
          throw new Error(
            `Credential profile ${profile.id} is not a PAT managed by RunBeacon`
          );
        }
        await deleteGitHubTokenCredential(profile.host, profile.username);
        credentialProfiles.delete(profile.id);
        return reply(
          { profileId: profile.id, credentialDeleted: true },
          `Deleted GitHub PAT profile ${profile.id} from the configured Git credential helper and RunBeacon.`
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
          : githubToken
            ? undefined
            : credentialProfiles.getDefault('github');
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
                    ? {
                        RUNBEACON_GITHUB_CREDENTIAL_SOURCE: 'git',
                        ...(credentialProfile.username
                          ? {
                              RUNBEACON_GITHUB_USERNAME:
                                credentialProfile.username,
                            }
                          : {}),
                      }
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
          { job, dashboardJobId: job.id },
          `GitHub publish job ${job.id} started. The dashboard tracks commit, push, and Actions without model polling; call job_wait once if you need to continue automatically.`
        );
      }
      case 'job_start': {
        const toolReceivedAt = new Date().toISOString();
        const input = await resolveJobStartInput(args);
        input.timing = resolveRequestTiming(
          args,
          toolReceivedAt,
          new Date().toISOString()
        );
        const job = await manager.start(input);
        return reply(
          { job, dashboardJobId: job.id },
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
        const requestedJobId = optionalString(args.jobId);
        const job = requestedJobId
          ? await manager.snapshot(requestedJobId, 8)
          : (await manager.list(8, 100)).find(
              (candidate) => !isTerminalJobState(candidate.state)
            );
        return reply(
          { job: job ?? null, dashboardJobId: job?.id ?? null },
          job
            ? `Opened the live dashboard for job ${job.id}.`
            : 'No active tracked task is available to display.'
        );
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

function requiredString(value: unknown, name: string, limit: number): string {
  const normalized = optionalString(value);
  if (!normalized || normalized.length > limit || /[\r\n\0]/.test(normalized)) {
    throw new Error(
      `${name} is required and must not exceed ${limit} characters`
    );
  }
  return normalized;
}

function resolveGitHubTokenInput(args: Record<string, any>): string {
  const inlineToken = optionalString(args.token);
  const environmentName = optionalString(args.tokenEnvVar);
  if (Boolean(inlineToken) === Boolean(environmentName)) {
    throw new Error('Provide exactly one of tokenEnvVar or token');
  }
  if (inlineToken) return inlineToken;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(environmentName ?? '')) {
    throw new Error('tokenEnvVar must be a valid environment variable name');
  }
  const token = process.env[environmentName!]?.trim();
  if (!token) {
    throw new Error(
      `GitHub token environment variable ${environmentName} is not available to the MCP server`
    );
  }
  return token;
}

function resolveSshPasswordInput(args: Record<string, any>): string {
  const inlinePassword =
    typeof args.password === 'string' && args.password.length > 0
      ? args.password
      : undefined;
  const environmentName = optionalString(args.passwordEnvVar);
  if (Boolean(inlinePassword) === Boolean(environmentName)) {
    throw new Error('Provide exactly one of passwordEnvVar or password');
  }
  if (inlinePassword !== undefined) return inlinePassword;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(environmentName ?? '')) {
    throw new Error('passwordEnvVar must be a valid environment variable name');
  }
  const password = process.env[environmentName!];
  if (!password) {
    throw new Error(
      `SSH password environment variable ${environmentName} is not available to the MCP server`
    );
  }
  return password;
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

async function resolveJobStartInput(
  args: Record<string, any>
): Promise<StartJobInput> {
  const input = { ...args } as Record<string, any>;
  delete input.credentialProfile;
  delete input.useDefaultCredential;
  delete input.requestTraceId;
  delete input.requestReceivedAt;
  const requestedProfile = optionalString(args.credentialProfile);
  const useDefaultCredential = args.useDefaultCredential === true;
  if (requestedProfile && useDefaultCredential) {
    throw new Error(
      'Use either credentialProfile or useDefaultCredential, not both'
    );
  }
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
  } else if (useDefaultCredential) {
    profile = credentialProfiles.getDefault('ssh');
    if (!profile) {
      throw new Error(
        'No default SSH credential profile is configured; set one with credential_profile_set_default'
      );
    }
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
    if (target?.username && String(target.username) !== profile.username) {
      throw new Error(
        `SSH profile ${profile.id} is for user ${profile.username}, not ${String(target.username)}`
      );
    }
    const hasInlineAuthentication = Boolean(
      target?.password || target?.privateKeyPath || target?.agent
    );
    const savedPassword =
      profile.credentialKind === 'password' && !hasInlineAuthentication
        ? await sshPasswordProfiles.read(profile)
        : undefined;
    if (
      profile.credentialKind === 'password' &&
      !hasInlineAuthentication &&
      !savedPassword
    ) {
      throw new Error(
        `SSH password for credential profile ${profile.id} is unavailable in the OS credential manager; save it again with ssh_password_save`
      );
    }
    target = {
      kind: 'ssh',
      host: profile.host,
      port: profile.port,
      username: profile.username,
      ...(savedPassword ? { password: savedPassword } : {}),
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
    if (!optionalString(target.host) || !optionalString(target.username)) {
      throw new Error(
        'SSH host and username are required when no credential profile supplies them'
      );
    }
    if (target.agent === 'auto') target.agent = resolveSshAgent();
    if (!target.password && !target.privateKeyPath && !target.agent) {
      throw new Error(
        'SSH authentication is missing. Save a credential with ssh_password_save or credential_profile_save, or provide a memory-only password for this job.'
      );
    }
    input.target = target as unknown as SshJobTarget;
  } else if (target) {
    input.target = target;
  }

  return input as StartJobInput;
}

function resolveRequestTiming(
  args: Record<string, any>,
  toolReceivedAt: string,
  credentialsResolvedAt: string
): StartJobInput['timing'] {
  const requestTraceId = optionalString(args.requestTraceId);
  const requestReceivedAt = optionalString(args.requestReceivedAt);
  if (!requestTraceId && !requestReceivedAt) {
    return { toolReceivedAt, credentialsResolvedAt };
  }
  if (!requestTraceId || !requestReceivedAt) {
    throw new Error(
      'requestTraceId and requestReceivedAt must be supplied together'
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requestTraceId
    )
  ) {
    throw new Error('requestTraceId must be a UUID');
  }
  const receivedMs = Date.parse(requestReceivedAt);
  const toolMs = Date.parse(toolReceivedAt);
  if (
    !Number.isFinite(receivedMs) ||
    receivedMs > toolMs + 5 * 60_000 ||
    receivedMs < toolMs - 24 * 60 * 60_000
  ) {
    throw new Error(
      'requestReceivedAt must be a valid timestamp within the last 24 hours'
    );
  }
  return {
    requestTraceId,
    requestReceivedAt: new Date(receivedMs).toISOString(),
    toolReceivedAt,
    credentialsResolvedAt,
  };
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
