# runbeacon-runner

This package installs the signed RunBeacon Runner binary for the current Linux or macOS user. Before touching the installed binary, it verifies the SHA256 checksum, certificate transparency record, and Sigstore transparency-log bundle against the exact RunBeacon `release.yml` identity on `main`. It also verifies the embedded Runner version. Upgrades use an atomic replacement and restore the previous binary if service installation fails.

macOS installation must run locally in an active Aqua login session. Installation over SSH is rejected so the LaunchAgent inherits the user's Keychain context.
