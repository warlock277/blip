/**
 * Raw TCP connect check.
 *
 * Opens a socket to host:port, measures the connect time, then closes it.
 * Used both as a `type: "tcp"` primary check and as the transport probe for
 * sites that only expose a port. Never throws.
 */

import { connect } from "node:net";
import type { CheckResult } from "@pulse/shared";
import { iso } from "../util/time.js";

export interface TcpProbe {
  ok: boolean;
  responseTime: number | null;
  error?: string;
}

/** Low-level TCP connect probe (no CheckResult wrapping). */
export function tcpConnect(host: string, port: number, timeoutMs: number): Promise<TcpProbe> {
  return new Promise<TcpProbe>((resolveProbe) => {
    const started = Date.now();
    let settled = false;
    const socket = connect({ host, port });

    const finish = (probe: TcpProbe): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(probe);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ ok: true, responseTime: Date.now() - started }));
    socket.once("timeout", () =>
      finish({ ok: false, responseTime: null, error: `TCP connect timed out after ${timeoutMs}ms` }),
    );
    socket.once("error", (err: Error) =>
      finish({ ok: false, responseTime: null, error: err.message || "TCP connect failed" }),
    );
  });
}

/** Parse a host:port target. Falls back to `defaultPort` when no port present. */
export function parseHostPort(
  url: string,
  explicitPort?: number,
  defaultPort = 80,
): { host: string; port: number } {
  // Strip any scheme.
  let target = url.replace(/^[a-z]+:\/\//i, "");
  // Strip path / query.
  const slash = target.indexOf("/");
  if (slash !== -1) target = target.slice(0, slash);

  let host = target;
  let port = explicitPort ?? defaultPort;
  const colon = target.lastIndexOf(":");
  if (colon !== -1) {
    const maybePort = Number(target.slice(colon + 1));
    if (Number.isInteger(maybePort) && maybePort > 0) {
      host = target.slice(0, colon);
      port = explicitPort ?? maybePort;
    }
  }
  return { host, port };
}

export async function checkTcp(
  siteId: string,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<CheckResult> {
  const checkedAt = iso();
  const probe = await tcpConnect(host, port, timeoutMs);
  if (probe.ok) {
    return { siteId, status: "up", responseTime: probe.responseTime, checkedAt };
  }
  return {
    siteId,
    status: "down",
    responseTime: null,
    checkedAt,
    error: probe.error ?? `TCP connect to ${host}:${port} failed`,
  };
}
