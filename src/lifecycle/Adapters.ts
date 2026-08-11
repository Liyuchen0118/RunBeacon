import { StartJobInput } from './types.js';

export function commandForAdapter(input: StartJobInput): string {
  validateAdapterInput(input);
  switch (input.adapter ?? 'generic') {
    case 'slurm':
      return slurmCommand(input.command);
    case 'apple-signing':
      return appleSigningCommand(input.command);
    default:
      return input.command;
  }
}

export function validateAdapterInput(input: StartJobInput): void {
  if (input.adapter !== 'slurm') return;
  const submit = input.command.trim();
  if (
    !/^sbatch(?:\s|$)/.test(submit) ||
    !/(?:^|\s)--parsable(?:=\S+)?(?:\s|$)/.test(submit)
  ) {
    throw new Error(
      'INVALID_REQUEST: slurm adapter requires an sbatch --parsable command'
    );
  }
}

function slurmCommand(submitCommand: string): string {
  return [
    'set -eu',
    ': "${RUNBEACON_CANCELLATION_ACK_FILE:?Slurm cancellation acknowledgement path is required}"',
    ': "${RUNBEACON_TERMINAL_STATE_FILE:?Slurm terminal state path is required}"',
    'rb_slurm_id="$(',
    submitCommand,
    ')"',
    "rb_slurm_id=$(printf '%s' \"$rb_slurm_id\" | head -n 1 | cut -d';' -f1)",
    "case \"$rb_slurm_id\" in ''|*[!0-9]*) echo 'Invalid Slurm job id' >&2; exit 64;; esac",
    'printf \'RUNBEACON_EVENT {"phase":"slurm","message":"Slurm job %s submitted"}\\n\' "$rb_slurm_id"',
    'rb_cancel() {',
    '  if ! scancel "$rb_slurm_id" >/dev/null 2>&1; then echo "scancel failed for $rb_slurm_id" >&2; exit 70; fi',
    '  rb_cancel_attempt=0',
    '  while [ "$rb_cancel_attempt" -lt 30 ]; do',
    '    rb_queue=$(squeue -h -j "$rb_slurm_id" 2>/dev/null || true)',
    '    rb_cancel_state=$(sacct -n -X -j "$rb_slurm_id" --format=State -P 2>/dev/null | head -n 1 | cut -d\'|\' -f1 | cut -d+ -f1)',
    '    if [ -z "$rb_queue" ]; then case "$rb_cancel_state" in CANCELLED*|PREEMPTED*) printf \'verified\\n\' >"$RUNBEACON_CANCELLATION_ACK_FILE"; exit 130;; esac; fi',
    '    rb_cancel_attempt=$((rb_cancel_attempt + 1))',
    '    sleep 1',
    '  done',
    '  echo "scancel could not be verified for $rb_slurm_id" >&2',
    '  exit 70',
    '}',
    'trap rb_cancel TERM INT HUP',
    'while squeue -h -j "$rb_slurm_id" 2>/dev/null | grep -q .; do',
    '  rb_state=$(squeue -h -j "$rb_slurm_id" -o \'%T\' 2>/dev/null | head -n 1 || true)',
    '  printf \'RUNBEACON_EVENT {"phase":"slurm","message":"Slurm %s: %s"}\\n\' "$rb_slurm_id" "$rb_state"',
    '  sleep 10',
    'done',
    'rb_state=$(sacct -n -X -j "$rb_slurm_id" --format=State -P 2>/dev/null | head -n 1 | cut -d\'|\' -f1 | cut -d+ -f1)',
    'printf \'RUNBEACON_EVENT {"phase":"slurm","message":"Slurm %s finished: %s"}\\n\' "$rb_slurm_id" "$rb_state"',
    'case "$rb_state" in COMPLETED) exit 0;; CANCELLED*) printf \'cancelled\\n\' >"$RUNBEACON_TERMINAL_STATE_FILE"; exit 130;; TIMEOUT*) printf \'timed_out\\n\' >"$RUNBEACON_TERMINAL_STATE_FILE"; exit 124;; *) exit 1;; esac',
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
    'printf \'int main(void) { return 0; }\\n\' >"$rb_tmp/probe.c"',
    'xcrun clang -Os -o "$rb_tmp/probe" "$rb_tmp/probe.c"',
    'codesign --force --options runtime --timestamp=none --sign "$RUNBEACON_APPLE_SIGNING_IDENTITY" "$rb_tmp/probe"',
    'codesign --verify --strict --verbose=2 "$rb_tmp/probe"',
    'if codesign -d --verbose=4 "$rb_tmp/probe" 2>&1 | grep -q \'^Timestamp=\'; then echo "Unexpected timestamp on untimestamped signature" >&2; exit 65; fi',
    'codesign --force --options runtime --timestamp --sign "$RUNBEACON_APPLE_SIGNING_IDENTITY" "$rb_tmp/probe"',
    'codesign --verify --strict --verbose=2 "$rb_tmp/probe"',
    'codesign -d --verbose=4 "$rb_tmp/probe" 2>&1 | grep -q \'^Timestamp=\'',
    'xcrun notarytool history --keychain-profile "$RUNBEACON_NOTARY_PROFILE" >/dev/null',
    'printf \'RUNBEACON_EVENT {"phase":"apple-signing","percentage":100,"message":"Signing and Notary preflight passed"}\\n\'',
    command,
  ].join('\n');
}
