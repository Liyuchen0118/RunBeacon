import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifecycleManager } from '../dist/lifecycle/LifecycleManager.js';

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'runbeacon-stress-')
);
const jobCount = 20;
const manager = new LifecycleManager({
  statePath: path.join(temporaryDirectory, 'jobs.json'),
  maxConcurrentJobs: jobCount,
  persistenceDebounceMs: 25,
});

try {
  const startedAt = performance.now();
  const jobs = Array.from({ length: jobCount }, (_, index) => {
    const marker = `RUNBEACON_STRESS_${index}`;
    const job = manager.start({
      command: process.execPath,
      args: ['-e', `process.stdout.write('${marker}\\n')`],
      shell: false,
      label: marker,
      timeoutMs: 10_000,
    });
    return { id: job.id, marker };
  });

  assert.equal(new Set(jobs.map(({ id }) => id)).size, jobCount);
  const results = await Promise.all(
    jobs.map(({ id }) => manager.waitForTerminal(id, 15_000, 20))
  );

  results.forEach((result, index) => {
    assert.equal(result.timedOut, false);
    assert.equal(result.job.state, 'succeeded');
    assert.match(
      result.job.tail.map((chunk) => chunk.data).join(''),
      new RegExp(jobs[index].marker)
    );
  });
  assert.deepEqual(manager.waitCoordinatorStatus(), {
    waiters: 0,
    jobs: 0,
    timers: 0,
  });
  assert.deepEqual(manager.runtimeStatus(), {
    activeJobs: 0,
    queuedJobs: 0,
  });

  const elapsedMs = Math.round(performance.now() - startedAt);
  assert.ok(elapsedMs < 30_000, `Lifecycle stress took ${elapsedMs}ms`);
  process.stdout.write(
    `${JSON.stringify({ concurrentJobs: jobCount, elapsedMs })}\n`
  );
} finally {
  manager.dispose();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
