# RunBeacon 3 Architecture

RunBeacon is a single-job lifecycle layer for AI agents. It is not a terminal multiplexer, a general SSH administration service, or a DAG scheduler.

## Process model

```text
Codex / CLI
    | MCP or daemon protocol v5
    v
Local coordinator
    | fixed-host-key SSH, command on stdin
    v
runbeacon-runner rpc
    | 0600 Unix socket, Runner protocol v1
    v
user service -> independent supervisor -> process group
```

The coordinator runs on Node.js 22 or 24 on Windows, Linux, and macOS. The single-file Go Runner is delivered for Linux and macOS x64/arm64 and opens no network port.

Linux installs the Runner as a user systemd service. macOS installs it locally, from an active Aqua session, as a LaunchAgent. SSH can submit work to that service but cannot install it remotely or unlock the login Keychain.

## Submission boundary

The coordinator creates the global job ID, idempotency key, and SHA-256 command digest. The command and environment are sent in an SSH stdin request; they never appear in an argv, service definition, coordinator snapshot, credential profile, or audit record.

The Runner persists the idempotency key and digest before launching an independent supervisor. Concurrent supervisors contend for an exclusive claim file, so a response-loss retry can start the command at most once. The same idempotency key plus another digest returns `IDEMPOTENCY_CONFLICT`.

`executionMode=auto` may use direct SSH only when the Runner probe fails before submission and durability is not required. Any ambiguous submit is retried with the same identifiers and never falls back to direct SSH.

## Recovery

Runner jobs persist a safe credential-profile reference, fixed host fingerprint and algorithm, remote job ID, and last consumed event sequence. After daemon restart, the coordinator resolves the OS-backed profile, calls Runner `get`, then resumes `watch(afterSequence)`. It never calls `submit` during recovery.

One-time inline passwords and direct SSH commands are intentionally not resumable. If their coordinator disappears, they become `lost`. A Runner supervisor that disappears before a terminal record also becomes `lost`; commands are never replayed automatically.

Runner state transitions are:

```text
queued | running | succeeded | failed | cancelled | timed_out | lost
```

Coordinator phases add `awaiting_approval`, credential resolution, connection, submission, execution, reconnection, cancellation, and finalization detail.

## Storage

Coordinator store v2 combines:

- owner-only atomic snapshots;
- a checked, sequence-contiguous append journal;
- a one-time owner-only v1 backup;
- redacted output and metadata only when explicitly enabled.

The Runner stores each job in a `0700` directory with `0600` records. Commands and environments are passed to supervisors over an inherited pipe and are not persisted. Output modes are `tail`, `full`, and `none`; the default cap is 64 MiB per job with seven-day retention and a 10 GiB global retention ceiling. Automatic pruning removes terminal jobs only.

## Waiting and dashboard

The model starts a job and calls `job_wait` once. The daemon owns wait timers, SSH reconnection, Runner event continuation, GitHub Actions discovery, and terminal notification.

The MCP App is bound to one job. It calls `job_watch(jobId, afterVersion)`, a bounded long poll, and stops while the page is hidden. It does not poll `job_snapshot` or load job history. Clients without MCP Apps can start an on-demand loopback dashboard with the interactive CLI; RunBeacon never opens an external browser automatically.

## Policy and audit

The default policy requires a five-minute approval grant for privileged, private-key/signing, release, and destructive commands. The approval is bound to the job, command digest, target, and risk class. Approval RPC is private to the dashboard and CLI and is absent from the MCP tool catalog.

The audit JSONL is owner-only and hash chained. It records decisions, approvals, Runner management, cancellation, event delivery, and publication outcomes without command bodies or credentials. A broken hash or sequence fails closed.

Persistent terminal subscriptions support Codex waiters, desktop integration, and HTTPS webhooks. Webhook URLs and HMAC secrets are both obtained from environment-variable references, so neither value is saved in subscription configuration. Version 1 webhook records that persisted a URL are ignored and must be saved again with `urlEnvVar`.

## Adapters

- `generic` accepts bounded RE2 progress and `RUNBEACON_EVENT <JSON>`.
- `training` accepts explicit epoch, step, loss, ETA, checkpoint, GPU, and percentage fields. GPU percentages cannot overwrite overall progress.
- `slurm` requires the Runner, captures `sbatch --parsable`, resumes via the Runner, and verifies `scancel` through process-group termination.
- `apple-signing` requires the Aqua LaunchAgent Runner and checks the Developer ID identity, untimestamped and timestamped signatures, and a Keychain Notary profile without reading a Keychain password.

## Configuration migration

Use `RUNBEACON_*` environment variables. The 3.x coordinator accepts matching `RJM_*` aliases with a variable-name-only warning; 4.0 removes them. The default data directory atomically migrates from `~/.remote-job-monitor` to `~/.runbeacon` when possible.

See [MIGRATION_3.0.md](MIGRATION_3.0.md) for package, state, host-key algorithm, Runner, and rollback details.
