// @ts-nocheck
/**
 * gen-config.mjs — embed the resolved Blip config into the Worker bundle.
 *
 * Why: the Worker has no filesystem, so it cannot read blip.config.yaml at
 * runtime. This build step parses ../../blip.config.yaml, applies DEFAULTS,
 * derives site ids, normalizes ssl/domain options, and writes a typed
 * `src/config.generated.ts` exporting `CONFIG` (as const).
 *
 * Zero extra deps: only `yaml` (already a worker devDependency).
 *
 * NOTE: DEFAULTS + slugify below are inlined copies of
 * packages/shared/src/constants.ts. They MUST stay byte-identical in behaviour
 * (a .mjs cannot import the TS source). If shared/constants.ts changes, mirror
 * it here.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = resolve(__dirname, "..");
const ROOT = resolve(WORKER_DIR, "..", "..");
// Prefer the user's real config; fall back to the shipped example so a fresh
// clone builds/dev-runs before `npm run setup` writes blip.config.yaml.
const REAL_CONFIG = resolve(ROOT, "blip.config.yaml");
const EXAMPLE_CONFIG = resolve(ROOT, "config", "blip.config.example.yaml");
const CONFIG_PATH = existsSync(REAL_CONFIG) ? REAL_CONFIG : EXAMPLE_CONFIG;
const OUT_PATH = join(WORKER_DIR, "src", "config.generated.ts");

// --- inlined copy of shared/constants.ts DEFAULTS ---------------------------
const DEFAULTS = {
  timeoutMs: 10_000,
  retries: 2,
  degradedThresholdMs: 2_000,
  maxHistoryPoints: 2_016, // ~7 days at 5-minute interval
  sslWarnDays: 30,
  domainWarnDays: [30, 15, 7],
  userAgent: "Blip/0.1 (+https://github.com/warlock277/blip)",
};

// --- inlined copy of shared/constants.ts slugify (must match exactly) -------
function slugify(input) {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "site"
  );
}

/** Normalize ssl option → concrete warnDays number, or undefined when disabled. */
function normalizeSslWarnDays(ssl, defaults) {
  if (!ssl) return undefined;
  if (ssl === true) return defaults.sslWarnDays;
  return ssl.warnDays ?? defaults.sslWarnDays;
}

/** Normalize domain option → concrete warnDays[], or undefined when disabled. */
function normalizeDomainWarnDays(domain, defaults) {
  if (!domain) return undefined;
  if (domain === true) return defaults.domainWarnDays;
  return domain.warnDays && domain.warnDays.length > 0 ? domain.warnDays : defaults.domainWarnDays;
}

/** Drop keys whose value is undefined so they don't clobber DEFAULTS via spread. */
function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function main() {
  if (CONFIG_PATH === EXAMPLE_CONFIG) {
    // eslint-disable-next-line no-console
    console.log("gen-config: no blip.config.yaml found — using config/blip.config.example.yaml. Run `npm run setup` to create your own.");
  }
  const raw = readFileSync(CONFIG_PATH, "utf8");
  const parsed = parseYaml(raw) ?? {};

  if (!Array.isArray(parsed.sites) || parsed.sites.length === 0) {
    throw new Error(`gen-config: ${CONFIG_PATH} has no sites`);
  }

  const defaults = { ...DEFAULTS, ...stripUndefined(parsed.defaults) };

  const usedIds = new Set();
  const sites = parsed.sites.map((s) => {
    let id = (typeof s.id === "string" && s.id.trim()) || slugify(s.name ?? s.url ?? "site");
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    usedIds.add(id);

    const site = {
      ...s,
      id,
      type: s.type ?? "http",
      public: s.public ?? true,
      paused: s.paused ?? false,
    };

    // Replace the raw ssl/domain options with concrete, resolved warn windows.
    const sslWarnDays = normalizeSslWarnDays(s.ssl, defaults);
    const domainWarnDays = normalizeDomainWarnDays(s.domain, defaults);
    if (sslWarnDays !== undefined) site.sslWarnDays = sslWarnDays;
    else delete site.sslWarnDays;
    if (domainWarnDays !== undefined) site.domainWarnDays = domainWarnDays;
    else delete site.domainWarnDays;
    // Keep ssl/domain as booleans for "enabled?" checks; warn windows live in
    // the resolved *WarnDays fields above.
    site.ssl = !!s.ssl;
    site.domain = !!s.domain;

    return site;
  });

  // Access control: embed STRUCTURE only (id/label/role/scope). Passwords + the
  // session secret are NEVER embedded — they come from Worker secrets at runtime
  // (BLIP_PW_<ID>, BLIP_SESSION_SECRET).
  const rawAccess = parsed.access ?? {};
  const principals = (Array.isArray(rawAccess.principals) ? rawAccess.principals : []).map((p) => {
    const out = { id: String(p.id), label: p.label ?? String(p.id), role: p.role ?? "VIEWER" };
    if (Array.isArray(p.groups)) out.groups = p.groups;
    if (Array.isArray(p.sites)) out.sites = p.sites;
    // Pass the password spec through verbatim: an ${ENV_VAR} reference (resolved
    // at runtime) or a literal. Absent → the BLIP_PW_<ID> secret is used.
    if (typeof p.password === "string" && p.password.length > 0) out.password = p.password;
    return out;
  });
  const access = {
    publicStatusPage: rawAccess.publicStatusPage ?? true,
    publicDashboard: rawAccess.publicDashboard ?? false,
    principals,
  };

  // Channels are embedded verbatim — secrets stay as ${ENV_VAR} refs and are
  // resolved from Worker secrets at send time (never inlined here).
  const channels = Array.isArray(parsed.channels) ? parsed.channels : [];

  const resolved = {
    brand: parsed.brand ?? {},
    defaults,
    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
    sites,
    access,
    channels,
  };

  const header = `/**
 * AUTO-GENERATED by scripts/gen-config.mjs — DO NOT EDIT.
 *
 * Resolved snapshot of ../../blip.config.yaml embedded into the Worker bundle
 * (the Worker has no filesystem at runtime). Regenerate with: npm run gen-config
 */
import type { ResolvedConfig } from "./config-types.js";

export const CONFIG = ${JSON.stringify(resolved, null, 2)} as const satisfies ResolvedConfig;
`;

  writeFileSync(OUT_PATH, header, "utf8");

  // eslint-disable-next-line no-console
  console.log(
    `gen-config: wrote ${OUT_PATH}\n` +
      `  brand: ${resolved.brand.name ?? "(unnamed)"}\n` +
      `  groups: ${resolved.groups.length}\n` +
      `  sites: ${sites.length} (${sites.map((s) => s.id).join(", ")})`,
  );
}

main();
