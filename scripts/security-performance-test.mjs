import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RE2JS } from 're2js';
import { LifecycleManager } from '../dist/lifecycle/LifecycleManager.js';

const pattern = RE2JS.compile('(a+)+$');
const hostileLine = `${'a'.repeat(1024)}!`;
const regexStartedAt = performance.now();
for (let index = 0; index < 1000; index += 1) {
  assert.equal(pattern.test(hostileLine), false);
}
const regexDurationMs = performance.now() - regexStartedAt;
assert.ok(
  regexDurationMs < 1000,
  `1000 hostile RE2 matches took ${regexDurationMs.toFixed(1)}ms`
);

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runbeacon-security-'));
const warnings = [];
const warningListener = (warning) => warnings.push(warning);
process.on('warning', warningListener);

try {
  const manager = new LifecycleManager({
    statePath: path.join(testRoot, 'jobs.json'),
  });
  const started = manager.start({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    shell: false,
  });
  await manager.waitForTerminal(started.id, 5000, 0);

  global.gc?.();
  const stableHeap = process.memoryUsage().heapUsed;
  const results = await Promise.all(
    Array.from({ length: 1000 }, () =>
      manager.waitForTerminal(started.id, 5000, 0)
    )
  );
  global.gc?.();
  const heapGrowth = process.memoryUsage().heapUsed - stableHeap;

  assert.equal(results.every((result) => !result.timedOut), true);
  assert.ok(
    heapGrowth < 10 * 1024 * 1024,
    `1000 terminal waits grew the heap by ${heapGrowth} bytes`
  );
  assert.deepEqual(manager.waitCoordinatorStatus(), {
    waiters: 0,
    jobs: 0,
    timers: 0,
  });
  assert.equal(manager.listenerCount('jobChanged'), 0);
  assert.equal(
    warnings.some((warning) => warning.name === 'MaxListenersExceededWarning'),
    false
  );
  manager.dispose();

  process.stdout.write(
    `${JSON.stringify({
      hostileMatches: 1000,
      regexDurationMs: Math.round(regexDurationMs),
      terminalWaits: results.length,
      heapGrowthBytes: heapGrowth,
    })}\n`
  );
} finally {
  process.off('warning', warningListener);
  fs.rmSync(testRoot, { recursive: true, force: true });
}
