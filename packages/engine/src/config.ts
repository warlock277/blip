/**
 * Config loader for `pulse.config.yaml`.
 *
 * Pipeline:
 *   1. locate the config file (explicit `--config` path, or walk up from cwd)
 *   2. read raw YAML text and interpolate `${ENV_VAR}` references from process.env
 *   3. parse YAML → unknown
 *   4. validate against a zod schema mirroring `PulseConfig`
 *   5. apply DEFAULTS, derive site ids (slugify + de-dup), normalize options
 *
 * Throws ONLY on a genuinely invalid config (bad YAML / schema violation).
 * Missing env vars are left unresolved with a warning — they never crash.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  DEFAULTS,
  slugify,
  type ChannelConfig,
  type CheckType,
  type EngineDefaults,
  type GroupConfig,
  type PulseConfig,
  type SiteConfig,
} from "@pulse/shared";
import { log } from "./util/log.js";

const CONFIG_FILENAME = "pulse.config.yaml";

// ---------------------------------------------------------------------------
// Resolved config shape (everything required that the engine relies on)
// ---------------------------------------------------------------------------

export interface ResolvedSite extends SiteConfig {
  id: string;
  type: CheckType;
  public: boolean;
  paused: boolean;
}

export interface ResolvedConfig {
  /** The validated config, with site ids/defaults applied. */
  config: PulseConfig & { sites: ResolvedSite[]; defaults: Required<EngineDefaults> };
  /** Sites with guaranteed id/type/public/paused. */
  sites: ResolvedSite[];
  defaults: Required<EngineDefaults>;
  groups: GroupConfig[];
  channels: ChannelConfig[];
  /** Directory containing the config file. */
  configDir: string;
  /** Absolute path to the config file. */
  configPath: string;
  /** Absolute path to the `/data` directory (relative to the config file). */
  dataDir: string;
}

export interface LoadConfigOptions {
  /** Explicit config path (from `--config`). */
  configPath?: string;
  /** Override for the data directory (from `--data-dir`). */
  dataDir?: string;
  /** Starting directory for the upward search. Defaults to process.cwd(). */
  cwd?: string;
  /** Raw YAML string — bypasses file lookup (used by tests). */
  rawYaml?: string;
}

// ---------------------------------------------------------------------------
// Zod schema (mirrors the shared PulseConfig contract)
// ---------------------------------------------------------------------------

const jsonAssertionSchema = z.object({
  path: z.string(),
  equals: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  contains: z.string().optional(),
});

const sslOptionSchema = z.union([z.boolean(), z.object({ warnDays: z.number().optional() })]);
const domainOptionSchema = z.union([
  z.boolean(),
  z.object({ warnDays: z.array(z.number()).optional() }),
]);

const siteSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "site.name is required"),
  url: z.string().min(1, "site.url is required"),
  type: z.enum(["http", "ssl", "domain", "tcp"]).optional(),
  group: z.string().optional(),
  description: z.string().optional(),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).optional(),
  expectedStatus: z.union([z.number(), z.array(z.number())]).optional(),
  keyword: z.string().optional(),
  keywordAbsent: z.string().optional(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  expectJson: z.array(jsonAssertionSchema).optional(),
  followRedirects: z.boolean().optional(),
  verifyTls: z.boolean().optional(),
  timeoutMs: z.number().positive().optional(),
  degradedThresholdMs: z.number().positive().optional(),
  retries: z.number().int().nonnegative().optional(),
  paused: z.boolean().optional(),
  ssl: sslOptionSchema.optional(),
  domain: domainOptionSchema.optional(),
  port: z.number().int().positive().optional(),
  notify: z.array(z.string()).optional(),
  public: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

const groupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
});

const channelFilterFields = {
  events: z.array(z.enum(["down", "up", "degraded", "ssl", "domain"])).optional(),
  sites: z.array(z.string()).optional(),
  groups: z.array(z.string()).optional(),
  minDownMinutes: z.number().nonnegative().optional(),
};

const channelSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1),
    type: z.literal("telegram"),
    botToken: z.string(),
    chatId: z.string(),
    ...channelFilterFields,
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("email"),
    apiKey: z.string(),
    from: z.string(),
    to: z.array(z.string()),
    ...channelFilterFields,
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("discord"),
    webhookUrl: z.string(),
    ...channelFilterFields,
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("slack"),
    webhookUrl: z.string(),
    ...channelFilterFields,
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("webhook"),
    url: z.string(),
    method: z.enum(["POST", "PUT"]).optional(),
    headers: z.record(z.string()).optional(),
    ...channelFilterFields,
  }),
]);

const brandSchema = z.object({
  name: z.string().optional(),
  logoUrl: z.string().optional(),
  faviconUrl: z.string().optional(),
  primaryColor: z.string().optional(),
  tagline: z.string().optional(),
  supportUrl: z.string().optional(),
  website: z.string().optional(),
});

const defaultsSchema = z.object({
  timeoutMs: z.number().positive().optional(),
  retries: z.number().int().nonnegative().optional(),
  degradedThresholdMs: z.number().positive().optional(),
  maxHistoryPoints: z.number().int().positive().optional(),
  sslWarnDays: z.number().positive().optional(),
  domainWarnDays: z.array(z.number()).optional(),
  userAgent: z.string().optional(),
});

