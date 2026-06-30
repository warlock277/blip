/**
 * Check dispatcher.
 *
 * Runs the primary probe for a site (by `type`), then layers on the optional
 * SSL and domain probes when enabled. Returns a single `CheckResult`. Honors
 * `site.paused` by returning a synthetic "up" result tagged as paused via the
 * error field — callers (summary builder) read `site.paused` directly, so the
 * status here is informational only.
 */

import type { CheckResult, EngineDefaults, SslInfo, DomainInfo } from "@pulse/shared";
import { domainWarnDaysFor, sslWarnDaysFor, type ResolvedSite } from "../config.js";
import { iso } from "../util/time.js";
import { checkHttp } from "./http.js";
import { checkSsl } from "./ssl.js";
import { checkDomain } from "./domain.js";
import { checkTcp, parseHostPort } from "./tcp.js";

type RequiredDefaults = Required<EngineDefaults>;

/** Extract the hostname from a site's URL for SSL/domain probes. */
function hostnameOf(url: string): string {
  try {
    // Add a scheme if missing so URL() can parse bare hosts.
    const withScheme = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(withScheme).hostname;
  } catch {
    // Fallback: strip scheme/path manually.
    return parseHostPort(url).host;
  }
}

async function runPrimary(site: ResolvedSite, defaults: RequiredDefaults): Promise<CheckResult> {
  switch (site.type) {
    case "tcp": {
      const { host, port } = parseHostPort(site.url, site.port, 0);
      if (!port) {
        return {
          siteId: site.id,
          status: "down",
          responseTime: null,
          checkedAt: iso(),
          error: "TCP check requires a port (set `port:` or use host:port in `url`)",
        };
      }
      const timeoutMs = site.timeoutMs ?? defaults.timeoutMs;
      return checkTcp(site.id, host, port, timeoutMs);
    }
    case "ssl": {
      // SSL-only site: the certificate check IS the primary result.
      const host = hostnameOf(site.url);
      const warnDays = sslWarnDaysFor(site, defaults) ?? defaults.sslWarnDays;
      const info = await checkSsl(host, warnDays);
      const checkedAt = iso();
      if (!info) {
        return {
          siteId: site.id,
          status: "down",
          responseTime: null,
          checkedAt,
          error: `Unable to read TLS certificate for ${host}`,
        };
      }
      const result: CheckResult = {
        siteId: site.id,
        status: info.daysRemaining <= 0 ? "down" : info.expiringSoon ? "degraded" : "up",
        responseTime: null,
        checkedAt,
        ssl: info,
      };
      if (info.daysRemaining <= 0) result.error = "TLS certificate has expired";
      else if (info.expiringSoon) result.error = `TLS certificate expires in ${info.daysRemaining} days`;
      return result;
    }
    case "domain": {
      // Domain-only site: the registration check IS the primary result.
      const host = hostnameOf(site.url);
      const warnDays = domainWarnDaysFor(site, defaults) ?? defaults.domainWarnDays;
      const info = await checkDomain(host, warnDays);
      const checkedAt = iso();
      if (!info) {
        return {
          siteId: site.id,
          status: "down",
          responseTime: null,
          checkedAt,
          error: `Unable to read domain registration for ${host}`,
        };
      }
      const result: CheckResult = {
        siteId: site.id,
        status: info.daysRemaining <= 0 ? "down" : info.expiringSoon ? "degraded" : "up",
        responseTime: null,
        checkedAt,
        domain: info,
      };
      if (info.daysRemaining <= 0) result.error = "Domain registration has expired";
      else if (info.expiringSoon) result.error = `Domain expires in ${info.daysRemaining} days`;
      return result;
    }
    case "http":
    default:
      return checkHttp(site, defaults);
  }
}

export async function runSiteCheck(
  site: ResolvedSite,
  defaults: RequiredDefaults,
): Promise<CheckResult> {
  if (site.paused) {
    return {
      siteId: site.id,
      status: "up",
      responseTime: null,
      checkedAt: iso(),
      error: "paused",
    };
  }

  const result = await runPrimary(site, defaults);

  // Layer ssl/domain probes onto http/tcp sites (skip when they already are
  // the primary check type).
  const layerSsl = site.type !== "ssl" && site.ssl;
  const layerDomain = site.type !== "domain" && site.domain;

  const host = hostnameOf(site.url);

  const probes: Promise<void>[] = [];
  let sslInfo: SslInfo | null = null;
  let domainInfo: DomainInfo | null = null;

  if (layerSsl) {
    const warnDays = sslWarnDaysFor(site, defaults) ?? defaults.sslWarnDays;
    probes.push(
      checkSsl(host, warnDays).then((info) => {
        sslInfo = info;
      }),
    );
  }
  if (layerDomain) {
    const warnDays = domainWarnDaysFor(site, defaults) ?? defaults.domainWarnDays;
    probes.push(
      checkDomain(host, warnDays).then((info) => {
        domainInfo = info;
      }),
    );
  }

  if (probes.length > 0) await Promise.all(probes);

  if (sslInfo) result.ssl = sslInfo;
  if (domainInfo) result.domain = domainInfo;

  return result;
}
