'use strict';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 1024 * 1024) process.exit(0);
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input || '{}');
    if (event.tool_name !== 'Bash') return;
    const command = String(event.tool_input?.command || '');
    const launchesSsh =
      /(?:^|[;&|]\s*|\bsudo\s+)(?:ssh|scp|sftp|plink)(?:\.exe)?\b/i.test(command);
    if (!launchesSsh) return;

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'Raw SSH execution is not lifecycle-tracked. Use the RunBeacon job_start MCP tool with target.kind="ssh", then call job_wait once. Disable this plugin hook only when an explicitly untracked interactive SSH session is required.',
        },
      })
    );
  } catch {
    // A malformed hook payload must not block unrelated commands.
  }
});