const configSchema = z.object({
  version: z.number().optional(),
  brand: brandSchema.optional(),
  defaults: defaultsSchema.optional(),
  groups: z.array(groupSchema).optional(),
  sites: z.array(siteSchema).min(1, "at least one site is required"),
  channels: z.array(channelSchema).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Walk upward from `start` looking for the config file. */
function findConfigFile(start: string): string | null {
  let dir = resolve(start);
  // Guard against an infinite loop at the filesystem root.
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Interpolate `${ENV_VAR}` tokens in the raw YAML text. Missing variables are
 * left verbatim (so the dashboard/secret never appears) and a single de-duped
 * warning is logged per missing name. We operate on the raw string before YAML
 * parsing so that secrets embedded anywhere (headers, tokens) are covered.
 */
export function interpolateEnv(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  const missing = new Set<string>();
  const out = raw.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, name: string) => {
    const value = env[name];
    if (value === undefined) {
      missing.add(name);
      return match; // leave unresolved
    }
    return value;
  });
  for (const name of missing) {
    log.warn(`config: env var \${${name}} is not set — left unresolved`);
  }
  return out;
}

/**
 * Interpolate `${ENV_VAR}` tokens within the string values of an already-parsed
 * config tree (objects / arrays / strings). Running after YAML parsing means
 * comments and structural syntax can never produce spurious "missing var"
 * warnings — only real config values are considered. Missing variables are left
 * verbatim with one de-duped warning each.
 */
export function interpolateEnvDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  const missing = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, name: string) => {
        const resolved = env[name];
        if (resolved === undefined) {
          missing.add(name);
          return match;
        }
        return resolved;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  const result = walk(value) as T;
  for (const name of missing) {
    log.warn(`config: env var \${${name}} is not set — left unresolved`);
  }
  return result;
}

/** Normalize ssl option to a concrete warnDays number, or undefined when disabled. */
function normalizeSslWarnDays(
  ssl: SiteConfig["ssl"],
  defaults: Required<EngineDefaults>,
): number | undefined {
  if (!ssl) return undefined;
  if (ssl === true) return defaults.sslWarnDays;
  return ssl.warnDays ?? defaults.sslWarnDays;
}

/** Normalize domain option to concrete warnDays thresholds, or undefined when disabled. */
function normalizeDomainWarnDays(
  domain: SiteConfig["domain"],
  defaults: Required<EngineDefaults>,
): number[] | undefined {
  if (!domain) return undefined;
  if (domain === true) return defaults.domainWarnDays;
  return domain.warnDays && domain.warnDays.length > 0 ? domain.warnDays : defaults.domainWarnDays;
}

/** Public accessors that surface normalized probe thresholds without re-deriving. */
export function sslWarnDaysFor(site: ResolvedSite, defaults: Required<EngineDefaults>): number | undefined {
  return normalizeSslWarnDays(site.ssl, defaults);
}
export function domainWarnDaysFor(
  site: ResolvedSite,
  defaults: Required<EngineDefaults>,
): number[] | undefined {
  return normalizeDomainWarnDays(site.domain, defaults);
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = opts.cwd ?? process.cwd();

  let raw: string;
  let configPath: string;

  if (opts.rawYaml !== undefined) {
    raw = opts.rawYaml;
    configPath = resolve(cwd, CONFIG_FILENAME);
  } else {
    const located = opts.configPath
      ? resolve(cwd, opts.configPath)
      : findConfigFile(cwd);
    if (!located || !existsSync(located)) {
      throw new Error(
        `Pulse config not found. Looked for "${CONFIG_FILENAME}" starting at ${cwd}` +
          (opts.configPath ? ` (explicit --config ${opts.configPath})` : ""),
      );
    }
    configPath = located;
    raw = await readFile(configPath, "utf8");
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`Failed to parse YAML in ${configPath}: ${(err as Error).message}`);
  }

  // Interpolate ${ENV_VAR} in string values only — after YAML parsing, so
  // comments and structural syntax never trigger false "missing var" warnings.
  const interpolated = interpolateEnvDeep(parsed);

  const result = configSchema.safeParse(interpolated);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid Pulse config (${configPath}):\n${issues}`);
  }

  const validated = result.data;

  // Apply defaults: shared DEFAULTS overlaid with any user-supplied defaults.
  const defaults: Required<EngineDefaults> = {
    ...DEFAULTS,
    ...stripUndefined(validated.defaults ?? {}),
  };

  // Derive site ids + ensure uniqueness.
  const usedIds = new Set<string>();
  const sites: ResolvedSite[] = validated.sites.map((s) => {
    let id = s.id?.trim() || slugify(s.name);
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    usedIds.add(id);
    return {
      ...s,
      id,
      type: s.type ?? "http",
      public: s.public ?? true,
      paused: s.paused ?? false,
    };
  });

  const configDir = dirname(configPath);
  const dataDir = opts.dataDir
    ? isAbsolute(opts.dataDir)
      ? opts.dataDir
      : resolve(cwd, opts.dataDir)
    : join(configDir, "data");

  const config: ResolvedConfig["config"] = {
    ...validated,
    defaults,
    sites,
  };

  return {
    config,
    sites,
    defaults,
    groups: validated.groups ?? [],
    channels: validated.channels ?? [],
    configDir,
    configPath,
    dataDir,
  };
}

/** Drop keys whose value is undefined so they don't clobber DEFAULTS via spread. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k as keyof T] = v as T[keyof T];
  }
  return out;
}
