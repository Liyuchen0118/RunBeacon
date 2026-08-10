# runbeacon-runner

This package installs the signed RunBeacon Runner binary for the current Linux or macOS user. It verifies `SHA256SUMS` before copying the binary and delegates service setup to `runbeacon-runner install`.

macOS installation must run locally in an active Aqua login session. Installation over SSH is rejected so the LaunchAgent inherits the user's Keychain context.
