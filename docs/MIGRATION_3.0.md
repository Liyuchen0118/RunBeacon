# Migration to RunBeacon 3.0

RunBeacon 3.0 narrows the npm core to persistent job lifecycle work and introduces a durable remote Runner. This is a breaking release.

RunBeacon 3.0 no longer negotiates the deprecated SSH RSA/SHA-1 `ssh-rsa` signature algorithm. RSA host keys remain supported through `rsa-sha2-512` and `rsa-sha2-256`; profiles pinned to `ssh-rsa` must be migrated after verifying the existing SHA-256 host fingerprint.

## Package and entry points

- Upgrade the coordinator to `console-automation-mcp@3`.
- Upgrade the Codex plugin to `remote-job-monitor@2`.
- Install `runbeacon-runner@3` on Linux/macOS hosts that require recovery.
- Replace `mcp-console` with `console-automation-mcp`, `remote-job-monitor`, or `runbeacon`.
- Pin `console-automation-mcp@2` and plugin 1.x to roll back.

The old interactive console tools and protocol integrations are maintained as `console-automation-mcp-legacy@2.0.x` for High/Critical security fixes for six months after the stable 3.0 release.

## Environment variables

Rename `RJM_*` variables to `RUNBEACON_*`. 3.x accepts old names and emits a deprecation warning containing only the variable names. 4.0 removes aliases.

Common mappings:

| Old                           | New                                 |
| ----------------------------- | ----------------------------------- |
| `RJM_STATE_PATH`              | `RUNBEACON_STATE_PATH`              |
| `RJM_MAX_CONCURRENT_JOBS`     | `RUNBEACON_MAX_CONCURRENT_JOBS`     |
| `RJM_MAX_OUTPUT_BYTES`        | `RUNBEACON_MAX_OUTPUT_BYTES`        |
| `RJM_PERSIST_OUTPUT`          | `RUNBEACON_PERSIST_OUTPUT`          |
| `RJM_PERSIST_METADATA`        | `RUNBEACON_PERSIST_METADATA`        |
| `RJM_SSH_HANDSHAKE_ATTEMPTS`  | `RUNBEACON_SSH_HANDSHAKE_ATTEMPTS`  |
| `RJM_SSH_RETRY_BASE_DELAY_MS` | `RUNBEACON_SSH_RETRY_BASE_DELAY_MS` |
| `RJM_SSH_READY_TIMEOUT_MS`    | `RUNBEACON_SSH_READY_TIMEOUT_MS`    |

The default data directory is the stable `~/.runbeacon` path. `PLUGIN_DATA` and `CLAUDE_PLUGIN_DATA` no longer select runtime state, so a plugin cachebuster or reinstall cannot silently switch credential stores. At startup, RunBeacon merges missing safe credential references from those plugin-host paths and `~/.remote-job-monitor`; canonical profiles and per-kind defaults win every conflict. The merge uses an exclusive lock, owner-only backup, atomic canonical write, and a content-hash marker before retiring each source as `credential-profiles.json.migrated-v3.bak`.

Credential files contain references only. Passwords and PATs remain in the OS credential manager, while passphrases and private-key contents are never migrated. Invalid source files remain untouched. Set `RUNBEACON_DATA_DIR` for an intentionally isolated deployment or test; an explicit override disables automatic imports from home and plugin-host directories.

## State migration

The daemon creates an owner-only `jobs.json.v1.backup.json`, then writes state store v2 as checked JSONL events plus atomic snapshots. Legacy `orphaned` states map to `lost`. Existing terminal history and default SSH/GitHub profile IDs are preserved.

Active direct SSH or local jobs cannot be reattached after a daemon restart and become `lost`. Runner tasks reconnect from their last event sequence.

## Host key profiles

Add `hostKeyAlgorithm` beside `hostKeySha256`. This avoids repeated negotiation across ED25519, ECDSA, and RSA keys. Migrate an old profile with `runbeacon runner migrate-host-key --profile <id>` or confirmed `runner_manage(action="migrate-host-key")`. The probe requires the existing pinned SHA256 fingerprint, authenticates only after it matches, and updates the profile only after one algorithm succeeds. A profile that already pins an algorithm fails closed without trying another key type.

## Execution modes

`executionMode` defaults to `auto`. Set `requireDurable: true` or `executionMode: runner` for non-replayable work. Direct SSH remains available but is explicitly non-durable and cannot verify remote process cancellation.

Runner installation on macOS must occur locally in an Aqua login session. RunBeacon never unlocks Keychain or copies a Developer ID private key through SSH.

## Progress and adapters

RE2 restrictions from 2.0 remain. `generic` also accepts `RUNBEACON_EVENT <JSON>`. Training metrics must be emitted as structured epoch, step, loss, ETA, checkpoint, and GPU fields. Slurm commands must return a numeric ID from `sbatch --parsable`; cancellation succeeds only after `scancel`, queue absence, and a `CANCELLED` or `PREEMPTED` accounting state are all observed. Apple signing requires environment references `RUNBEACON_APPLE_SIGNING_IDENTITY` and `RUNBEACON_NOTARY_PROFILE` in the Runner's LaunchAgent context.

Clients may opt into experimental MCP Tasks. RunBeacon uses the existing job ID as the task ID, so task cancellation and result retrieval do not create or replay another job. Clients without Tasks require no migration.

## Approval

Commands classified as privileged, credential/private-key, release, or destructive pause in `awaiting_approval`. Approve them in the dashboard or interactive CLI. Models cannot approve jobs through MCP tools. Grants expire after five minutes by default.

## Release and rollback

Beta and Stable promotion are manual. Stable stops before tagging unless the same commit has soaked as a public Beta for seven complete days, the dedicated acceptance workflow succeeded on that SHA, and its attested Linux training, Mac signing, and fresh Codex task reports match the requested versions. Stable verifies and reuses the exact Beta Runner assets rather than rebuilding timestamped binaries. Main CodeQL High/Critical, unexpected dismissals, Node/Go vulnerabilities, or any signing, Notary, asset, audit, package, or plugin failure also blocks promotion.

To roll back, pin npm major 2 and plugin 1.x. Runner uninstall refuses active tasks and preserves state by default.
