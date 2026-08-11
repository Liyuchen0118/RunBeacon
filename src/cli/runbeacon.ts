#!/usr/bin/env node
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '../lifecycle/DaemonClient.js';
import { isTerminalJobState, JobSnapshot } from '../lifecycle/types.js';
import { safeErrorMessage } from '../lifecycle/security.js';
import { resolveRunBeaconDataDir } from '../lifecycle/Environment.js';
import { CredentialProfileStore } from '../lifecycle/CredentialProfileStore.js';
import { createSshProfileResolver } from '../lifecycle/CredentialResolver.js';
import {
  probeSshHostKeyAlgorithm,
  SshRunnerTransport,
} from '../lifecycle/RunnerTransport.js';

const dataDir = resolveRunBeaconDataDir();
const daemonEntry = fileURLToPath(
  new URL('../daemon/lifecycle-daemon.js', import.meta.url)
);
const client = new DaemonClient(dataDir, daemonEntry);

void main().catch((error) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  await client.ensureReady();
  const [command = 'help', ...args] = process.argv.slice(2);
  switch (command) {
    case 'jobs':
      print(await client.list(8, numberOption(args, '--limit', 100)));
      break;
    case 'show':
      print(await client.snapshot(requiredArg(args, 0, 'jobId'), 120));
      break;
    case 'wait':
      print(
        await client.waitForTerminal(
          requiredArg(args, 0, 'jobId'),
          numberOption(args, '--timeout-ms', 86_400_000),
          120
        )
      );
      break;
    case 'events':
      await streamEvents(requiredArg(args, 0, 'jobId'));
      break;
    case 'cancel':
      print(await client.cancel(requiredArg(args, 0, 'jobId')));
      break;
    case 'approve':
      print(await client.approve(requiredArg(args, 0, 'jobId')));
      break;
    case 'reject':
      print(await client.rejectApproval(requiredArg(args, 0, 'jobId')));
      break;
    case 'policy':
      await policy(args);
      break;
    case 'subscriptions':
      await subscriptions(args);
      break;
    case 'runner':
      await runner(args);
      break;
    case 'audit':
      print(
        await client.queryAudit({
          jobId: stringOption(args, '--job'),
          action: stringOption(args, '--action'),
          since: stringOption(args, '--since'),
          limit: numberOption(args, '--limit', 100),
        })
      );
      break;
    case 'dashboard':
      await dashboard(
        args[0] || (await currentJob())?.id,
        numberOption(args, '--port', 8765)
      );
      break;
    case 'doctor':
      print(await client.status());
      break;
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(helpText);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function runner(args: string[]): Promise<void> {
  const action = args[0] ?? 'probe';
  if (action === 'probe' || action === 'migrate-host-key') {
    const profiles = new CredentialProfileStore(
      join(dataDir, 'credential-profiles.json')
    );
    const requested = stringOption(args, '--profile');
    const profile = requested
      ? profiles.get(requested)
      : profiles.getDefault('ssh');
    if (!profile || profile.kind !== 'ssh') {
      throw new Error(
        'runner probe requires an SSH profile or default SSH profile'
      );
    }
    const target = await createSshProfileResolver(dataDir)(profile.id);
    if (action === 'migrate-host-key') {
      const algorithm = await probeSshHostKeyAlgorithm(target);
      const { createdAt, updatedAt, ...safe } = profile;
      void createdAt;
      void updatedAt;
      print({
        profile: profiles.save({ ...safe, hostKeyAlgorithm: algorithm }),
        hostKeyAlgorithm: algorithm,
      });
      return;
    }
    print({
      profile: profile.id,
      ...(await new SshRunnerTransport(target).call('ping', {}, 20_000)),
    });
    return;
  }
  if (action === 'install' || action === 'upgrade') {
    runInteractive('runbeacon-runner-install', []);
    return;
  }
  if (action === 'uninstall') {
    const binary =
      process.platform === 'darwin'
        ? join(
            homedir(),
            'Library',
            'Application Support',
            'RunBeacon',
            'bin',
            'runbeacon-runner'
          )
        : join(homedir(), '.local', 'bin', 'runbeacon-runner');
    runInteractive(binary, ['uninstall']);
    return;
  }
  throw new Error(
    'runner action must be probe, migrate-host-key, install, upgrade, or uninstall'
  );
}

async function subscriptions(args: string[]): Promise<void> {
  const action = args[0] ?? 'list';
  if (action === 'list') {
    print(await client.listEventSubscriptions());
    return;
  }
  if (action === 'delete') {
    print(await client.deleteEventSubscription(requiredArg(args, 1, 'id')));
    return;
  }
  if (action === 'save') {
    const id = requiredArg(args, 1, 'id');
    const kind = requiredArg(args, 2, 'kind');
    if (kind !== 'codex' && kind !== 'desktop' && kind !== 'webhook') {
      throw new Error('subscription kind must be codex, desktop, or webhook');
    }
    print(
      await client.saveEventSubscription({
        id,
        kind,
        urlEnvVar: stringOption(args, '--url-env'),
        hmacSecretEnvVar: stringOption(args, '--hmac-secret-env'),
      })
    );
    return;
  }
  throw new Error('subscriptions action must be list, save, or delete');
}

function runInteractive(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

async function policy(args: string[]): Promise<void> {
  if (args[0] !== 'set') {
    print(await client.policyConfig());
    return;
  }
  const risk = requiredArg(args, 1, 'risk');
  if (!['privileged', 'credential', 'release', 'destructive'].includes(risk)) {
    throw new Error(
      'risk must be privileged, credential, release, or destructive'
    );
  }
  const enabled = requiredArg(args, 2, 'on|off');
  if (enabled !== 'on' && enabled !== 'off') {
    throw new Error('policy value must be on or off');
  }
  print(
    await client.updatePolicy({
      requireApproval: { [risk]: enabled === 'on' },
    })
  );
}

async function streamEvents(jobId: string): Promise<void> {
  let job = await client.snapshot(jobId, 20);
  print(job);
  while (!isTerminalJobState(job.state)) {
    const result = await client.watchForChange(jobId, job.version, 25_000, 20);
    job = result.job;
    if (result.changed) print(job);
  }
}

async function currentJob(): Promise<JobSnapshot | undefined> {
  const jobs = await client.list(0, 100);
  return jobs.find((job) => !isTerminalJobState(job.state)) ?? jobs[0];
}

async function dashboard(
  jobId: string | undefined,
  preferredPort: number
): Promise<void> {
  if (!jobId) throw new Error('No tracked job is available for the dashboard');
  await client.snapshot(jobId, 1);
  const server = createServer((request, response) => {
    void handleDashboardRequest(jobId, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(preferredPort, '127.0.0.1', resolve);
  }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE') throw error;
    await new Promise<void>((resolve, reject) => {
      server.removeAllListeners('error');
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Dashboard failed to bind');
  process.stdout.write(`http://127.0.0.1:${address.port}/\n`);
  await new Promise<void>((resolve) => {
    const close = () => server.close(() => resolve());
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}

async function handleDashboardRequest(
  jobId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'"
    );
    if (request.method === 'GET' && url.pathname === '/') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(loopbackHtml(jobId));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/watch') {
      const afterVersion = Math.max(
        0,
        Number(url.searchParams.get('afterVersion')) || 0
      );
      json(
        response,
        await client.watchForChange(jobId, afterVersion, 25_000, 12)
      );
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/cancel') {
      json(response, await client.cancel(jobId));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/approve') {
      json(response, await client.approve(jobId));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/reject') {
      json(response, await client.rejectApproval(jobId));
      return;
    }
    response.statusCode = 404;
    response.end('Not found');
  } catch {
    response.statusCode = 500;
    json(response, { error: 'RunBeacon request failed' });
  }
}

function json(response: ServerResponse, value: unknown): void {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

function loopbackHtml(jobId: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RunBeacon</title><style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;padding:16px;background:Canvas;color:CanvasText}main{max-width:860px;margin:auto}header,.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.state{font-weight:700}.panel{border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:8px;padding:12px;margin-top:12px}pre{max-height:55vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}button{padding:6px 10px}progress{width:100%;margin-top:12px}</style></head><body><main><header><h1>RunBeacon</h1><span id="live">Connecting</span></header><section class="panel"><div class="row"><strong id="label"></strong><span class="state" id="state"></span></div><div id="execution"></div><progress id="progress" max="100"></progress><pre id="output"></pre><div id="approval"><button id="approve">Approve</button><button id="reject">Reject</button></div><button id="cancel">Cancel</button></section></main><script>const jobId=${JSON.stringify(jobId)};let version=0,active=true;const terminal=new Set(['succeeded','failed','cancelled','timed_out','lost']);const esc=(v)=>String(v??'');function render(job){version=job.version;label.textContent=job.label;state.textContent=job.state;execution.textContent=[job.execution?.durable?'Durable':'Direct',job.execution?.phase,job.execution?.connectionState,'reconnects '+(job.execution?.reconnectCount||0)].filter(Boolean).join(' | ');progress.value=job.progress?.percentage||0;output.textContent=(job.tail||[]).map(x=>x.data).join('');approval.hidden=job.execution?.phase!=='awaiting_approval';cancel.hidden=terminal.has(job.state);if(terminal.has(job.state)){active=false;live.textContent='Complete'}}async function post(path){const r=await fetch(path,{method:'POST'});render(await r.json())}approve.onclick=()=>post('/api/approve');reject.onclick=()=>post('/api/reject');cancel.onclick=()=>post('/api/cancel');(async()=>{while(active&&!document.hidden){try{const r=await fetch('/api/watch?afterVersion='+version);const v=await r.json();render(v.job);live.textContent='Live'}catch{live.textContent='Reconnecting';await new Promise(r=>setTimeout(r,1000))}}})();document.addEventListener('visibilitychange',()=>{if(!document.hidden)location.reload()});</script></body></html>`;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requiredArg(args: string[], index: number, name: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

function stringOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function numberOption(args: string[], name: string, fallback: number): number {
  const value = Number(stringOption(args, name));
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

const helpText = `RunBeacon 3 CLI\n\nrunbeacon jobs [--limit N]\nrunbeacon show <jobId>\nrunbeacon wait <jobId> [--timeout-ms N]\nrunbeacon events <jobId>\nrunbeacon cancel <jobId>\nrunbeacon approve <jobId>\nrunbeacon reject <jobId>\nrunbeacon dashboard [jobId] [--port N]\nrunbeacon runner probe [--profile ID]\nrunbeacon runner migrate-host-key [--profile ID]\nrunbeacon runner install|upgrade|uninstall\nrunbeacon policy\nrunbeacon policy set <risk> <on|off>\nrunbeacon subscriptions list\nrunbeacon subscriptions save <id> <codex|desktop|webhook> [--url-env NAME] [--hmac-secret-env NAME]\nrunbeacon subscriptions delete <id>\nrunbeacon audit [--job ID] [--action ACTION] [--since ISO]\nrunbeacon doctor\n`;
