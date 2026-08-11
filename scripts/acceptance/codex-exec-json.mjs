import assert from 'node:assert/strict';

export function parseCodexExecEvents(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `codex exec emitted invalid JSON on line ${index + 1}: ${error.message}`
        );
      }
    });
}

export function completedMcpCalls(events) {
  const calls = new Map();
  events.forEach((event, eventIndex) => {
    if (event?.type !== 'item.completed') return;
    const item = event.item;
    if (!item || !/^(?:mcp_)?tool_call$/.test(String(item.type ?? ''))) {
      return;
    }
    const rawName = item.tool ?? item.name ?? item.tool_name ?? item.toolName;
    if (typeof rawName !== 'string' || !rawName) return;
    const key = String(item.id ?? `${eventIndex}:${rawName}`);
    calls.set(key, { eventIndex, name: rawName, item });
  });
  return [...calls.values()].sort((left, right) => left.eventIndex - right.eventIndex);
}

export function assertRunBeaconCodexAcceptance(stdout) {
  const events = parseCodexExecEvents(stdout);
  const calls = completedMcpCalls(events);
  const matching = (name) =>
    calls.filter((call) =>
      new RegExp(`(?:^|[/:.])${name}$`, 'i').test(call.name)
    );
  const starts = matching('job_start');
  const waits = matching('job_wait');
  assert.equal(starts.length, 1, 'fresh Codex task must call job_start once');
  assert.equal(waits.length, 1, 'fresh Codex task must call job_wait once');
  assert.ok(
    starts[0].eventIndex < waits[0].eventIndex,
    'job_wait must follow job_start'
  );
  for (const forbidden of ['job_snapshot', 'job_list']) {
    assert.equal(
      matching(forbidden).length,
      0,
      `fresh Codex task called forbidden tool ${forbidden}`
    );
  }
  const waitResult = JSON.stringify(waits[0].item);
  assert.match(waitResult, /RUNBEACON_CODEX_ACCEPTANCE/);
  assert.match(waitResult, /succeeded/i);
  return { events, calls };
}
