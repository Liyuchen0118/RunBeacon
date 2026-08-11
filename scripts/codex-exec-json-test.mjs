import assert from 'node:assert/strict';
import { assertRunBeaconCodexAcceptance } from './acceptance/codex-exec-json.mjs';

const events = [
  {
    type: 'item.completed',
    item: {
      id: 'prompt',
      type: 'user_message',
      text: 'Call job_start and job_wait, but not job_snapshot or job_list.',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'start',
      type: 'mcp_tool_call',
      tool: 'remote-job-monitor/job_start',
      arguments: { command: 'echo RUNBEACON_CODEX_ACCEPTANCE' },
      result: { job: { id: 'fixture', state: 'queued' } },
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'wait',
      type: 'mcp_tool_call',
      tool: 'remote-job-monitor/job_wait',
      arguments: { jobId: 'fixture' },
      result: {
        job: {
          id: 'fixture',
          state: 'succeeded',
          tail: [{ data: 'RUNBEACON_CODEX_ACCEPTANCE' }],
        },
      },
    },
  },
];

const parsed = assertRunBeaconCodexAcceptance(
  events.map((event) => JSON.stringify(event)).join('\n')
);
assert.equal(parsed.calls.length, 2);
process.stdout.write('Codex exec JSON acceptance parser passed\n');
