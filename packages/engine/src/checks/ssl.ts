/**
 * TLS certificate expiry probe.
 *
 * Opens a TLS connection to host:443 (SNI = host), reads the peer certificate's
 * `valid_to`, and computes days remaining + whether it falls within the warn
 * window. Returns `null` (with a logged warning) on any failure so it never
 * aborts the surrounding check.
 */

import { connect, type PeerCertificate } from "node:tls";
import type { SslInfo } from "@blip/shared";
import { iso, daysUntil } from "../util/time.js";
import { log } from "../util/log.js";

const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Flatten a tls subject/issuer object (e.g. { CN, O }) into a readable string. */
function formatName(name: PeerCertificate["issuer"] | undefined): string | undefined {
  if (!name || typeof name !== "object") return undefined;
  const rec = name as Record<string, string>;
  return rec["CN"] ?? rec["O"] ?? rec["OU"] ?? undefined;
}

export function checkSsl(host: string, warnDays: number, port = 443): Promise<SslInfo | null> {
  return new Promise<SslInfo | null>((resolveSsl) => {
    let settled = false;
    const finish = (value: SslInfo | null): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolveSsl(value);
    };

    const socket = connect(
      {
        host,
        port,
        servername: host,
        // We want the cert even if it's expired/invalid; we report on it ourselves.
        rejectUnauthorized: false,
        timeout: HANDSHAKE_TIMEOUT_MS,
      },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          if (!cert || !cert.valid_to) {
            log.warn(`ssl: no certificate returned for ${host}`);
            finish(null);
            return;
          }
          const validToMs = Date.parse(cert.valid_to);
          if (Number.isNaN(validToMs)) {
            log.warn(`ssl: unparseable valid_to "${cert.valid_to}" for ${host}`);
            finish(null);
            return;
          }
          const daysRemaining = daysUntil(validToMs);
          const info: SslInfo = {
            validTo: iso(validToMs),
            daysRemaining,
            expiringSoon: daysRemaining <= warnDays,
          };
          const issuer = formatName(cert.issuer);
          const subject = formatName(cert.subject);
          if (issuer) info.issuer = issuer;
          if (subject) info.subject = subject;
          finish(info);
        } catch (err) {
          log.warn(`ssl: failed reading certificate for ${host}: ${(err as Error).message}`);
          finish(null);
        }
      },
    );

    socket.once("timeout", () => {
      log.warn(`ssl: handshake timed out for ${host}`);
      finish(null);
    });
    socket.once("error", (err: Error) => {
      log.warn(`ssl: connection error for ${host}: ${err.message}`);
      finish(null);
    });
  });
}
