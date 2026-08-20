# Self-hosted Acceptance

RunBeacon uses the same three dedicated GitHub Actions runners for pre-release
rehearsals and post-Beta Stable evidence. The workflow fails closed when a
machine, login session, toolchain, release environment, or commit binding is
missing. Do not reuse these labels on general purpose runners.

## Required runners

| Role           | GitHub labels                          | Required session                                                         | Purpose                                                                                                                                                                                                      |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linux training | `self-hosted,Linux,runbeacon-training` | A user systemd session with `systemctl --user`                           | Install the real Runner service, restart it during a job, leave the supervisor running for ten minutes without an observer, resume events, and verify exactly-once execution and process-group cancellation. |
| Apple signing  | `self-hosted,macOS,runbeacon-signing`  | The signing user's active Aqua login session                             | Install the LaunchAgent Runner and use the login Keychain for Developer ID and Notary checks.                                                                                                                |
| Codex plugin   | `self-hosted,Windows,runbeacon-codex`  | The interactive Windows account that owns the personal Codex marketplace | Atomically reinstall the plugin and execute a fresh Codex task with exactly one `job_start` followed by one `job_wait`.                                                                                      |

Register each runner from **Repository settings > Actions > Runners > New
self-hosted runner**. Use GitHub's current per-machine download and registration
commands, add only the role label shown above, and install the GitHub runner as
the same user that owns the relevant RunBeacon or Codex state. Registration
tokens are short lived and must never be committed, copied into RunBeacon
profiles, or stored in workflow variables.

## Linux training machine

Install Git, Node.js 24, Go, and a user systemd session. The account must be
able to run:

```bash
systemctl --user show-environment
systemctl --user is-active runbeacon-runner.service
```

For a headless machine, enable lingering once from an administrator account so
the user's service remains available without an interactive shell:

```bash
loginctl enable-linger <runner-user>
```

Do not preinstall an unverified Runner binary. The acceptance script builds the
exact checked-out source, invokes `runbeacon-runner install`, verifies protocol
v1/version 3.0.0 and `KillMode=process`, then stops the real user service for
ten minutes while its independent training supervisor remains active. It
starts the service again and resumes every sequenced event without replaying
the command.

## macOS signing machine

Run the GitHub Actions runner interactively as the same logged-in Aqua user
that owns the Developer ID private key and the `meetflow-notary` Keychain
profile. Do not install it as a root daemon or launch it over SSH. Configure
these repository environment variables in the protected `apple-release`
environment:

```text
APPLE_SIGNING_IDENTITY=Developer ID Application: Yuchen Li (NS7YY6M3PV)
APPLE_NOTARY_PROFILE=meetflow-notary
```

The workflow passes only when `launchctl print gui/$UID` succeeds and the
LaunchAgent Runner completes untimestamped signing, timestamped signing, and a
Notary history query without receiving a Keychain password or `.p8` content.
It then signs a temporary copy of the Runner, submits a temporary ZIP with
`notarytool --wait`, and requires the returned status to be `Accepted`. The ZIP
is deleted at the end of the task and is never published as a release asset.

## Windows Codex machine

Install Git, Node.js 24, Python 3.12, Codex, and the personal marketplace under
the GitHub runner account. Keep Codex authentication and the marketplace local
to that account. The workflow installs pinned PyYAML before validation and
checks that `codex` is present before touching the plugin source.

The GitHub runner may run as a service only when that service account owns the
same Codex configuration and can start the Codex CLI non-interactively.
Otherwise run it interactively for acceptance. The test uses an isolated
`PLUGIN_DATA` directory and restores the previous plugin source/cache after a
failure.

## Rehearsal and Beta modes

`workflow_dispatch` defaults to `mode: rehearsal`. Rehearsal requires the exact
`main` commit but does not require or create a tag, Release, npm publication, or
promotion. Its schema v2 reports always contain:

```json
{
  "acceptanceMode": "rehearsal",
  "stableEligible": false
}
```

Use rehearsal while preparing 3.0. A future `mode: beta` run additionally
requires `beta_tag` to name a public prerelease whose tag resolves to the exact
workflow SHA. Beta reports may set `stableEligible: true` only when every
machine check passes. The Stable verifier rejects rehearsal reports even when
all their checks passed.

## Preflight and promotion

Before dispatching either mode, all three runners must be online and idle in
GitHub's runner settings. Do not dispatch beta mode until the public Beta tag
exists on the exact `main` commit. The workflow itself runs:

```text
node scripts/acceptance/machine-preflight.mjs <role>
```

for each role, then produces secret-free JSON evidence and a GitHub provenance
attestation. Stable promotion accepts only evidence from the same commit,
generated after the public Beta, no older than 30 days, and only after seven
complete Beta days.

Taking a machine offline or changing a label after a run does not invalidate an
existing attestation, but a new acceptance run must not be dispatched until all
three dedicated runners are healthy again.
