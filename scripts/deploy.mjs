#!/usr/bin/env node
/**
 * Blip — one-command Cloudflare bootstrap + deploy.
 *
 *   npm run deploy:cloud
 *   npm run deploy:cloud -- --host status.yourdomain.com
 *
 * Does everything the manual deploy does, in order, idempotently:
 *   1. checks you're logged in to Cloudflare (`wrangler whoami`)
 *   2. creates the D1 database (if needed) and writes its id into wrangler.toml
 *   3. applies the schema to the remote DB
 *   4. sets the custom-domain route in wrangler.toml
 *   5. sets the secrets your config needs (auto-generates BLIP_SESSION_SECRET,
 *      auto-detects every ${ENV_VAR} referenced in blip.config.yaml, prompts for
 *      any that aren't set yet)
 *   6. deploys the Worker
 *
 * Zero external deps (Node stdlib only). Wrangler is invoked from packages/worker.
 */

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, exit, argv } from "node:process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WORKER_DIR = join(ROOT, "packages", "worker");
const WRANGLER_TOML = join(WORKER_DIR, "wrangler.toml");
const CONFIG_PATH = join(ROOT, "blip.config.yaml");
const DB_NAME = "blip-db";

const tty = stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const red = (s) => c("31", s);
const step = (n, s) => stdout.write(`\n${bold(green(`[${n}]`))} ${bold(s)}\n`);

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q, fallback = "") => {
  const a = (await rl.question(`${q}${fallback ? dim(` (${fallback})`) : ""}: `)).trim();
  return a || fallback;
};
const die = (msg) => {
  stdout.write(`\n${red("✗")} ${msg}\n`);
  rl.close();
  exit(1);
};

/** Run wrangler in packages/worker, inheriting stdio. Returns exit code. */
function wrangler(args, { capture = false } = {}) {
  const res = spawnSync("npx", ["wrangler", ...args], {
    cwd: WORKER_DIR,
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    shell: false,
  });
  if (capture) return res;
  if (res.status !== 0) die(`wrangler ${args.join(" ")} failed (exit ${res.status}).`);
  return res;
}

/** Pipe a secret value into `wrangler secret put NAME` via stdin (never on argv). */
function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", "secret", "put", name], {
      cwd: WORKER_DIR,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`secret put ${name} exited ${code}`))));
    child.stdin.write(value);
    child.stdin.end();
  });
}

function getArg(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}

/**
 * Which secrets does a deploy need, given the config text?
 *   - BLIP_SESSION_SECRET (always, auto-generated)
 *   - every ${ENV_VAR} referenced anywhere in the config
 *   - BLIP_PW_<ID> for each access principal with no inline `password:`
 * Pure + exported so it can be unit-checked without touching the network.
 */
