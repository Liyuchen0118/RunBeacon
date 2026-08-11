---
name: monitor-remote-jobs
description: Default workflow for durable local, SSH, Slurm, Apple-signing, or GitHub publishing work through RunBeacon. Use whenever Codex needs to call a remote host, securely save or select SSH/GitHub credentials, run or recover a long task, monitor training, publish commits, wait without model polling, cancel a remote process group, manage a Runner, inspect audit events, or show the single-task dashboard. Prefer this skill automatically for non-interactive remote execution and credential requests.
---

# Monitor Remote Jobs with RunBeacon

Use RunBeacon as the default route for non-interactive work on a remote machine, even when the user only says to run, deploy, inspect, or monitor something "on the server." Route any command whose completion matters through the plugin's tracked job tools. The plugin can only observe processes and SSH channels that it launches.

## Availability contract

RunBeacon is available only when its MCP tools are registered in the current Codex task. If `job_start` is not exposed, fail fast and tell the user to start a new task after reinstalling the plugin. Do not launch `lifecycle-server.js` through a shell or bypass MCP with raw SSH. The MCP App is the primary dashboard; the interactive `runbeacon dashboard` CLI may create an on-demand loopback page when the host has no Apps capability, but the model must not start that fallback automatically.

## Run and continue

For a request that already contains a complete command and explicitly selects the default SSH server, take the zero-exploration fast path: after reading this skill, make `job_start` the first task action with the command copied verbatim and `useDefaultCredential: true`. Do not inspect the current directory, README, tests, plugin source, tool registry, or credential profiles, and do not reconstruct or escape the command in JavaScript.

1. Call `job_start` with the complete command, `executionMode: "auto"`, and optional label, timeout, adapter, output policy, RE2 progress regex, and subscriptions. Set `requireDurable: true` for training that must survive SSH loss, Slurm, Apple signing, or any workflow that cannot tolerate direct SSH. The Hook attaches the current prompt trace; do not synthesize or replace it. `job_start` mounts the single-task MCP App immediately. Progress patterns are limited to 256 characters, put the finite percentage in capture group 1, and cannot use backreferences or lookaround. Reusable operations should also provide a stable `idempotencyKey`.
2. Record the returned `jobId`.
3. As the very next tool call, immediately call `job_wait` once with that `jobId`. Do not insert commentary, documentation reads, credential listing, status inspection, or additional planning between `job_start` and `job_wait`. Do not build a sleep/status loop and do not repeatedly call `job_snapshot`.
4. After `job_wait` returns a terminal state, inspect its bounded output tail and continue the user's requested next step.
5. If the server-side wait itself times out while the job is still running, tell the user and call `job_wait` at most once more when continued waiting is intended.

Never issue a second `job_start` to repair quoting, progress parsing, or unexpected output. A Runner acknowledgement can be lost after acceptance; RunBeacon retries the same job ID, idempotency key, and digest and must never fall back to direct SSH after that point. Report `lost` or `REMOTE_STATE_LOST` instead of replaying an uncertain command. `${name}`, `$name`, `$()` and shell quoting must reach the remote shell exactly as supplied by the user.

Use `job_snapshot` only when the user explicitly asks for current status. Do not call `job_watch`; it is the dashboard's version-change long poll. Do not call `job_dashboard` after a normal start because `job_start` already mounts it. Use `job_dashboard` only to reopen a known task. Every dashboard is bound to one job and pauses its watch while hidden.

Some clients expose the same RunBeacon job as an experimental MCP Task. Treat its task ID as the job ID; task get/result/cancel must not create another job. Continue to prefer the explicit `job_start` followed immediately by one `job_wait` flow unless the client itself requests Tasks mode.

If a direct SSH cancellation returns `cancellationVerified: false`, report that the remote process may still exist. A durable Runner reports `cancelled` as verified only after the entire process group exits. Slurm additionally requires queue disappearance and a cancelled/preempted accounting state after `scancel`; an unverified cancellation must never be described as successful.

## Durable Runner and approvals

