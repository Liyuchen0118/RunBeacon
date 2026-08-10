import { StartJobInput } from './types.js';

export function commandForAdapter(input: StartJobInput): string {
  switch (input.adapter ?? 'generic') {
    case 'slurm':
      return slurmCommand(input.command);
    case 'apple-signing':
      return appleSigningCommand(input.command);
    default:
      return input.command;
  }
}

function slurmCommand(submitCommand: string): string {
  return [
    'set -eu',
    'rb_slurm_id="$(',
    submitCommand,
    ')"',
    "rb_slurm_id=$(printf '%s' \"$rb_slurm_id\" | head -n 1 | cut -d';' -f1)",
    "case \"$rb_slurm_id\" in ''|*[!0-9]*) echo 'Invalid Slurm job id' >&2; exit 64;; esac",
    'printf \'RUNBEACON_EVENT {"phase":"slurm","message":"Slurm job %s submitted"}\\n\' "$rb_slurm_id"',
    'trap \'scancel "$rb_slurm_id" >/dev/null 2>&1 || true; exit 143\' TERM INT HUP',
    'while squeue -h -j "$rb_slurm_id" 2>/dev/null | grep -q .; do',
    '  rb_state=$(squeue -h -j "$rb_slurm_id" -o \'%T\' 2>/dev/null | head -n 1 || true)',
    '  printf \'RUNBEACON_EVENT {"phase":"slurm","message":"Slurm %s: %s"}\\n\' "$rb_slurm_id" "$rb_state"',
    '  sleep 10',
    'done',
    'rb_state=$(sacct -n -X -j "$rb_slurm_id" --format=State -P 2>/dev/null | head -n 1 | cut -d\'|\' -f1 | cut -d+ -f1)',
    'printf \'RUNBEACON_EVENT {"phase":"slurm","message":"Slurm %s finished: %s"}\\n\' "$rb_slurm_id" "$rb_state"',
    'case "$rb_state" in COMPLETED) exit 0;; CANCELLED*) exit 130;; TIMEOUT*) exit 124;; *) exit 1;; esac',
  ].join('\n');
}

function appleSigningCommand(command: string): string {
  return [
    'set -eu',
    '[ "$(uname -s)" = Darwin ] || { echo "Apple signing requires macOS" >&2; exit 69; }',
    'rb_uid=$(id -u)',
    'launchctl print "gui/$rb_uid" >/dev/null 2>&1 || { echo "A logged-in Aqua session is required" >&2; exit 69; }',
    ': "${RUNBEACON_APPLE_SIGNING_IDENTITY:?RUNBEACON_APPLE_SIGNING_IDENTITY is required}"',
    ': "${RUNBEACON_NOTARY_PROFILE:?RUNBEACON_NOTARY_PROFILE is required}"',
    'security find-identity -v -p codesigning | grep -F -- "$RUNBEACON_APPLE_SIGNING_IDENTITY" >/dev/null',
    'rb_tmp=$(mktemp -d "${TMPDIR:-/tmp}/runbeacon-signing.XXXXXX")',
    'trap \'rm -rf "$rb_tmp"\' EXIT HUP INT TERM',
    'printf \'#!/bin/sh\\nexit 0\\n\' >"$rb_tmp/probe"',
    'chmod 700 "$rb_tmp/probe"',
    'codesign --force --options runtime --sign "$RUNBEACON_APPLE_SIGNING_IDENTITY" "$rb_tmp/probe"',
    'codesign --verify --strict --verbose=2 "$rb_tmp/probe"',
    'codesign --force --options runtime --timestamp --sign "$RUNBEACON_APPLE_SIGNING_IDENTITY" "$rb_tmp/probe"',
    'codesign --verify --strict --verbose=2 "$rb_tmp/probe"',
    'xcrun notarytool history --keychain-profile "$RUNBEACON_NOTARY_PROFILE" >/dev/null',
    'printf \'RUNBEACON_EVENT {"phase":"apple-signing","percentage":100,"message":"Signing and Notary preflight passed"}\\n\'',
    command,
  ].join('\n');
}
