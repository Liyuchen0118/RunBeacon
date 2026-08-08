import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const promptHook = join(process.cwd(), 'hooks', 'route-remote-prompt.cjs');
const toolHook = join(process.cwd(), 'hooks', 'inject-job-trace.cjs');

function runHook(
  hook: string,
  event: Record<string, unknown>,
  pluginData: string
): string {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_DATA: pluginData },
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout;
}

function runHookAsync(
  hook: string,
  event: Record<string, unknown>,
  pluginData: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], {
      env: { ...process.env, PLUGIN_DATA: pluginData },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 && !stderr) resolve();
      else reject(new Error(`hook exited ${code}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(event));
  });
}

function remotePrompt(sessionId: string, turnId: string, prompt: string) {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: sessionId,
    turn_id: turnId,
    prompt,
  };
}

function jobStart(
  sessionId: string,
  turnId: string,
  command = 'echo ok'
): Record<string, any> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    turn_id: turnId,
    tool_name: 'mcp__remote-job-monitor__job_start',
    tool_input: {
      command,
      useDefaultCredential: true,
      metadata: { safe: 'visible' },
    },
  };
}

describe('RunBeacon prompt trace hooks', () => {
  let pluginData: string;

  beforeEach(() => {
    pluginData = mkdtempSync(join(tmpdir(), 'runbeacon-hooks-'));
  });

  afterEach(() => {
    rmSync(pluginData, { recursive: true, force: true });
  });

  test('injects one trace without storing prompt, command, or credentials', () => {
    const sessionId = 'session-canary-secret';
    const turnId = 'turn-one';
    const promptSecret = 'PROMPT_SECRET_7642';
    const commandSecret = 'COMMAND_PASSWORD_8871';
    runHook(
      promptHook,
      remotePrompt(
        sessionId,
        turnId,
        `在默认 SSH 服务器运行训练 ${promptSecret}`
      ),
      pluginData
    );

    const stateDirectory = join(pluginData, 'hook-state', 'pending-traces');
    const state = readdirSync(stateDirectory)
      .map((name) => readFileSync(join(stateDirectory, name), 'utf8'))
      .join('\n');
    expect(state).not.toContain(sessionId);
    expect(state).not.toContain(promptSecret);
    expect(state).not.toContain(commandSecret);

    const output = runHook(
      toolHook,
      jobStart(sessionId, turnId, `train --password ${commandSecret}`),
      pluginData
    );
    const decision = JSON.parse(output).hookSpecificOutput;
    expect(decision.permissionDecision).toBe('allow');
    expect(decision.updatedInput).toMatchObject({
      command: `train --password ${commandSecret}`,
      useDefaultCredential: true,
      metadata: { safe: 'visible' },
    });
    expect(decision.updatedInput.requestTraceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Date.parse(decision.updatedInput.requestReceivedAt)).not.toBeNaN();
  });

  test('isolates sessions and reuses a trace for same-turn tool retries', () => {
    runHook(
      promptHook,
      remotePrompt('session-a', 'turn-shared', '默认 SSH 服务器运行训练'),
      pluginData
    );
    expect(
      runHook(toolHook, jobStart('session-b', 'turn-shared'), pluginData)
    ).toBe('');

    runHook(
      promptHook,
      remotePrompt('session-b', 'turn-shared', '默认 SSH 服务器运行训练'),
      pluginData
    );
    const first = JSON.parse(
      runHook(toolHook, jobStart('session-a', 'turn-shared'), pluginData)
    ).hookSpecificOutput.updatedInput;
    const retry = JSON.parse(
      runHook(toolHook, jobStart('session-a', 'turn-shared'), pluginData)
    ).hookSpecificOutput.updatedInput;
    const other = JSON.parse(
      runHook(toolHook, jobStart('session-b', 'turn-shared'), pluginData)
    ).hookSpecificOutput.updatedInput;
    expect(retry.requestTraceId).toBe(first.requestTraceId);
    expect(retry.requestReceivedAt).toBe(first.requestReceivedAt);
    expect(other.requestTraceId).not.toBe(first.requestTraceId);
  });

  test('clears an older session trace when a non-remote turn arrives', () => {
    runHook(
      promptHook,
      remotePrompt('session-a', 'turn-one', '默认 SSH 服务器运行训练'),
      pluginData
    );
    runHook(
      promptHook,
      remotePrompt('session-a', 'turn-two', '请解释 TypeScript 类型系统'),
      pluginData
    );
    expect(
      runHook(toolHook, jobStart('session-a', 'turn-one'), pluginData)
    ).toBe('');
  });

  test('rejects expired traces and preserves explicit caller trace fields', () => {
    runHook(
      promptHook,
      remotePrompt('session-a', 'turn-one', '默认 SSH 服务器运行训练'),
      pluginData
    );
    const stateDirectory = join(pluginData, 'hook-state', 'pending-traces');
    const statePath = join(stateDirectory, readdirSync(stateDirectory)[0]);
    const expired = JSON.parse(readFileSync(statePath, 'utf8'));
    expired.createdAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    writeFileSync(statePath, JSON.stringify(expired));
    expect(
      runHook(toolHook, jobStart('session-a', 'turn-one'), pluginData)
    ).toBe('');

    runHook(
      promptHook,
      remotePrompt('session-a', 'turn-two', '默认 SSH 服务器运行训练'),
      pluginData
    );
    const explicit = jobStart('session-a', 'turn-two');
    explicit.tool_input = {
      ...explicit.tool_input,
      requestTraceId: 'd16ee49e-39a8-4d43-93bf-3f519f715d69',
      requestReceivedAt: '2026-08-06T00:00:00.000Z',
    };
    expect(runHook(toolHook, explicit, pluginData)).toBe('');
  });

  test('keeps concurrent same-turn writes atomic', async () => {
    const event = remotePrompt(
      'session-concurrent',
      'turn-concurrent',
      '默认 SSH 服务器运行训练'
    );
    await Promise.all(
      Array.from({ length: 8 }, () =>
        runHookAsync(promptHook, event, pluginData)
      )
    );
    const stateDirectory = join(pluginData, 'hook-state', 'pending-traces');
    expect(
      readdirSync(stateDirectory).filter((name) => name.endsWith('.tmp'))
    ).toHaveLength(0);
    expect(
      JSON.parse(
        runHook(
          toolHook,
          jobStart('session-concurrent', 'turn-concurrent'),
          pluginData
        )
      ).hookSpecificOutput.updatedInput.requestTraceId
    ).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test('keeps remote routing active when trace storage is unavailable', () => {
    const blockedRoot = join(pluginData, 'not-a-directory');
    writeFileSync(blockedRoot, 'blocked');
    const output = runHook(
      promptHook,
      remotePrompt('session-a', 'turn-one', '默认 SSH 服务器运行训练'),
      blockedRoot
    );
    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toMatch(
      /make job_start the first task action/
    );
  });
});
