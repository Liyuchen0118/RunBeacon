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
import {
  DaemonClient,
  LifecycleService,
} from '../lifecycle/DaemonClient.js';
import {
  createDashboardHtml,
  DASHBOARD_RESOURCE_URI,
  MCP_APP_MIME_TYPE,
} from '../lifecycle/DashboardApp.js';
import { safeErrorMessage } from '../lifecycle/security.js';
import { StartJobInput } from '../lifecycle/types.js';

process.env.MCP_SERVER_MODE = 'true';

const pluginData =
  process.env.PLUGIN_DATA ||
  process.env.CLAUDE_PLUGIN_DATA ||
  join(homedir(), '.remote-job-monitor');

let manager: LifecycleService;
if (process.env.RJM_INLINE_MANAGER === 'true') {
  manager = new LifecycleManager({
    statePath: process.env.RJM_STATE_PATH || join(pluginData, 'jobs.json'),
    maxConcurrentJobs: Number(process.env.RJM_MAX_CONCURRENT_JOBS || 4),
    maxOutputBytes: Number(process.env.RJM_MAX_OUTPUT_BYTES || 1024 * 1024),
    persistOutput: process.env.RJM_PERSIST_OUTPUT === 'true',
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
      description: 'Pinned SSH host-key fingerprint, with or without SHA256: prefix.',
    },
    allowUnverifiedHostKey: {
      type: 'boolean',
      default: false,
      description: 'Explicit insecure override when no pinned host key is available.',
    },
  },
  required: ['kind', 'host', 'username'],
};

const tools: Tool[] = [
  {
    name: 'job_start',
    description:
      'Start a tracked local or SSH command. Use this instead of raw shell/ssh for long-running work so lifecycle events, output, progress, cancellation, and event-driven waiting remain available.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Local command or complete remote shell command.' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Local command arguments. For SSH, include arguments in command.',
        },
        cwd: { type: 'string', description: 'Local working directory.' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Local environment overrides. Values are never persisted.',
        },
        shell: { type: 'boolean', default: true, description: 'Use a local shell.' },
        label: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1, default: 86400000 },
        target: {
          oneOf: [
            { type: 'object', properties: { kind: { type: 'string', enum: ['local'] } }, required: ['kind'] },
            sshTargetSchema,
          ],
        },
        progressPattern: {
          type: 'string',
          description: 'Optional regex; capture group 1 must contain a percentage.',
        },
        metadata: { type: 'object' },
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
          description: 'Maximum server-side wait; no polling by the model occurs.',
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
    description: 'Read one tracked job and a bounded output tail. Use only for explicit status requests; prefer job_wait for completion.',
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
    description: 'List tracked jobs with bounded output tails. The dashboard calls this directly without model tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        tailLines: { type: 'integer', minimum: 0, maximum: 50, default: 8 },
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
      'Render the live Remote Job Monitor dashboard. The UI refreshes by calling job_list directly, so updates do not create model turns or consume model tokens.',
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
  { name: 'remote-job-monitor', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: DASHBOARD_RESOURCE_URI,
      name: 'Remote Job Monitor Dashboard',
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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, any>;
  try {
    switch (request.params.name) {
      case 'job_start': {
        const job = await manager.start(args as StartJobInput);
        return reply(
          { job },
          `Tracked job ${job.id} queued. Call job_wait once to resume when it finishes; do not poll.`
        );
      }
      case 'job_wait': {
        const result = await manager.waitForTerminal(
          String(args.jobId),
          args.timeoutMs,
          args.tailLines
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
        const jobs = await manager.list(args.tailLines);
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
      content: [
        { type: 'text', text: safeErrorMessage(error) } as TextContent,
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