export function detectSecrets(config) {
  const needed = new Map(); // name -> { hint, generate? }
  needed.set("BLIP_SESSION_SECRET", { hint: "cookie signing key", generate: true });
  for (const m of config.matchAll(/\$\{([A-Z0-9_]+)\}/g)) {
    needed.set(m[1], { hint: "from blip.config.yaml" });
  }
  for (const m of config.matchAll(/- id:\s*([A-Za-z0-9_-]+)\s*\n(?:(?!- id:)[\s\S])*?role:/g)) {
    if (!/password:/.test(m[0])) {
      const pw = `BLIP_PW_${m[1].toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
      needed.set(pw, { hint: `password for principal "${m[1]}"` });
    }
  }
  return needed;
}

// `node scripts/deploy.mjs --selfcheck` — verifies secret detection, no network.
if (argv.includes("--selfcheck")) {
  const assert = (await import("node:assert/strict")).default;
  const sample = `
access:
  principals:
    - id: admin
      label: Admin
      role: ADMIN
      password: \${BLIP_PW_ADMIN}
    - id: acme-client
      label: Acme
      role: CLIENT
channels:
  - id: slack
    webhookUrl: \${SLACK_WEBHOOK_URL}
`;
  const got = detectSecrets(sample);
  // ${ENV_VAR} refs are captured…
  assert.ok(got.has("BLIP_PW_ADMIN"), "explicit ${BLIP_PW_ADMIN} ref");
  assert.ok(got.has("SLACK_WEBHOOK_URL"), "channel webhook ref");
  // …a principal WITHOUT an inline password gets a derived BLIP_PW_<ID>…
  assert.ok(got.has("BLIP_PW_ACME_CLIENT"), "derived pw for password-less principal");
  // …and the session key is always present and marked for generation.
  assert.equal(got.get("BLIP_SESSION_SECRET").generate, true);
  stdout.write("deploy.mjs selfcheck: ok\n");
  exit(0);
}

async function main() {
  stdout.write(`\n${bold(green("⚡ Blip — deploy to Cloudflare"))}\n`);
  if (!existsSync(CONFIG_PATH)) die("No blip.config.yaml — run `npm run setup` first.");
  let toml = readFileSync(WRANGLER_TOML, "utf8");
  const config = readFileSync(CONFIG_PATH, "utf8");

  // 1) Auth ------------------------------------------------------------------
  step(1, "Checking Cloudflare login");
  const who = wrangler(["whoami"], { capture: true });
  if (who.status !== 0 || /not authenticated|run .*login/i.test(`${who.stdout}${who.stderr}`)) {
    die("Not logged in. Run `npx wrangler login` (opens a browser), then re-run this.");
  }
  stdout.write(green("  ✓ logged in\n"));

  // 2) D1 database -----------------------------------------------------------
  step(2, "D1 database");
  const idMatch = toml.match(/database_id\s*=\s*"([^"]*)"/);
  const currentId = idMatch?.[1] ?? "";
  if (!currentId || currentId === "PLACEHOLDER_SET_AT_DEPLOY") {
    stdout.write(dim(`  creating D1 database "${DB_NAME}"…\n`));
    const out = wrangler(["d1", "create", DB_NAME], { capture: true });
    const blob = `${out.stdout}${out.stderr}`;
    if (out.status !== 0 && !/already exists/i.test(blob)) die(`d1 create failed:\n${blob}`);
    // Parse the id from create output, or list to find an existing one.
    let id = blob.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i)?.[1] || blob.match(/\b([0-9a-f]{8}-[0-9a-f-]{27})\b/i)?.[1];
    if (!id) {
      const list = wrangler(["d1", "list", "--json"], { capture: true });
      try {
        id = JSON.parse(list.stdout).find((d) => d.name === DB_NAME)?.uuid;
      } catch { /* fall through */ }
    }
    if (!id) die("Created the DB but couldn't read its id. Paste it into wrangler.toml manually.");
    toml = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${id}"`);
    writeFileSync(WRANGLER_TOML, toml);
    stdout.write(green(`  ✓ database_id ${id} written to wrangler.toml\n`));
  } else {
    stdout.write(green(`  ✓ using existing database_id ${currentId}\n`));
  }

  // 3) Schema ----------------------------------------------------------------
  step(3, "Applying schema (remote)");
  wrangler(["d1", "execute", DB_NAME, "--remote", "--file=schema.sql", "-y"]);
  stdout.write(green("  ✓ schema applied (idempotent)\n"));

  // 4) Route -----------------------------------------------------------------
  step(4, "Custom domain");
  const currentHost = toml.match(/pattern\s*=\s*"([^"]*)"/)?.[1] ?? "";
  let host = getArg("--host");
  if (!host) {
    const suggestion = currentHost && currentHost !== "status.example.com" ? currentHost : "";
    host = await ask("  Hostname to serve Blip on (must be a Cloudflare zone)", suggestion);
  }
  if (!host) die("A hostname is required (e.g. status.yourdomain.com).");
  toml = toml.replace(/pattern\s*=\s*"[^"]*"/, `pattern = "${host}"`);
  writeFileSync(WRANGLER_TOML, toml);
  stdout.write(green(`  ✓ route set to ${host}\n`));

  // 5) Secrets ---------------------------------------------------------------
  step(5, "Secrets");
  // What does the deploy need? (session key + ${ENV_VAR} refs + per-principal pw)
  const needed = detectSecrets(config);

  const existing = new Set();
  try {
    const list = wrangler(["secret", "list"], { capture: true });
    for (const s of JSON.parse(list.stdout)) existing.add(s.name);
  } catch { /* no secrets yet */ }

  for (const [name, meta] of needed) {
    if (existing.has(name)) {
      stdout.write(dim(`  • ${name} — already set, skipping\n`));
      continue;
    }
    if (meta.generate) {
      const value = randomBytes(32).toString("base64url");
      await putSecret(name, value);
      stdout.write(green(`  ✓ ${name} — generated & set\n`));
      continue;
    }
    const value = await ask(`  Set ${yellow(name)} ${dim(`(${meta.hint})`)} — paste value, or blank to skip`);
    if (!value) {
      stdout.write(dim(`    skipped (channel/login using it won't work until set)\n`));
      continue;
    }
    await putSecret(name, value);
    stdout.write(green(`  ✓ ${name} — set\n`));
  }

  // 6) Build the dashboard, then deploy --------------------------------------
  // The Worker bundles ../dashboard/dist as static assets, so it MUST be freshly
  // built or you ship stale UI. (This is separate from `wrangler deploy`.)
  step(6, "Building the dashboard");
  rl.close();
  const built = spawnSync("npm", ["run", "build", "--workspace", "@blip/dashboard"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (built.status !== 0) die("Dashboard build failed — see output above.");

  step(7, "Deploying the Worker");
  const dep = spawnSync("npm", ["run", "deploy"], { cwd: WORKER_DIR, stdio: "inherit" });
  if (dep.status !== 0) die("Deploy failed — see wrangler output above.");

  stdout.write(`\n${bold(green("✓ Live!"))}  ${bold(`https://${host}`)}\n`);
  stdout.write(dim(`  The first cron tick (≤5 min) fills in the data. Check https://${host}/data/summary.json\n`));
  stdout.write(dim(`  Log in at https://${host} with the admin password you set above.\n\n`));
}

main().catch((err) => die(err?.message ?? String(err)));
