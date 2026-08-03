# RunBeacon 2.0 security migration

RunBeacon npm 2.0.0 and Codex plugin 1.0.0 intentionally narrow several protocol and lifecycle behaviors. Upgrade configurations before deploying this release.

## Lifecycle progress patterns

`progressPattern` remains a string, but it now uses RE2-compatible syntax and is compiled once when the job starts. The pattern must be at most 256 characters and capture a finite numeric percentage in group 1.

```text
^(\d{1,3}(?:\.\d+)?)%\s+\[[A-Za-z][A-Za-z0-9_-]{0,63}\].*$
```

Backreferences and lookaround are not supported. Replace backreference-based validation with explicit character classes or validate the captured value after matching. Each output line is matched only against its final 16 KiB; the normal output ring buffer remains independently bounded.

`job_wait` now permits at most eight simultaneous callers for one job and 128 across a manager. Exceeding those limits returns `job_wait limit reached for job` or `global job_wait limit reached` without allocating a partial waiter.

## VNC authentication

RunBeacon no longer selects raw RFB `VNC_AUTH`, and it rejects VeNCrypt `PLAIN`. Protocol-required VNC DES challenge authentication is available only through `TLS_VNC` or `X509_VNC` after certificate-chain and hostname verification succeeds.

`tlsOptions.rejectUnauthorized` can only be `true` or omitted. A runtime value of `false` fails immediately. Put trusted PEM CA contents in `tlsOptions.certificates.ca`; do not use a certificate-validation bypass. Servers that offer only raw VNC password authentication must be upgraded or placed behind a certificate-verified VeNCrypt/TLS endpoint.

## Xen XAPI HTTPS

XAPI now requires HTTPS. `--nossl` is rejected before credentials are sent. Self-signed deployments must explicitly trust their CA:

```text
--ca-file /etc/runbeacon/xen-ca.pem
```

or set `XEN_CA_FILE`. An optional additional certificate pin is available through `--server-cert-sha256` or `XEN_SERVER_CERT_SHA256`:

```text
sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The pin does not replace CA-chain or hostname validation. XAPI requests default to 30 seconds, accept only 1,000–120,000 milliseconds through the existing timeout option or `XEN_TIMEOUT_MS`, require a 2xx response with valid JSON, and reject response bodies larger than 1 MiB.

## Logging

The `info`, `error`, `warn`, and `debug` APIs are unchanged. Values are now copied, bounded, and redacted before entering Winston. MCP mode still writes neither stdout nor files by default; setting `MCP_LOG_DIR` explicitly enables owner-only file logs.
