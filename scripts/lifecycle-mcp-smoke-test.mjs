import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(root, 'dist', 'mcp', 'lifecycle-server.js');
const temporaryData = fs.mkdtempSync(
  path.join(os.tmpdir(), 'remote-job-monitor-mcp-')
);
const credentialHelperPath = path.join(temporaryData, 'credential-helper.cjs');
const credentialHelperState = path.join(
  temporaryData,
  'credential-helper-state.json'
);
fs.writeFileSync(
  credentialHelperPath,
  [
    "'use strict';",
    "const fs = require('node:fs');",
    'const [statePath, action] = process.argv.slice(2);',
    "let input = '';",
    "const parse = text => Object.fromEntries(text.split(/\\r?\\n/).filter(Boolean).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));",
    "const load = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => { input += chunk; });",
    "process.stdin.on('end', () => {",
    '  const query = parse(input);',
    "  const key = [query.protocol || '', query.host || '', query.username || ''].join('|');",
    '  const entries = load();',
    "  if (action === 'store') { entries[key] = input; fs.writeFileSync(statePath, JSON.stringify(entries)); }",
    "  if (action === 'get' && entries[key]) process.stdout.write(entries[key]);",
    "  if (action === 'erase') { delete entries[key]; fs.writeFileSync(statePath, JSON.stringify(entries)); }",
    '});',
  ].join('\n')
);
const credentialHelperCommand = `!node ${credentialHelperPath.replaceAll('\\', '/')} ${credentialHelperState.replaceAll('\\', '/')}`;

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
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: credentialHelperCommand,
  },
});

