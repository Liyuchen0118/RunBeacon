import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(root, 'dist', 'mcp', 'lifecycle-server.js');
const temporaryData = fs.mkdtempSync(
  path.join(os.tmpdir(), 'remote-job-monitor-mcp-')
);

assert.ok(fs.existsSync(serverPath), `Missing built server: ${serverPath}`);

const client = new Client({
  name: 'remote-job-monitor-smoke',
  version: '0.1.0',
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: {
    ...process.env,
    MCP_SERVER_MODE: 'true',
    PLUGIN_DATA: temporaryData,
    RJM_INLINE_MANAGER: 'true',
  },
});

try {
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, 'remote-job-monitor');

  const { tools } = await client.listTools();
  const toolNames = new Set(tools.map((tool) => tool.name));
  for (const name of [
    'job_start',
    'job_wait',
    'job_snapshot',
    'job_list',
    'job_cancel',
    'job_dashboard',
  ]) {
    assert.ok(toolNames.has(name), `Missing tool: ${name}`);
  }

  const script = [
    "console.log('25% boot')",
    "setTimeout(() => console.log('75% work'), 40)",
    "setTimeout(() => { console.log('100% complete'); process.exit(0) }, 90)",
  ].join(';');
  const started = await client.callTool({
    name: 'job_start',
    arguments: {
      command: process.execPath,
      args: ['-e', script],
      shell: false,
      label: 'mcp-smoke',
    },
  });
  assert.notEqual(started.isError, true);
  const jobId = started.structuredContent?.job?.id;
  assert.equal(typeof jobId, 'string');

  const completed = await client.callTool({
    name: 'job_wait',
    arguments: { jobId, timeoutMs: 10_000, tailLines: 40 },
  });
  assert.notEqual(completed.isError, true);
  assert.equal(completed.structuredContent?.timedOut, false);
  assert.equal(completed.structuredContent?.job?.state, 'succeeded');
  assert.equal(completed.structuredContent?.job?.progress?.percentage, 100);

  const { resources } = await client.listResources();
  const dashboard = resources.find(
    (resource) => resource.uri === 'ui://remote-job-monitor/dashboard.html'
  );
  assert.ok(dashboard, 'Dashboard resource is missing');
  const resource = await client.readResource({ uri: dashboard.uri });
  const html = resource.contents[0]?.text ?? '';
  assert.match(html, /ui\/initialize/);
  assert.match(html, /tools\/call/);

  const stateFile = path.join(temporaryData, 'jobs.json');
  assert.ok(fs.existsSync(stateFile));
  assert.doesNotMatch(fs.readFileSync(stateFile, 'utf8'), /100% complete/);

  process.stdout.write(
    `${JSON.stringify({
      server: client.getServerVersion(),
      tools: tools.length,
      lifecycle: 'passed',
      eventWait: 'passed',
      dashboardResource: 'passed',
      outputPersistenceDefault: 'off',
    })}\n`
  );
} finally {
  await client.close();
  fs.rmSync(temporaryData, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
