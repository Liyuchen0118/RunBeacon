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
    const prompt = String(event.prompt || '').slice(0, 128 * 1024);
    if (!isRemoteExecutionRequest(prompt)) return;

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext:
            'Default remote-execution route: use the RunBeacon job_start MCP tool first for non-interactive work on another machine. Set target.kind="ssh", pass the complete remote command and memory-only authentication fields, then call job_wait exactly once when the workflow must continue after completion. Do not launch raw ssh, scp, sftp, or plink through the shell unless the user explicitly requires an interactive or deliberately untracked session and accepts losing lifecycle monitoring. Preserve normal approval and host-key verification requirements for the underlying action.',
        },
      })
    );
  } catch {
    // A malformed hook payload must not alter the user's prompt.
  }
});

function isRemoteExecutionRequest(prompt) {
  if (!prompt.trim()) return false;
  const remoteTarget =
    /\b(?:ssh|scp|sftp|plink|remote\s+(?:server|host|machine|system)|server|vps|bastion|jump\s+host)\b|远程|服务器|云主机|跳板机/i.test(
      prompt
    );
  const remoteAddress =
    /\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\b|\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(
      prompt
    );
  const operation =
    /\b(?:run|execute|deploy|start|stop|restart|install|build|train|copy|upload|download|connect|login|check|inspect|monitor|tail|invoke)\b|运行|执行|部署|启动|停止|重启|安装|构建|训练|复制|上传|下载|连接|登录|查看|检查|监控|调用/i.test(
      prompt
    );
  const directRemoteTool = /\b(?:ssh|scp|sftp|plink)(?:\.exe)?\b/i.test(prompt);
  const conceptualOnly =
    /\b(?:explain|compare|definition|documentation|docs|concept|overview)\b|解释|原理|什么是|概念|文档|区别|介绍/i.test(
      prompt
    ) && !operation;
  if (conceptualOnly) return false;
  return (remoteTarget || remoteAddress) && (operation || directRemoteTool);
}