try {
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, 'remote-job-monitor');
  assert.equal(client.getServerVersion()?.version, '1.0.0');

  const { tools } = await client.listTools();
  const toolNames = new Set(tools.map((tool) => tool.name));
  for (const name of [
    'job_start',
    'job_wait',
    'job_snapshot',
    'job_list',
    'job_cancel',
    'job_dashboard',
    'github_publish_start',
    'credential_profile_save',
    'credential_profile_list',
    'credential_profile_delete',
    'credential_profile_set_default',
    'credential_profile_clear_default',
    'ssh_password_save',
    'ssh_password_delete',
    'github_token_save',
    'github_token_delete',
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

  const rejectedProfile = await client.callTool({
    name: 'credential_profile_save',
    arguments: {
      id: 'unsafe-profile',
      kind: 'ssh',
      host: '127.0.0.1',
      username: 'test',
      agent: 'auto',
      allowUnverifiedHostKey: true,
      password: 'PROFILE_SECRET_MUST_NOT_PERSIST_7416',
    },
  });
  assert.equal(rejectedProfile.isError, true);

  const rejectedTokenImport = await client.callTool({
    name: 'github_token_save',
    arguments: {
      id: 'missing-token',
      username: 'runbeacon-smoke',
      tokenEnvVar: 'RUNBEACON_MISSING_GITHUB_TOKEN_7416',
    },
  });
  assert.equal(rejectedTokenImport.isError, true);

  const sshPasswordCanary = 'SSH_PASSWORD_MUST_NOT_LEAVE_OS_STORE_5926';
  const savedPasswordProfile = await client.callTool({
    name: 'ssh_password_save',
    arguments: {
      id: 'ssh-password-smoke',
      host: '127.0.0.1',
      port: 1,
      username: 'test',
      password: sshPasswordCanary,
      allowUnverifiedHostKey: true,
      makeDefault: true,
    },
  });
  assert.notEqual(savedPasswordProfile.isError, true);
  assert.equal(
    savedPasswordProfile.structuredContent?.profile?.credentialKind,
    'password'
  );
  assert.doesNotMatch(
    JSON.stringify(savedPasswordProfile),
    new RegExp(sshPasswordCanary)
  );

  for (const profile of [
    {
      id: 'github-main',
      kind: 'github',
      host: 'github.com',
      credentialSource: 'git',
      username: 'runbeacon-smoke',
    },
    {
      id: 'ssh-key-smoke',
      kind: 'ssh',
      host: '127.0.0.2',
      port: 1,
      username: 'test',
      privateKeyPath: path.join(temporaryData, 'missing-test-key'),
      allowUnverifiedHostKey: true,
    },
  ]) {
    const saved = await client.callTool({
      name: 'credential_profile_save',
      arguments: profile,
    });
    assert.notEqual(saved.isError, true);
  }
  for (const id of ['github-main']) {
    const selected = await client.callTool({
      name: 'credential_profile_set_default',
      arguments: { id },
    });
    assert.notEqual(selected.isError, true);
  }
  const profiles = await client.callTool({
    name: 'credential_profile_list',
    arguments: {},
  });
  assert.equal(profiles.structuredContent?.profiles?.length, 3);
  assert.deepEqual(profiles.structuredContent?.defaults, {
    github: 'github-main',
    ssh: 'ssh-password-smoke',
  });
  assert.doesNotMatch(JSON.stringify(profiles), new RegExp(sshPasswordCanary));

  const profileJob = await client.callTool({
    name: 'job_start',
    arguments: {
      command: 'echo profile-smoke',
      useDefaultCredential: true,
      timeoutMs: 1_000,
    },
  });
  assert.notEqual(profileJob.isError, true);
  assert.equal(profileJob.structuredContent?.job?.target?.kind, 'ssh');
  assert.equal(
    profileJob.structuredContent?.job?.metadata?.credentialProfile,
    'ssh-password-smoke'
  );
  assert.doesNotMatch(
    JSON.stringify(profileJob),
    new RegExp(sshPasswordCanary)
  );
  const profileJobResult = await client.callTool({
    name: 'job_wait',
    arguments: {
      jobId: profileJob.structuredContent?.job?.id,
      timeoutMs: 5_000,
    },
  });
  assert.equal(profileJobResult.structuredContent?.job?.state, 'failed');
  assert.doesNotMatch(
    JSON.stringify(profileJobResult),
    new RegExp(sshPasswordCanary)
  );

  const matchedPasswordJob = await client.callTool({
    name: 'job_start',
    arguments: {
      command: 'echo matched-password-profile',
      target: {
        kind: 'ssh',
        host: '127.0.0.1',
        port: 1,
        username: 'test',
      },
      timeoutMs: 1_000,
    },
  });
  assert.notEqual(matchedPasswordJob.isError, true);
  assert.equal(
    matchedPasswordJob.structuredContent?.job?.metadata?.credentialProfile,
    'ssh-password-smoke'
  );
  const matchedPasswordResult = await client.callTool({
    name: 'job_wait',
    arguments: {
      jobId: matchedPasswordJob.structuredContent?.job?.id,
      timeoutMs: 5_000,
    },
  });
  assert.equal(matchedPasswordResult.structuredContent?.job?.state, 'failed');

  const dashboardWithPasswordJob = await client.callTool({
    name: 'job_dashboard',
    arguments: {},
  });
  assert.doesNotMatch(
    JSON.stringify(dashboardWithPasswordJob),
    new RegExp(sshPasswordCanary)
  );

  const repository = path.join(temporaryData, 'publish-worktree');
  const remote = path.join(temporaryData, 'publish-remote.git');
  fs.mkdirSync(repository);
  runGit(temporaryData, ['init', '--bare', remote]);
  runGit(repository, ['init']);
  runGit(repository, ['checkout', '-b', 'main']);
  runGit(repository, ['config', 'user.name', 'RunBeacon Smoke']);
  runGit(repository, ['config', 'user.email', 'runbeacon@example.invalid']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# smoke\n');
  runGit(repository, ['add', 'README.md']);
  runGit(repository, ['commit', '-m', 'initial']);
  runGit(repository, ['remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(repository, 'dashboard.txt'), 'tracked\n');
  runGit(repository, ['add', 'dashboard.txt']);

  const publishing = await client.callTool({
    name: 'github_publish_start',
    arguments: {
      cwd: repository,
      commitMessage: 'test: dashboard publish',
      watchActions: false,
      githubToken: 'GITHUB_TOKEN_MUST_NOT_PERSIST_4862',
      credentialProfile: 'github-main',
      idempotencyKey: 'lifecycle-mcp-smoke-publish',
    },
  });
  assert.notEqual(publishing.isError, true);
  const publishJobId = publishing.structuredContent?.job?.id;
  assert.equal(typeof publishJobId, 'string');
  assert.equal(
    publishing.structuredContent?.job?.metadata?.kind,
    'github_publish'
  );
  assert.equal(
    publishing.structuredContent?.job?.metadata?.credentialProfile,
    'github-main'
  );

  const published = await client.callTool({
    name: 'job_wait',
    arguments: { jobId: publishJobId, timeoutMs: 20_000, tailLines: 80 },
  });
  assert.notEqual(published.isError, true);
  assert.equal(published.structuredContent?.job?.state, 'succeeded');
  assert.equal(published.structuredContent?.job?.progress?.percentage, 100);
  assert.equal(published.structuredContent?.job?.progress?.phase, 'complete');
  assert.match(
    published.structuredContent?.job?.progress?.message ?? '',
    /Push completed/
  );
  assert.equal(
    runGit(repository, ['log', '-1', '--pretty=%s']).stdout.trim(),
    'test: dashboard publish'
  );

  const defaultPublishing = await client.callTool({
    name: 'github_publish_start',
    arguments: {
      cwd: repository,
      watchActions: false,
      idempotencyKey: 'lifecycle-mcp-smoke-default-publish',
    },
  });
  assert.notEqual(defaultPublishing.isError, true);
  assert.equal(
    defaultPublishing.structuredContent?.job?.metadata?.credentialProfile,
    'github-main'
  );
  const defaultPublished = await client.callTool({
    name: 'job_wait',
    arguments: {
      jobId: defaultPublishing.structuredContent?.job?.id,
      timeoutMs: 20_000,
    },
  });
  assert.equal(defaultPublished.structuredContent?.job?.state, 'succeeded');

  const clearedDefault = await client.callTool({
    name: 'credential_profile_clear_default',
    arguments: { kind: 'github' },
  });
  assert.notEqual(clearedDefault.isError, true);
  assert.equal(clearedDefault.structuredContent?.defaults?.github, undefined);

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
  assert.doesNotMatch(
    fs.readFileSync(stateFile, 'utf8'),
    /GITHUB_TOKEN_MUST_NOT_PERSIST_4862/
  );
  assert.doesNotMatch(
    fs.readFileSync(stateFile, 'utf8'),
    new RegExp(sshPasswordCanary)
  );
  const credentialStateFile = path.join(
    temporaryData,
    'credential-profiles.json'
  );
  assert.ok(fs.existsSync(credentialStateFile));
  assert.doesNotMatch(
    fs.readFileSync(credentialStateFile, 'utf8'),
    /PROFILE_SECRET_MUST_NOT_PERSIST_7416/
  );
  assert.doesNotMatch(
    fs.readFileSync(credentialStateFile, 'utf8'),
    new RegExp(sshPasswordCanary)
  );

  const deletedPasswordProfile = await client.callTool({
    name: 'ssh_password_delete',
    arguments: { id: 'ssh-password-smoke' },
  });
  assert.notEqual(deletedPasswordProfile.isError, true);
  assert.equal(
    deletedPasswordProfile.structuredContent?.credentialDeleted,
    true
  );
  assert.doesNotMatch(
    fs.readFileSync(credentialHelperState, 'utf8'),
    new RegExp(sshPasswordCanary)
  );

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

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`
  );
  return result;
}
