#!/usr/bin/env node
/**
 * Pulse — interactive setup wizard.
 *
 * Zero external dependencies (uses only the Node standard library) so it can run
 * BEFORE `npm install`. It asks a few friendly questions and writes a valid
 * `pulse.config.yaml` at the repo root.
 *
 *   node scripts/setup.mjs       (or: npm run setup)
 *
 * Existing config is backed up to `pulse.config.yaml.bak` before overwriting.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout, exit } from "node:process";
import { existsSync } from "node:fs";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONFIG_PATH = join(ROOT, "pulse.config.yaml");
const BAK_PATH = `${CONFIG_PATH}.bak`;

// ── tiny ANSI helpers (degrade gracefully if not a TTY) ─────────────────────
const tty = stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const green = (s) => c("32", s);
const cyan = (s) => c("36", s);
const yellow = (s) => c("33", s);

const rl = createInterface({ input: stdin, output: stdout });

// Sentinel thrown when the input stream closes (Ctrl-D / closed pipe).
const EOF = Symbol("eof");

// Graceful Ctrl-C / Ctrl-D / closed stdin.
let cancelled = false;
function bail() {
  if (cancelled) return;
  cancelled = true;
  stdout.write(`\n\n${yellow("Setup cancelled — no files were changed.")}\n`);
  rl.close();
  exit(130);
}
rl.on("SIGINT", bail);
// When stdin ends, `question()` resolves with "" forever; guard against that.
let stdinEnded = false;
rl.on("close", () => {
  stdinEnded = true;
});

/** Ask one question. Throws EOF if the input stream has closed. */
async function prompt(text) {
  if (stdinEnded) throw EOF;
  const answer = await rl.question(text);
  if (stdinEnded && answer === "") throw EOF;
  return answer;
}

// ── prompt helpers ──────────────────────────────────────────────────────────
async function ask(question, fallback = "") {
  const hint = fallback ? dim(` (${fallback})`) : "";
  const answer = (await prompt(`${question}${hint}: `)).trim();
  return answer || fallback;
}

async function askRequired(question) {
  for (;;) {
    const answer = (await prompt(`${question}: `)).trim();
    if (answer) return answer;
    stdout.write(yellow("  ↳ this one is required.\n"));
  }
}

async function confirm(question, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await prompt(`${question} ${dim(`(${hint})`)} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

// Mirror of the engine's slugify (packages/shared/src/constants.ts) so ids match.
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

// Quote a YAML scalar only when needed; always quote when it contains specials.
function yamlStr(value) {
  if (value === "") return '""';
  if (/^[A-Za-z0-9 ._/-]+$/.test(value) && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ── wizard ───────────────────────────────────────────────────────────────────
async function main() {
  stdout.write(`\n${bold(green("⚡ Pulse setup"))}\n`);
  stdout.write(dim("Let's build your pulse.config.yaml. Press Ctrl-C any time to abort.\n\n"));

  // 1) Branding
  stdout.write(bold("1) Branding\n"));
  const brandName = await ask("  Brand name", "Pulse");
  const tagline = await ask("  Tagline", "Real-time status for everything we run.");
  const primaryColor = await ask("  Primary color (hex)", "#22c55e");

  // 2) Sites
  stdout.write(`\n${bold("2) Sites to monitor")}\n`);
  stdout.write(dim("  Add at least one. Leave the name blank to finish.\n"));
  const sites = [];
  for (;;) {
    const idx = sites.length + 1;
    const name = await ask(`  Site #${idx} name`, "");
    if (!name) {
      if (sites.length === 0) {
        stdout.write(yellow("  ↳ you need at least one site.\n"));
        continue;
      }
      break;
    }
    const url = await askRequired("  URL (or host:port for TCP)");
    const group = await ask("  Group/tenant id (optional)", "");
    const ssl = await confirm("  Watch SSL certificate expiry?", true);
    const domain = await confirm("  Watch domain registration expiry?", false);
    const isPublic = await confirm("  Show on the public status page?", true);
    sites.push({ name, url, group, ssl, domain, public: isPublic });
    stdout.write(green(`  ✓ added "${name}" (id: ${slugify(name)})\n\n`));
  }

  // Collect distinct groups for the groups: block.
  const groupIds = [...new Set(sites.map((s) => s.group).filter(Boolean))];

  // 3) Notification channels
  stdout.write(`\n${bold("3) Notification channels")}\n`);
  stdout.write(dim("  Enable the ones you want. Tokens go in GitHub secrets later — not here.\n"));
  const channels = [];
  const secretsNeeded = new Set();

  if (await confirm("  Enable Telegram alerts?", false)) {
    channels.push({ kind: "telegram" });
    secretsNeeded.add("TELEGRAM_BOT_TOKEN").add("TELEGRAM_CHAT_ID");
  }
  if (await confirm("  Enable Email alerts (Resend)?", false)) {
    const from = await ask("    From address", "Pulse <alerts@example.com>");
    const to = await ask("    To address(es), comma-separated", "ops@example.com");
    channels.push({ kind: "email", from, to: to.split(",").map((s) => s.trim()).filter(Boolean) });
    secretsNeeded.add("RESEND_API_KEY");
  }
  if (await confirm("  Enable Discord alerts?", false)) {
    channels.push({ kind: "discord" });
    secretsNeeded.add("DISCORD_WEBHOOK_URL");
  }
  if (await confirm("  Enable Slack alerts?", false)) {
    channels.push({ kind: "slack" });
    secretsNeeded.add("SLACK_WEBHOOK_URL");
  }
  if (await confirm("  Enable a generic webhook?", false)) {
    channels.push({ kind: "webhook" });
    secretsNeeded.add("PAGER_WEBHOOK_URL");
  }

  // ── emit YAML ──
  const yaml = renderConfig({ brandName, tagline, primaryColor, groupIds, sites, channels });

  if (existsSync(CONFIG_PATH)) {
    await copyFile(CONFIG_PATH, BAK_PATH);
    stdout.write(dim(`\n  Backed up existing config → ${BAK_PATH}\n`));
  }
  await writeFile(CONFIG_PATH, yaml, "utf8");

  // ── next steps ──
  stdout.write(`\n${bold(green("✓ Wrote pulse.config.yaml"))}\n\n`);
  stdout.write(`${bold("Next steps:")}\n`);
  stdout.write(`  ${cyan("1.")} npm install\n`);
  stdout.write(`  ${cyan("2.")} npm run seed     ${dim("# generate demo data")}\n`);
  stdout.write(`  ${cyan("3.")} npm run dev      ${dim("# preview the dashboard at http://localhost:5173")}\n`);

  if (secretsNeeded.size > 0) {
    stdout.write(`\n${bold("GitHub secrets to add")} ${dim("(Settings → Secrets and variables → Actions):")}\n`);
    for (const s of secretsNeeded) stdout.write(`  • ${yellow(s)}\n`);
    stdout.write(dim("  (docs/notifications.md explains how to obtain each value.)\n"));
  } else {
    stdout.write(`\n${dim("  No notification channels enabled — you can add them later in pulse.config.yaml.")}\n`);
  }

  stdout.write(`\n${bold("Deploy:")} push to GitHub, enable Actions, and connect Cloudflare Pages.\n`);
  stdout.write(dim("  Full guide: docs/deployment.md\n\n"));

  rl.close();
}

