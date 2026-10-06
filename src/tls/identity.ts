// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The bridge's TLS identity: its client certificate and key (from the .p12
 * issued by TAK Portal) plus the TAK Server CA. It is loaded once at startup
 * and shared by every connection: the CoT stream on 8089 in v1, and later the
 * TAK-CAD poller on the API port.
 *
 * Loading lands in P1. Node's `tls.connect` accepts a .p12 directly via
 * `pfx` + `passphrase`, so no certificate library is needed.
 */
export interface TlsIdentity {
  /** Raw client .p12 bytes. */
  pfx: Buffer;
  passphrase: string;
  /** Trusted CA certificates (PEM), from a PEM file or extracted from a truststore .p12. */
  ca: string[];
  /** TLS server name to verify, when it differs from the host. */
  serverName?: string;
}