`auto` probes the Runner first and may use direct SSH only before submission when `requireDurable` is false. `runner` or `requireDurable` fails with `RUNNER_UNAVAILABLE` instead of degrading. Runner jobs expose `durable`, `resumable`, connection state, event sequence, reconnect count, and Runner version in their snapshot.

Use `runner_manage` only to probe from a model task or to migrate a saved profile's missing host-key algorithm after an explicit pinned-fingerprint check. Migration requires a named profile plus `confirm: true`; never use it to replace a mismatching fingerprint. Installation, upgrade, and uninstall require the interactive signed-asset CLI. macOS installation must run locally in an active Aqua session; never try to unlock Keychain over SSH. The Runner installs as a Linux user systemd service or macOS LaunchAgent and exposes no network port.

Privileged, private-key, release, and destructive commands may remain in `awaiting_approval`. Do not retry or alter the command. Tell the user to approve or reject in the dashboard or with `runbeacon approve|reject <jobId>`. The App receives its one-use capability only through private tool-result metadata; never request, echo, or reconstruct it. The MCP tool catalog intentionally has no approval operation. Policy changes do not approve pending work.

Use adapters deliberately:

- `generic`: RE2 progress or bounded `RUNBEACON_EVENT <JSON>`.
- `training`: structured epoch, step, loss, ETA, checkpoint, and GPU fields only.
- `slurm`: the command must return `sbatch --parsable`; requires the Runner and verifies `scancel`.
- `apple-signing`: requires the macOS Aqua LaunchAgent and environment references for signing identity and Notary profile; no Keychain password is read or transmitted.

Direct SSH retries a failed handshake up to five times only before SSH reaches `ready`. Runner mode reconnects its blocking event channel from the last sequence while the independent supervisor continues. Neither mode blindly replays an accepted command.

## GitHub publishing

Use `github_publish_start` when the user wants a commit, push, or GitHub Actions run shown in the RunBeacon dashboard. Pass the repository `cwd`, optional remote and branch, and a stable `idempotencyKey`. Publishing is a release-risk action and may require user approval.

The tool never stages files. If a new commit is requested, ensure the intended files have already been staged through a separately authorized Git action, then pass `commitMessage`. Omit `commitMessage` to push the existing `HEAD`. Never force-push through RunBeacon.

Leave `watchActions` enabled for GitHub remotes. Public repositories need no API credential. Prefer a saved GitHub profile for private repositories. Use the one-job `githubToken` override only when the user explicitly requests temporary use; never echo it or place it in a command, label, metadata, or status message.

By default, a confirmed push remains successful when Actions monitoring is temporarily unavailable (`monitoring-degraded`) or no workflow can run for that branch/PR (`no-workflows`). Actual workflow failures still fail the job. Pass `requireActions: true` for release or security gates where unavailable or missing Actions monitoring must also fail. The runner parses workflow triggers, checks open PRs, reuses configured HTTP/Git proxies, and performs bounded retries internally; do not repair a monitoring error with another publish call.

The tool result opens the same live dashboard automatically. Call `job_wait` once when Codex should continue after the push and Actions reach a terminal outcome. The runner performs all Actions discovery and status polling in the background, so do not call `job_snapshot` repeatedly. If an MCP response is lost, reuse the same `idempotencyKey`; never create a second commit/push job merely to recover the dashboard or monitoring result.

## SSH routing

Choose `job_start` before raw shell `ssh` for remote execution. Do not ask the user to choose between them unless the request genuinely requires an interactive terminal that RunBeacon cannot represent.

Prefer passwordless credential profiles. When the user explicitly requests the default or common SSH server, do not call `credential_profile_list`: call `job_start` directly with `useDefaultCredential: true`. Call `credential_profile_list` only when the user asks to inspect profiles, names a saved server that still needs resolution, or supplies an ambiguous non-default target. Pass `credentialProfile` to `job_start`; a unique saved profile also matches automatically from `target.host` and `target.username`. Create or update an agent/private-key reference with `credential_profile_save` only when the user asks to remember it. When the user asks to persist an IP/host, username, and SSH password, use `ssh_password_save` instead.