function renderConfig({ brandName, tagline, primaryColor, groupIds, sites, channels }) {
  const L = [];
  L.push("# Generated by `npm run setup`. Edit freely; see docs/configuration.md.");
  L.push("# Secrets are referenced as ${ENV_VAR} and supplied via GitHub Actions secrets.");
  L.push("");
  L.push("version: 1");
  L.push("");
  L.push("brand:");
  L.push(`  name: ${yamlStr(brandName)}`);
  L.push(`  tagline: ${yamlStr(tagline)}`);
  L.push(`  primaryColor: ${yamlStr(primaryColor)}`);
  L.push("");
  L.push("defaults:");
  L.push("  timeoutMs: 10000");
  L.push("  retries: 2");
  L.push("  degradedThresholdMs: 2000");
  L.push("  sslWarnDays: 30");
  L.push("  domainWarnDays: [30, 15, 7]");
  L.push("");

  if (groupIds.length > 0) {
    L.push("groups:");
    for (const id of groupIds) {
      L.push(`  - id: ${yamlStr(id)}`);
      L.push(`    name: ${yamlStr(id)}`);
    }
    L.push("");
  }

  L.push("sites:");
  for (const s of sites) {
    L.push(`  - name: ${yamlStr(s.name)}`);
    L.push(`    url: ${yamlStr(s.url)}`);
    if (s.group) L.push(`    group: ${yamlStr(s.group)}`);
    if (s.ssl) L.push("    ssl: true");
    if (s.domain) L.push("    domain: true");
    L.push(`    public: ${s.public ? "true" : "false"}`);
  }
  L.push("");

  if (channels.length > 0) {
    L.push("channels:");
    for (const ch of channels) {
      switch (ch.kind) {
        case "telegram":
          L.push("  - id: telegram-main");
          L.push("    type: telegram");
          L.push("    botToken: ${TELEGRAM_BOT_TOKEN}");
          L.push("    chatId: ${TELEGRAM_CHAT_ID}");
          L.push("    events: [down, up, ssl, domain]");
          break;
        case "email":
          L.push("  - id: email-ops");
          L.push("    type: email");
          L.push("    apiKey: ${RESEND_API_KEY}");
          L.push(`    from: ${yamlStr(ch.from)}`);
          L.push(`    to: [${ch.to.map(yamlStr).join(", ")}]`);
          L.push("    events: [down, up, ssl, domain]");
          break;
        case "discord":
          L.push("  - id: discord-eng");
          L.push("    type: discord");
          L.push("    webhookUrl: ${DISCORD_WEBHOOK_URL}");
          L.push("    events: [down, up, degraded]");
          break;
        case "slack":
          L.push("  - id: slack-incidents");
          L.push("    type: slack");
          L.push("    webhookUrl: ${SLACK_WEBHOOK_URL}");
          L.push("    events: [down, up]");
          break;
        case "webhook":
          L.push("  - id: webhook-generic");
          L.push("    type: webhook");
          L.push("    url: ${PAGER_WEBHOOK_URL}");
          L.push("    method: POST");
          L.push("    events: [down]");
          break;
      }
    }
    L.push("");
  }

  return L.join("\n");
}

main().catch((err) => {
  if (cancelled) return;
  if (err === EOF) {
    bail();
    return;
  }
  stdout.write(`\n${yellow("Setup failed:")} ${err?.message ?? err}\n`);
  rl.close();
  exit(1);
});
