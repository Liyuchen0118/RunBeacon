---
name: monitor-remote-jobs
description: Default workflow for executing and monitoring local, SSH, or GitHub publishing work through RunBeacon. Use whenever Codex needs to call a remote server or host, use SSH/SCP/SFTP credentials, securely save an IP/host plus username and SSH password, configure or select default credentials, configure a GitHub personal access token, run a command or deployment on another machine, publish Git commits, monitor GitHub Actions, wait for completion, inspect progress, cancel work, or show a live dashboard without model polling. Prefer this skill automatically for non-interactive remote execution and credential requests.
---

# Monitor Remote Jobs with RunBeacon

Use RunBeacon as the default route for non-interactive work on a remote machine, even when the user only says to run, deploy, inspect, or monitor something "on the server." Route any command whose completion matters through the plugin's tracked job tools. The plugin can only observe processes and SSH channels that it launches.

## Availability contract

RunBeacon is available only when its MCP tools are registered in the current Codex task. If `job_start` and the related tools are not exposed, fail fast: tell the user that the updated plugin must be picked up in a new task or after restarting Codex. Do not launch `lifecycle-server.js` through a shell, bypass MCP with raw SSH, or create a temporary localhost dashboard (including port 8765). Those fallbacks cannot mount the MCP App reliably and may create slow model-driven polling.

## Run and continue

For a request that already contains a complete command and explicitly selects the default SSH server, take the zero-exploration fast path: after reading this skill, make `job_start` the first task action with the command copied verbatim and `useDefaultCredential: true`. Do not inspect the current directory, README, tests, plugin source, tool registry, or credential profiles, and do not reconstruct or escape the command in JavaScript.

1. Call `job_start` with the complete command and an optional label, timeout, RE2-compatible progress regex, and target. When the prompt hook supplies `requestTraceId` and `requestReceivedAt`, pass both unchanged. Reuse the same trace on every retry; the server binds one trace to one job. `job_start` is linked to the RunBeacon MCP App, so its queued result mounts the live dashboard immediately and the UI can observe the job from its first lifecycle state. Progress patterns are limited to 256 characters, must put the finite percentage in capture group 1, and cannot use backreferences or lookaround. For deployments or other operations that might be retried across separate user requests, also provide a stable `idempotencyKey`.
2. Record the returned `jobId`.
3. As the very next tool call, immediately call `job_wait` once with that `jobId`. Do not insert commentary, documentation reads, credential listing, status inspection, or additional planning between `job_start` and `job_wait`. Do not build a sleep/status loop and do not repeatedly call `job_snapshot`.
4. After `job_wait` returns a terminal state, inspect its bounded output tail and continue the user's requested next step.
5. If the server-side wait itself times out while the job is still running, tell the user and call `job_wait` at most once more when continued waiting is intended.

Never issue a second `job_start` to repair quoting, progress parsing, or unexpected output. Report the first job result and ask for a new user request when a changed command must run. `${name}`, `$name`, `$()` and shell quoting must reach the remote shell exactly as supplied by the user.

Use `job_snapshot` only when the user explicitly asks for current status. Do not call `job_dashboard` after a normal `job_start` merely to show the same UI because the start tool already mounts it. Use `job_dashboard` with the known `jobId` to reopen that task when the user explicitly asks; without a `jobId`, it only selects the newest non-terminal task. Every dashboard instance is bound to one job and never displays job history. The dashboard calls MCP directly and does not create model turns.

If an SSH cancellation returns `cancellationVerified: false`, report that the channel was closed but the remote process may still exist. Do not claim that the remote process was killed; durable scheduler adapters are required for verified remote cancellation.

RunBeacon retries a failed SSH handshake up to five times with bounded exponential backoff. It stops retrying as soon as SSH reaches `ready`; an exec request or an in-progress remote command is never replayed automatically. A disconnect after command start must be reported as failed/indeterminate rather than silently starting a second training or deployment.

## GitHub publishing

Use `github_publish_start` when the user wants a commit, push, or GitHub Actions run shown in the RunBeacon dashboard. Pass the repository `cwd`, optional remote and branch, and a stable `idempotencyKey` when a retry must not create another commit or push job.

The tool never stages files. If a new commit is requested, ensure the intended files have already been staged through a separately authorized Git action, then pass `commitMessage`. Omit `commitMessage` to push the existing `HEAD`. Never force-push through RunBeacon.

Leave `watchActions` enabled for GitHub remotes. Public repositories need no API credential. Prefer a saved GitHub profile for private repositories. Use the one-job `githubToken` override only when the user explicitly requests temporary use; never echo it or place it in a command, label, metadata, or status message.

The tool result opens the same live dashboard automatically. Call `job_wait` once when Codex should continue after the push and Actions reach a terminal outcome. The runner performs all Actions discovery and status polling in the background, so do not call `job_snapshot` repeatedly.

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
