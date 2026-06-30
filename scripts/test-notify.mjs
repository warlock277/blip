#!/usr/bin/env node
/**
 * Blip — send a TEST notification to Telegram and/or Slack.
 *
 *   1. Put the values in .env (gitignored):
 *        TELEGRAM_BOT_TOKEN=123:ABC
 *        TELEGRAM_CHAT_ID=-1001234567890
 *        SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
 *   2. node scripts/test-notify.mjs        (or: npm run test:notify)
 *
 * Mirrors the exact payloads the engine/worker use, so a success here means the
 * channel is correctly configured. Reads only from process.env + .env; no deps.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Tiny .env loader (KEY=VALUE per line; ignores comments/blank; no quotes magic).
function loadEnv() {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

const MESSAGE =
  "✅ Blip test notification\n\n" +
  "If you can read this, this channel is correctly wired up. " +
  "Real alerts fire on up/down/SSL/domain events for your monitored sites.";

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function testTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log(dim("• Telegram  — skipped (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)"));
    return;
  }
  const r = await post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: MESSAGE,
    disable_web_page_preview: true,
  });
  // Telegram returns { ok: true, ... } even with HTTP 200; surface its body on failure.
  if (r.ok && /"ok":true/.test(r.text)) console.log(green("✓ Telegram  — sent"));
  else console.log(red(`✗ Telegram  — failed (HTTP ${r.status}): ${r.text.slice(0, 200)}`));
}

async function testSlack() {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.log(dim("• Slack     — skipped (set SLACK_WEBHOOK_URL)"));
    return;
  }
  const r = await post(url, { text: MESSAGE });
  // Slack webhooks reply with the literal "ok" body on success.
  if (r.ok && r.text.trim() === "ok") console.log(green("✓ Slack     — sent"));
  else console.log(red(`✗ Slack     — failed (HTTP ${r.status}): ${r.text.slice(0, 200)}`));
}

console.log("\nSending Blip test notifications…\n");
await Promise.all([testTelegram(), testSlack()]);
console.log("");
