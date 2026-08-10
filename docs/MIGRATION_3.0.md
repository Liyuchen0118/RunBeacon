# Migration to RunBeacon 3.0

RunBeacon 3.0 narrows the npm core to persistent job lifecycle work and introduces a durable remote Runner. This is a breaking release.

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

| Old | New |
| --- | --- |
| `RJM_STATE_PATH` | `RUNBEACON_STATE_PATH` |
| `RJM_MAX_CONCURRENT_JOBS` | `RUNBEACON_MAX_CONCURRENT_JOBS` |
| `RJM_MAX_OUTPUT_BYTES` | `RUNBEACON_MAX_OUTPUT_BYTES` |
| `RJM_PERSIST_OUTPUT` | `RUNBEACON_PERSIST_OUTPUT` |
| `RJM_PERSIST_METADATA` | `RUNBEACON_PERSIST_METADATA` |
| `RJM_SSH_HANDSHAKE_ATTEMPTS` | `RUNBEACON_SSH_HANDSHAKE_ATTEMPTS` |
| `RJM_SSH_RETRY_BASE_DELAY_MS` | `RUNBEACON_SSH_RETRY_BASE_DELAY_MS` |
| `RJM_SSH_READY_TIMEOUT_MS` | `RUNBEACON_SSH_READY_TIMEOUT_MS` |

The default data directory moves from `~/.remote-job-monitor` to `~/.runbeacon`. RunBeacon attempts one atomic rename and falls back to the old directory if the rename is unavailable. Credential files contain references only; passwords, PATs, passphrases, and private key material are not copied.

## State migration

The daemon creates an owner-only `jobs.json.v1.backup.json`, then writes state store v2 as checked JSONL events plus atomic snapshots. Legacy `orphaned` states map to `lost`. Existing terminal history and default SSH/GitHub profile IDs are preserved.

Active direct SSH or local jobs cannot be reattached after a daemon restart and become `lost`. Runner tasks reconnect from their last event sequence.

## Host key profiles

Add `hostKeyAlgorithm` beside `hostKeySha256`. This avoids repeated negotiation across ED25519, ECDSA, and RSA keys. Migrate an old profile with one explicit host-key probe and confirm the returned algorithm and SHA256 fingerprint out of band.

## Execution modes

`executionMode` defaults to `auto`. Set `requireDurable: true` or `executionMode: runner` for non-replayable work. Direct SSH remains available but is explicitly non-durable and cannot verify remote process cancellation.

Runner installation on macOS must occur locally in an Aqua login session. RunBeacon never unlocks Keychain or copies a Developer ID private key through SSH.

## Progress and adapters

RE2 restrictions from 2.0 remain. `generic` also accepts `RUNBEACON_EVENT <JSON>`. Training metrics must be emitted as structured epoch, step, loss, ETA, checkpoint, and GPU fields. Slurm commands must return a numeric ID from `sbatch --parsable`. Apple signing requires environment references `RUNBEACON_APPLE_SIGNING_IDENTITY` and `RUNBEACON_NOTARY_PROFILE` in the Runner's LaunchAgent context.

## Approval

Commands classified as privileged, credential/private-key, release, or destructive pause in `awaiting_approval`. Approve them in the dashboard or interactive CLI. Models cannot approve jobs through MCP tools. Grants expire after five minutes by default.

## Release and rollback

Stable promotion is manual and stops before tagging if main has any open High/Critical CodeQL alert or a Node, Go, signing, Notary, asset, audit, package, or plugin gate fails.

To roll back, pin npm major 2 and plugin 1.x. Runner uninstall refuses active tasks and preserves state by default.
