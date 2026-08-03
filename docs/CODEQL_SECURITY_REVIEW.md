# CodeQL security review notes

This file records the evidence required to close or retain the CodeQL alerts addressed by the 2.0.0 security PR. Alert state must be confirmed from a GitHub session with Security permission; local line numbers are not a substitute for the uploaded PR analysis.

## Required code fixes

- #64 and #65: close only when the PR analysis no longer finds clear-text logging flows. Do not dismiss them. Logger inputs are copied, bounded, and redacted before any Winston method is called; the formatter remains a second layer.
- #67 and #68: close only when the PR analysis confirms that both Xen XAPI call paths use the shared HTTPS helper with certificate and hostname validation enabled.
- #69 and #70: close only when the PR analysis confirms bounded shared wait coordination and no user-controlled native JavaScript regular expression construction in `LifecycleManager`.
- #66: export and inspect the alert with Security permission. It requires a code fix and regression test or separate human approval; it must not be dismissed by default.
- #63: the Security API located this alert at `OutputPaginationManager.calculateBufferChecksum`, not in VNC. The MD5 checksum is replaced with SHA-256, continuation-token IDs use `crypto.randomUUID()`, and regression tests cover both properties. Do not dismiss this alert.

## VNC protocol compatibility note

No current alert covered by this PR maps to `VNCProtocol.vncAuthChallenge`; the #63 exception considered during planning is therefore invalid and must not be used.

The retained cipher is required for RFB VNC challenge-response compatibility. RunBeacon does not select raw `VNC_AUTH`, rejects VeNCrypt `PLAIN`, rejects disabled certificate validation, and calls the challenge helper only when the active socket is the certificate-verified TLS socket and the negotiated VeNCrypt subtype is `TLS_VNC` or `X509_VNC`. Regression tests cover raw-auth rejection, unauthorized and generic-TLS helper rejection, both permitted VeNCrypt subtypes, and TLS-before-challenge ordering.

If a future CodeQL analysis reports the protocol-required DES helper, it needs a separate, alert-specific security review and approval. It must not inherit a dismissal from #63.
