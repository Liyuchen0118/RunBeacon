'use strict';

const { readPendingTrace } = require('./pending-trace.cjs');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 1024 * 1024) process.exit(0);
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input || '{}');
    if (
      !/^mcp__(?:runbeacon|remote[-_]job[-_]monitor)__job_start$/.test(
        event.tool_name
      ) ||
      !event.tool_input ||
      typeof event.tool_input !== 'object' ||
      Array.isArray(event.tool_input)
    ) {
      return;
    }
    if (
      Object.hasOwn(event.tool_input, 'requestTraceId') ||
      Object.hasOwn(event.tool_input, 'requestReceivedAt')
    ) {
      return;
    }
    const trace = readPendingTrace(event);
    if (!trace) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...event.tool_input, ...trace },
        },
      })
    );
  } catch {
    // Missing trace state must not block a tool call.
  }
});
