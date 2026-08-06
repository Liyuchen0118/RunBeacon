import { RUNBEACON_VERSION } from './protocol.js';

export const DASHBOARD_RESOURCE_URI = 'ui://remote-job-monitor/dashboard.html';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export function createDashboardHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>RunBeacon</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 16px; background: Canvas; color: CanvasText; }
    header { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px; }
    h1 { font-size:18px; margin:0; }
    #connection { font-size:12px; opacity:.7; }
    .launcher { border:1px solid color-mix(in srgb, #2563eb 28%, transparent); border-radius:12px; padding:12px; margin-bottom:14px; background:color-mix(in srgb, #2563eb 6%, Canvas); }
    .launcher-title { font-size:13px; font-weight:700; margin-bottom:7px; }
    .launcher textarea { box-sizing:border-box; width:100%; min-height:84px; resize:vertical; border:1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius:8px; padding:8px; background:Canvas; color:CanvasText; font:12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .launcher-row { display:flex; align-items:center; gap:8px; margin-top:8px; }
    .launcher-row input { flex:1; min-width:0; border:1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius:7px; padding:6px 8px; background:Canvas; color:CanvasText; }
    #launch-status { font-size:12px; opacity:.75; margin-top:7px; min-height:1.2em; }
    #jobs { display:grid; gap:10px; }
    .empty { opacity:.7; border:1px dashed color-mix(in srgb, CanvasText 25%, transparent); border-radius:10px; padding:22px; text-align:center; }
    .job { border:1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius:12px; padding:12px; background:color-mix(in srgb, Canvas 96%, CanvasText 4%); }
    .top { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
    .label { font-weight:650; overflow-wrap:anywhere; }
    .meta { margin-top:3px; font-size:12px; opacity:.7; }
    .state { border-radius:999px; padding:3px 8px; font-size:11px; font-weight:700; text-transform:uppercase; white-space:nowrap; }
    .running,.queued { background:#2563eb22; color:#2563eb; }
    .succeeded { background:#16a34a22; color:#16a34a; }
    .failed,.timed_out,.orphaned { background:#dc262622; color:#dc2626; }
    .cancelled { background:#64748b22; color:#64748b; }
    .bar { margin-top:10px; height:7px; background:color-mix(in srgb, CanvasText 12%, transparent); border-radius:999px; overflow:hidden; }
    .fill { height:100%; background:#2563eb; transition:width .2s ease; }
    .progress-info { display:flex; align-items:center; gap:7px; margin-top:7px; font-size:12px; overflow-wrap:anywhere; }
    .phase { border-radius:999px; padding:2px 7px; background:#2563eb18; color:#2563eb; font-weight:700; white-space:nowrap; }
    .github { margin-top:7px; font-size:12px; padding:6px 8px; border-radius:7px; background:color-mix(in srgb, #2563eb 8%, transparent); }
    .timing { margin-top:7px; font-size:12px; padding:6px 8px; border-radius:7px; background:color-mix(in srgb, #16a34a 8%, transparent); overflow-wrap:anywhere; }
    pre { max-height:150px; overflow:auto; margin:10px 0 0; padding:9px; border-radius:8px; background:color-mix(in srgb, CanvasText 7%, transparent); font:11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
    button { border:1px solid color-mix(in srgb, CanvasText 20%, transparent); background:transparent; color:inherit; border-radius:7px; padding:5px 9px; cursor:pointer; }
    button:hover { background:color-mix(in srgb, CanvasText 8%, transparent); }
    button:disabled { opacity:.45; cursor:not-allowed; }
  </style>
</head>
<body>
  <header><h1>RunBeacon</h1><span id="connection">Connecting...</span></header>
  <section class="launcher">
    <div class="launcher-title">Direct default SSH start | bypasses model scheduling</div>
    <textarea id="launch-command" spellcheck="false" placeholder="Paste the remote shell command exactly as it should run"></textarea>
    <div class="launcher-row">
      <input id="launch-progress" aria-label="Progress pattern" placeholder="Optional progress regex, e.g. (\\d+)%" />
      <button id="launch-button" type="button">Run on default SSH</button>
    </div>
    <div id="launch-status">The command stays in this app and is sent directly to RunBeacon.</div>
  </section>
  <main id="jobs"><div class="empty">Waiting for the current task...</div></main>
  <script>
    (() => {
      const jobsEl = document.getElementById('jobs');
      const connectionEl = document.getElementById('connection');
      const launchCommandEl = document.getElementById('launch-command');
      const launchProgressEl = document.getElementById('launch-progress');
      const launchButtonEl = document.getElementById('launch-button');
      const launchStatusEl = document.getElementById('launch-status');
      let rpcId = 0;
      let ready;
      let refreshing = false;
      let refreshTimer;
      let renderedSignature = null;
      let latestJobs = [];
      let focusedJobId;
      let launcherAttempt;
      const pending = new Map();

      const notify = (method, params) => window.parent.postMessage({ jsonrpc:'2.0', method, params }, '*');
      const request = (method, params) => new Promise((resolve, reject) => {
        const id = ++rpcId;
        pending.set(id, { resolve, reject });
        window.parent.postMessage({ jsonrpc:'2.0', id, method, params }, '*');
      });
      const structured = (value) =>
        value?.structuredContent ?? value?.result?.structuredContent ?? value?.params?.structuredContent;

      window.addEventListener('message', (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== '2.0') return;
        if (message.id !== undefined) {
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          message.error ? waiter.reject(message.error) : waiter.resolve(message.result);
          return;
        }
        if (message.method === 'ui/notifications/tool-result') {
          const data = structured(message.params);
          if (data?.dashboardJobId && data?.job?.id === data.dashboardJobId) {
            focusedJobId = data.dashboardJobId;
            render([data.job]);
            scheduleRefresh(isTerminal(data.job.state) ? 5000 : 0);
          } else if (focusedJobId && data?.job?.id === focusedJobId) {
            render([data.job]);
            scheduleRefresh(isTerminal(data.job.state) ? 5000 : 0);
          } else if (data?.dashboardJobId === null) {
            focusedJobId = undefined;
            render([]);
          }
        }
      }, { passive:true });

      const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
      })[char]);
      const isTerminal = (state) => ['succeeded','failed','cancelled','timed_out','orphaned'].includes(state);
      const targetLabel = (target) => target?.kind === 'ssh'
        ? (target.username || '') + '@' + (target.host || '') + ':' + (target.port || 22)
        : 'local';
      const duration = (ms) => {
        const seconds = Math.max(0, Math.round((ms || 0) / 1000));
        if (seconds < 60) return seconds + 's';
        const minutes = Math.floor(seconds / 60);
        return minutes + 'm ' + (seconds % 60) + 's';
      };
      const between = (start, end) => {
        const startMs = Date.parse(start || '');
        const endMs = Date.parse(end || '');
        return Number.isFinite(startMs) && Number.isFinite(endMs)
          ? Math.max(0, endMs - startMs)
          : null;
      };
      const requestId = () => globalThis.crypto?.randomUUID?.() ||
        '00000000-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12);

      function timingHtml(job) {
        const timing = job.timing || {};
        const finishedOrNow = job.finishedAt || new Date().toISOString();
        const segments = [
          ['prompt→tool', between(timing.requestReceivedAt, timing.toolReceivedAt)],
          ['credential', between(timing.toolReceivedAt, timing.credentialsResolvedAt)],
          ['queue', between(job.createdAt, job.startedAt)],
          ['SSH', between(job.startedAt, timing.sshReadyAt)],
          ['command', between(timing.commandStartedAt || job.startedAt, finishedOrNow)],
          ['total', between(timing.requestReceivedAt || job.createdAt, finishedOrNow)],
        ].filter((entry) => entry[1] !== null);
        return segments.length
          ? '<div class="timing">Timing | ' + segments.map((entry) =>
              escapeHtml(entry[0]) + ' ' + duration(entry[1])
            ).join(' | ') + '</div>'
          : '';
      }

      function render(jobs) {
        latestJobs = jobs || [];
        const signature = latestJobs.map((job) => {
          const elapsedBucket = isTerminal(job.state)
            ? 'terminal'
            : Math.floor((job.assessment?.elapsedMs || 0) / 5000);
          return job.id + ':' + job.version + ':' + elapsedBucket;
        }).join('|');
        if (signature === renderedSignature) return;
        renderedSignature = signature;
        if (!jobs?.length) {
          jobsEl.innerHTML = '<div class="empty">Waiting for the current task...</div>';
          return;
        }
        jobsEl.innerHTML = jobs.map((job) => {
          const progress = Number.isFinite(job.progress?.percentage) ? job.progress.percentage : null;
          const tail = (job.tail || []).map((chunk) => '[' + chunk.stream + '] ' + chunk.data).join('').slice(-8000);
          const progressBar = progress === null ? ''
            : '<div class="bar" title="' + progress + '%"><div class="fill" style="width:' + Math.max(0,Math.min(100,progress)) + '%"></div></div>';
          const progressInfo = !job.progress ? ''
            : '<div class="progress-info">' +
                (job.progress.phase ? '<span class="phase">' + escapeHtml(job.progress.phase) + '</span>' : '') +
                '<span>' + escapeHtml(job.progress.message || (progress === null ? '' : progress + '%')) + '</span>' +
              '</div>';
          const github = job.metadata?.kind === 'github_publish'
            ? '<div class="github">GitHub | remote ' + escapeHtml(job.metadata.remote || 'origin') +
              ' | branch ' + escapeHtml(job.metadata.branch || 'current') +
              ' | Actions ' + (job.metadata.watchActions === false ? 'not monitored' : 'monitored') +
              (job.metadata.credentialProfile ? ' | credential ' + escapeHtml(job.metadata.credentialProfile) : '') + '</div>'
            : '';
          const credential = job.metadata?.credentialProfile && job.metadata?.kind !== 'github_publish'
            ? '<div class="github">Credential profile | ' + escapeHtml(job.metadata.credentialProfile) + '</div>'
            : '';
          const timing = timingHtml(job);
          const output = tail ? '<pre>' + escapeHtml(tail) + '</pre>' : '';
          const cancel = isTerminal(job.state) ? ''
            : '<div style="margin-top:9px"><button data-cancel="' + escapeHtml(job.id) + '">Cancel</button></div>';
          return '<section class="job">' +
            '<div class="top">' +
              '<div><div class="label">' + escapeHtml(job.label) + '</div>' +
              '<div class="meta">' + escapeHtml(targetLabel(job.target)) + ' | ' + escapeHtml(job.id.slice(0,8)) + ' | elapsed ' + duration(job.assessment?.elapsedMs) + ' | ' + escapeHtml(job.assessment?.health || '') + '</div>' +
              '<div class="meta">' + escapeHtml(job.assessment?.summary || '') + '</div></div>' +
              '<span class="state ' + escapeHtml(job.state) + '">' + escapeHtml(job.state) + '</span>' +
            '</div>' + github + credential + timing + progressBar + progressInfo +
            (job.error ? '<div class="meta">' + escapeHtml(job.error) + '</div>' : '') +
            output + cancel + '</section>';
        }).join('');
      }

      async function callTool(name, args) {
        await ready;
        return request('tools/call', { name, arguments:args });
      }

      async function refresh() {
        if (refreshing) return;
        if (!focusedJobId) {
          connectionEl.textContent = 'Waiting for current task';
          return;
        }
        refreshing = true;
        const requestedJobId = focusedJobId;
        try {
          const response = await callTool('job_snapshot', { jobId:requestedJobId, tailLines:6 });
          const data = structured(response);
          if (focusedJobId === requestedJobId && data?.job?.id === requestedJobId) {
            render([data.job]);
          }
          connectionEl.textContent = 'Live | no model polling';
        } catch (error) {
          connectionEl.textContent = 'Waiting for MCP connection';
        } finally {
          refreshing = false;
        }
      }

      function refreshDelay() {
        if (document.hidden) return 15000;
        return latestJobs.some((job) => !isTerminal(job.state)) ? 1500 : 5000;
      }

      function scheduleRefresh(delay = refreshDelay()) {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(async () => {
          await refresh();
          scheduleRefresh();
        }, delay);
      }

      jobsEl.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-cancel]');
        if (!button) return;
        button.disabled = true;
        try { await callTool('job_cancel', { jobId:button.dataset.cancel }); }
        finally { await refresh(); scheduleRefresh(); }
      });

      launchButtonEl.addEventListener('click', async () => {
        const command = launchCommandEl.value;
        const progressPattern = launchProgressEl.value.trim();
        if (!command.trim()) {
          launchStatusEl.textContent = 'Enter a remote command first.';
          return;
        }
        if (!launcherAttempt || launcherAttempt.command !== command) {
          launcherAttempt = {
            command,
            requestTraceId:requestId(),
            requestReceivedAt:new Date().toISOString(),
          };
        }
        launchButtonEl.disabled = true;
        launchStatusEl.textContent = 'Starting through the default SSH profile...';
        try {
          const response = await callTool('job_start', {
            command,
            useDefaultCredential:true,
            requestTraceId:launcherAttempt.requestTraceId,
            requestReceivedAt:launcherAttempt.requestReceivedAt,
            ...(progressPattern ? { progressPattern } : {}),
          });
          const data = structured(response);
          if (!data?.job) throw new Error('RunBeacon returned no job');
          launcherAttempt = undefined;
          focusedJobId = data.job.id;
          launchStatusEl.textContent = 'Started job ' + data.job.id.slice(0,8) + '. Live updates use no model polling.';
          render([data.job]);
          scheduleRefresh(0);
        } catch (error) {
          launchStatusEl.textContent = 'Start failed. Retry keeps the same request trace and cannot duplicate the job.';
        } finally {
          launchButtonEl.disabled = false;
        }
      });

      ready = request('ui/initialize', {
        appInfo:{ name:'runbeacon-dashboard', version:'${RUNBEACON_VERSION}' },
        appCapabilities:{},
        protocolVersion:'2026-01-26'
      }).then(() => notify('ui/notifications/initialized', {}));
      ready.then(() => scheduleRefresh(0)).catch(() => { connectionEl.textContent = 'MCP Apps bridge unavailable'; });
      document.addEventListener('visibilitychange', () => {
        scheduleRefresh(document.hidden ? 15000 : 0);
      }, { passive:true });
    })();
  </script>
</body>
</html>`;
}
