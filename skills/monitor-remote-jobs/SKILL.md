---
name: monitor-remote-jobs
description: Run and monitor long-running local, SSH, or GitHub publishing work through RunBeacon. Use when Codex needs to start a process, deployment, build, training run, data job, server script, remote SSH command, Git commit/push, or GitHub Actions run; wait for it to finish; inspect bounded progress/output; continue with the next step automatically; cancel it; or show a live dashboard without repeated model polling.
---

# Monitor Remote Jobs with RunBeacon

Route any command whose completion matters through the plugin's tracked job tools. The plugin can only observe processes and SSH channels that it launches.

## Run and continue

1. Call `job_start` with the complete command and an optional label, timeout, progress regex, and target. For deployments or other operations that might be retried after a transport failure, provide a stable `idempotencyKey` so a retry returns the original job instead of launching a duplicate.
2. Record the returned `jobId`.
3. Call `job_wait` once with that `jobId`. Do not build a sleep/status loop and do not repeatedly call `job_snapshot`.
4. After `job_wait` returns a terminal state, inspect its bounded output tail and continue the user's requested next step.
5. If the server-side wait itself times out while the job is still running, tell the user and call `job_wait` at most once more when continued waiting is intended.

Use `job_snapshot` only when the user explicitly asks for current status. Use `job_dashboard` when the user wants a live visual view; the dashboard calls MCP directly and does not create model turns.

If an SSH cancellation returns `cancellationVerified: false`, report that the channel was closed but the remote process may still exist. Do not claim that the remote process was killed; durable scheduler adapters are required for verified remote cancellation.

## GitHub publishing

Use `github_publish_start` when the user wants a commit, push, or GitHub Actions run shown in the RunBeacon dashboard. Pass the repository `cwd`, optional remote and branch, and a stable `idempotencyKey` when a retry must not create another commit or push job.

The tool never stages files. If a new commit is requested, ensure the intended files have already been staged through a separately authorized Git action, then pass `commitMessage`. Omit `commitMessage` to push the existing `HEAD`. Never force-push through RunBeacon.

Leave `watchActions` enabled for GitHub remotes. Public repositories need no API credential. When the user explicitly supplies a token for a private repository, pass it only as `githubToken`; never echo it or place it in a command, label, metadata, or status message. The plugin keeps it in memory and gives it to the runner environment only.

The tool result opens the same live dashboard automatically. Call `job_wait` once when Codex should continue after the push and Actions reach a terminal outcome. The runner performs all Actions discovery and status polling in the background, so do not call `job_snapshot` repeatedly.

## SSH routing

Set `target.kind` to `ssh` and provide `host`, `username`, and one authentication method. Prefer an SSH agent or `privateKeyPath`. Pin `hostKeySha256`; use `allowUnverifiedHostKey: true` only when the user explicitly accepts the host-verification risk.

If the user explicitly supplies a password or key passphrase, pass it only in the `job_start` target. Never echo it, add it to a command, write it to a file, or include it in a status response. The plugin keeps these values in memory and excludes them from persistent job metadata.

Do not launch tracked SSH work with raw Bash `ssh`, `scp`, `sftp`, or `plink`. The plugin Hook blocks those paths because a process launched outside `job_start` cannot be attached reliably after launch.

## Output and safety

Keep output reads bounded. Prefer the tail already returned by `job_wait`; call `job_snapshot` with a larger `tailLines` only when diagnosis requires it.

Arbitrary `metadata` and output-derived progress messages remain in memory by default and are excluded from persistent state. Never place credentials in labels or metadata even when persistence is disabled.

Treat `job_start` and `job_cancel` as state-changing operations. Preserve the user's normal approval and safety requirements for the underlying command. The tracking layer does not make a destructive command safer.