Use `credential_profile_set_default` when the user identifies a common profile. SSH and GitHub defaults are independent. For an explicitly remote request with no named server or credential, call `job_start` with `useDefaultCredential: true`; never set that flag for a local command. Preserve an explicitly named profile or host instead of silently replacing it with the default. Use `credential_profile_clear_default` without deleting the underlying profile when the user only wants to stop automatic selection.

SSH profiles may reference `agent: "auto"`, an explicit agent socket/pipe, `privateKeyPath`, or an OS-managed password credential, plus host/user/port and host-key verification. Profile JSON must never contain a password, passphrase, token, or private-key contents. Load encrypted keys into `ssh-agent` so later jobs run without a passphrase.

Use `ssh_password_save` when the user explicitly asks to remember an SSH password. Prefer `passwordEnvVar`; accept the `password` field only when the user deliberately supplied it in the conversation. Set `makeDefault: true` only when requested. The tool sends the password to the configured OS-backed Git credential helper over stdin and saves only `credentialKind: "password"` plus the safe connection fields. If it reports a plaintext `credential-store`, stop and have the user configure Git Credential Manager or another OS-backed helper. Never send the password in a shell command, environment metadata, label, log, or dashboard field.

Use `ssh_password_delete` only when the user asks to remove both the OS-managed password and its RunBeacon profile. `credential_profile_delete` removes only the reference and intentionally leaves OS credentials untouched.

Set `target.kind` to `ssh` and provide `host`, `username`, and one authentication method. Prefer an SSH agent or `privateKeyPath`. Pin `hostKeySha256`; use `allowUnverifiedHostKey: true` only when the user explicitly accepts the host-verification risk.

If the user explicitly supplies a password or key passphrase for one-time use, pass it only in the `job_start` target. Never echo it, add it to a command, write it to a file, or include it in a status response. The plugin keeps these values in memory and excludes them from persistent job metadata.

Do not launch tracked SSH work with raw Bash `ssh`, `scp`, `sftp`, or `plink`. The plugin Hook blocks those paths because a process launched outside `job_start` cannot be attached reliably after launch.

## GitHub credentials

Prefer a saved `kind: "github"` profile and the configured Git credential helper over a `githubToken` argument. Git push uses the helper automatically. The Actions watcher obtains the selected credential through `git credential fill` with terminal interaction disabled and never prints or persists the result.

When `github_publish_start` has neither `credentialProfile` nor `githubToken`, let RunBeacon select the default GitHub profile automatically. An explicitly supplied profile or memory-only token always wins.

Use `github_token_save` when the user asks to remember a PAT. Prefer `tokenEnvVar`; accept the `token` field only when the user deliberately provides a PAT in the conversation. Never ask the user to paste a token when an environment variable or the helper's own login flow is available. The tool passes the PAT to `git credential approve` over stdin, verifies it with `git credential fill`, and saves only host, username, and `credentialKind: "pat"` in the RunBeacon profile.

Set `makeDefault: true` during `credential_profile_save`, `ssh_password_save`, or `github_token_save` only when the user asks to make the new profile the default.

If PAT saving reports a plaintext `credential-store`, stop and have the user configure Git Credential Manager or another OS-backed helper. Do not override this protection.

Use `github_token_delete` only when the user explicitly asks to remove both a RunBeacon PAT profile and its OS-managed credential. Use `credential_profile_delete` when the user wants to remove only the RunBeacon reference. Never send a PAT to a shell command, output, label, metadata, or dashboard field.

## Output and safety

Keep output reads bounded. Prefer the tail already returned by `job_wait`; call `job_snapshot` with a larger `tailLines` only when diagnosis requires it.

Arbitrary `metadata` and output-derived progress messages remain in memory by default and are excluded from persistent state. Never place credentials in labels or metadata even when persistence is disabled.

Treat `job_start` and `job_cancel` as state-changing operations. Preserve the user's normal approval and safety requirements for the underlying command. The tracking layer does not make a destructive command safer.
