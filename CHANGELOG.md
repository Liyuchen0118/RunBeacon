# Changelog

## 3.0.0 (2026-08-11)

### Breaking changes

- narrow the npm package to lifecycle, CLI, MCP, credentials, GitHub publishing, policy, audit, and subscriptions
- move the old `mcp-console` entry point and 40-tool protocol surface to the 2.0.x legacy line
- require Node.js 22 or 24 and rename `RJM_*` configuration to `RUNBEACON_*` with 3.x aliases

### Features

- add protocol-v1 Go Runner supervisors with Unix socket RPC, idempotent stdin submission, sequenced recovery, bounded output, timeout, and verified process-group cancellation
- add daemon protocol v5, event store v2, `lost` recovery state, execution phases, durability metadata, and `job_watch`
- add interactive approval, hash-chain audit, event subscriptions, and loopback single-task dashboard fallback
- add generic, training, Slurm, and macOS Apple-signing adapters
- add Linux user systemd and macOS Aqua LaunchAgent installers
- map lifecycle jobs to optional experimental MCP Tasks without changing the `job_start -> job_wait` fallback
- add explicit pinned-fingerprint SSH host-key algorithm migration and native desktop notifications
- map verified Slurm scheduler cancellation and timeout outcomes to native lifecycle states

### Security and release

- prevent direct SSH fallback after possible Runner acceptance
- keep commands, credentials, approval metadata, and signing secrets out of Runner argv, snapshots, service files, and audit records
- add independent JavaScript/TypeScript and Go CodeQL, Go race/vulnerability gates, four-platform assets, SHA256, Sigstore, provenance, SBOM, Developer ID signing, and Notary checks
- replace automatic releases with a manual promotion gate that refuses tags while main has open CodeQL High/Critical alerts
- require exact GitHub Actions Sigstore identity verification, signed-byte SBOM generation, a seven-day public Beta, and attested Linux/Mac/Codex acceptance before Stable
- require Slurm scheduler acknowledgement in addition to process-group exit before reporting cancellation
- reject deprecated SSH RSA/SHA-1 negotiation while retaining RSA SHA-2 host keys
- reject coordinator idempotency-key reuse with a different execution digest, including after restart
- preserve partially written Runner events for continuation and release pruned event cursors
- isolate desktop notifier processes from credential and task environment variables
- promote the exact signed Beta Runner assets to Stable instead of rebuilding them

## 2.0.0 (2026-08-03)

### Breaking security changes

- require RE2-compatible lifecycle progress patterns with capture group 1 and bounded input
- reject raw VNC challenge authentication, VeNCrypt PLAIN, and disabled TLS certificate validation
- require HTTPS for Xen XAPI and add explicit CA plus optional SHA-256 certificate pinning

### Security

- share one timer per job across bounded `job_wait` callers and release all resources on every terminal path
- cap Xen XAPI time, status, JSON, and response-body handling
- redact structured messages, errors, headers, URLs, command arguments, environment assignments, PEM keys, cookies, and cloud credentials before Winston sinks
- isolate CodeQL analysis from build, test, and dependency-audit failures

### Features

- add OS-backed SSH password profiles for IP/host and username connections, including default selection, safe deletion, and runtime-only password injection
- add protocol v4 monotonic daemon upgrades so older Codex tasks cannot replace a newer resident build
- bind one prompt trace to one tracked job, preventing automatic correction attempts from executing a second remote command
- add prompt-to-tool, credential, queue, SSH, command, and total timing to the live dashboard
- add a dashboard launcher that sends an exact command directly to the default SSH profile without a model turn
- bind each dashboard instance to its current job so unrelated task history is never loaded or displayed
- inject prompt traces into `job_start` with a session/turn-scoped Hook instead of model-dependent argument copying
- reduce failed SSH handshake latency with a bounded 12-second ready timeout and 250ms initial retry backoff
- separate confirmed Git pushes from best-effort Actions monitoring so transient API failures no longer misreport the push as failed
- add workflow and open-PR eligibility detection with a fast `no-workflows` terminal phase
- add bounded GitHub API retries, proxy reuse, `NO_PROXY`, safe diagnostics, and optional `requireActions` gating
