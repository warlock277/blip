/**
 * Domain-registration expiry probe via RDAP.
 *
 * RDAP (rdap.org acts as a bootstrap/redirector) returns a JSON document whose
 * `events` array contains lifecycle events. We look for an `expiration` event
 * and read its `eventDate`. RDAP responses are inconsistent across registries,
 * so this is intentionally defensive about shape.
 *
 * Returns `null` (with a logged warning) on any failure.
 */

import type { DomainInfo } from "@blip/shared";
import { iso, daysUntil } from "../util/time.js";
import { log } from "../util/log.js";

const RDAP_TIMEOUT_MS = 10_000;

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}

interface RdapEntity {
  roles?: string[];
  vcardArray?: unknown;
}

interface RdapResponse {
  events?: RdapEvent[];
  entities?: RdapEntity[];
}

/**
 * Reduce a hostname to its registrable domain (e.g. `api.foo.co.uk` → `foo.co.uk`).
 * This is a heuristic — a real PSL would be more accurate, but RDAP bootstrap
 * tolerates the registrable apex and most multi-label public suffixes here.
 */
export function registrableDomain(input: string): string {
  let host = input.replace(/^[a-z]+:\/\//i, "");
  const slash = host.indexOf("/");
  if (slash !== -1) host = host.slice(0, slash);
  const colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  host = host.replace(/\.$/, "").toLowerCase();

  const labels = host.split(".");
  if (labels.length <= 2) return host;

  // Common two-level public suffixes where the registrable name is the last 3 labels.
  const twoLevelTlds = new Set([
    "co.uk",
    "org.uk",
    "gov.uk",
    "ac.uk",
    "com.au",
    "net.au",
    "org.au",
    "co.nz",
    "co.jp",
    "com.br",
    "com.cn",
    "co.in",
    "co.za",
  ]);
  const lastTwo = labels.slice(-2).join(".");
  if (twoLevelTlds.has(lastTwo)) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

/** Pull a registrar name out of the RDAP entities array, if present. */
function extractRegistrar(entities: RdapEntity[] | undefined): string | undefined {
  if (!entities) return undefined;
  for (const ent of entities) {
    if (!ent.roles?.includes("registrar")) continue;
    const vcard = ent.vcardArray;
    // vcardArray is ["vcard", [ [ "fn", {}, "text", "Registrar Name" ], ... ] ]
    if (Array.isArray(vcard) && vcard.length >= 2 && Array.isArray(vcard[1])) {
      for (const entry of vcard[1] as unknown[]) {
        if (Array.isArray(entry) && entry[0] === "fn" && typeof entry[3] === "string") {
          return entry[3];
        }
      }
    }
  }
  return undefined;
}

export async function checkDomain(domain: string, warnDays: number[]): Promise<DomainInfo | null> {
  const apex = registrableDomain(domain);
  const url = `https://rdap.org/domain/${encodeURIComponent(apex)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RDAP_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/rdap+json, application/json" },
      redirect: "follow",
    });
    if (!res.ok) {
      log.warn(`domain: RDAP lookup for ${apex} returned HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as RdapResponse;
    const events = Array.isArray(data.events) ? data.events : [];
    const expEvent = events.find(
      (e) => e.eventAction === "expiration" && typeof e.eventDate === "string",
    );
    if (!expEvent?.eventDate) {
      log.warn(`domain: no expiration event in RDAP response for ${apex}`);
      return null;
    }
    const expMs = Date.parse(expEvent.eventDate);
    if (Number.isNaN(expMs)) {
      log.warn(`domain: unparseable expiration date "${expEvent.eventDate}" for ${apex}`);
      return null;
    }
    const daysRemaining = daysUntil(expMs);
    const maxWarn = warnDays.length > 0 ? Math.max(...warnDays) : 0;
    const info: DomainInfo = {
      expiresAt: iso(expMs),
      daysRemaining,
      expiringSoon: daysRemaining <= maxWarn,
    };
    const registrar = extractRegistrar(data.entities);
    if (registrar) info.registrar = registrar;
    return info;
  } catch (err) {
    const e = err as Error;
    const reason = e.name === "AbortError" ? "timed out" : e.message;
    log.warn(`domain: RDAP lookup for ${apex} failed: ${reason}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
