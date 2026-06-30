/**
 * Blip monitoring engine — entry point.
 *
 * Flow:
 *   1. parse CLI args (--dry-run, --config <path>, --data-dir <path>)
 *   2. load + validate config
 *   3. run every site check with bounded concurrency
 *   4. update each site's history, reconcile incidents, build the summary
 *   5. dispatch notifications for transitions
 *   6. write all data files (skipped entirely on --dry-run)
 *
 * Resilience: a single site failing must never abort the run (checks never
 * throw, and writes are best-effort with per-file try/catch). Exit code is
 * non-zero ONLY on a fatal config error.
 */

import type { CheckResult, SiteHistory } from "@blip/shared";
import { loadConfig, type ResolvedConfig } from "./config.js";
import { runSiteCheck } from "./checks/index.js";
import { mapLimit } from "./util/concurrency.js";
import { log } from "./util/log.js";
import { humanizeMs } from "./util/time.js";
import {
  appendPoint,
  pointFromResult,
  pruneDaily,
  readHistory,
  writeHistory,
} from "./store/history.js";
import { readIncidents, reconcileIncidents, writeIncidents } from "./store/incidents.js";
import { buildSummary, writeSummary } from "./store/summary.js";
import { readState, writeState } from "./store/state.js";
import { dispatch } from "./notify/index.js";
import type { NotifyContext } from "./notify/types.js";

const CHECK_CONCURRENCY = 10;

interface CliArgs {
  dryRun: boolean;
  configPath?: string;
  dataDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--config") {
      const v = argv[++i];
      if (v) args.configPath = v;
    } else if (a === "--data-dir") {
      const v = argv[++i];
      if (v) args.dataDir = v;
    } else if (a?.startsWith("--config=")) {
      args.configPath = a.slice("--config=".length);
    } else if (a?.startsWith("--data-dir=")) {
      args.dataDir = a.slice("--data-dir=".length);
    }
  }
  return args;
}

/** Pretty status cell for the dry-run table. */
function statusCell(status: string): string {
  if (status === "up") return "✅ up";
  if (status === "down") return "🔴 down";
  if (status === "degraded") return "🟡 degraded";
  return status;
}

function printDryRunTable(config: ResolvedConfig, results: Map<string, CheckResult>): void {
  const rows = config.sites.map((s) => {
    const r = results.get(s.id);
    const status = s.paused ? "paused" : r?.status ?? "?";
    const rt = r?.responseTime !== null && r?.responseTime !== undefined ? `${r.responseTime}ms` : "-";
    const note = r?.error && r.error !== "paused" ? r.error : "";
    return { name: s.name, status: s.paused ? "⏸ paused" : statusCell(status), rt, note };
  });
  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const header = `${"SITE".padEnd(nameW)}  ${"STATUS".padEnd(12)}  ${"RT".padEnd(8)}  NOTE`;
  // Dry-run table is the one thing that goes to stdout.
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log(`${r.name.padEnd(nameW)}  ${r.status.padEnd(12)}  ${r.rt.padEnd(8)}  ${r.note}`);
  }
}

async function main(): Promise<number> {
  const started = Date.now();
  const cli = parseArgs(process.argv.slice(2));

  // Fatal config errors are the ONLY thing that should set a non-zero exit.
  let config: ResolvedConfig;
  try {
    config = await loadConfig({
      ...(cli.configPath ? { configPath: cli.configPath } : {}),
      ...(cli.dataDir ? { dataDir: cli.dataDir } : {}),
    });
  } catch (err) {
    log.error(`Fatal config error: ${(err as Error).message}`);
    return 1;
  }

  const { sites, defaults, channels, dataDir } = config;
  log.info(
    `Blip engine: ${sites.length} site(s), data dir ${dataDir}${cli.dryRun ? " (dry-run)" : ""}`,
  );

  // --- 1. run all checks with bounded concurrency. runSiteCheck never throws,
  // but guard anyway so one bad site cannot abort the batch. ---
  const checkResults = await mapLimit(sites, CHECK_CONCURRENCY, async (site) => {
    try {
      return await runSiteCheck(site, defaults);
    } catch (err) {
      log.warn(`check(${site.id}) threw unexpectedly: ${(err as Error).message}`);
      const fallback: CheckResult = {
        siteId: site.id,
        status: "down",
        responseTime: null,
        checkedAt: new Date().toISOString(),
        error: `Engine error: ${(err as Error).message}`,
      };
      return fallback;
    }
  });

  const results = new Map<string, CheckResult>();
  for (const r of checkResults) results.set(r.siteId, r);

  if (cli.dryRun) {
    printDryRunTable(config, results);
  }

  // --- 2. load state + histories + incidents ---
  const state = await readState(dataDir);
  const histories = new Map<string, SiteHistory>();
  const now = Date.now();

  for (const site of sites) {
    const history = await readHistory(dataDir, site.id);
    const result = results.get(site.id);
    let updated = history;
    // Skip recording points for paused sites (they aren't really "up").
    if (result && !site.paused) {
      updated = appendPoint(history, pointFromResult(result), defaults.maxHistoryPoints);
      updated = pruneDaily(updated, 400, now);
    }
    histories.set(site.id, updated);
  }

  // --- 3. reconcile incidents (mutates state.sites for transition tracking) ---
  const prevIncidents = await readIncidents(dataDir);
  const { incidents, events } = reconcileIncidents({
    sites,
    results,
    incidents: prevIncidents,
    state,
    now,
  });

  // --- 4. build summary ---
  const summary = buildSummary({ config, results, histories, incidents, now });

  // --- 5. dispatch notifications ---
  const notifyCtx: NotifyContext = { dryRun: cli.dryRun, timeoutMs: 10_000 };
  const dispatchResult = await dispatch(events, channels, state, notifyCtx, now);

  // --- 6. write everything (skipped on dry-run) ---
  if (!cli.dryRun) {
    // Histories
    for (const [id, history] of histories) {
      try {
        await writeHistory(dataDir, history);
      } catch (err) {
        log.warn(`failed to write history for ${id}: ${(err as Error).message}`);
      }
    }
    try {
      await writeIncidents(dataDir, incidents);
    } catch (err) {
      log.warn(`failed to write incidents: ${(err as Error).message}`);
    }
    try {
      await writeSummary(dataDir, summary);
    } catch (err) {
      log.warn(`failed to write summary: ${(err as Error).message}`);
    }
    try {
      await writeState(dataDir, state);
    } catch (err) {
      log.warn(`failed to write state: ${(err as Error).message}`);
    }
  }

  // --- final summary log ---
  const { up, down, degraded, paused } = summary.totals;
  const durationMs = Date.now() - started;
  log.info(
    `Done: ${up} up / ${down} down / ${degraded} degraded / ${paused} paused — ` +
      `${events.length} event(s), ${dispatchResult.sent.filter((s) => s.ok).length} alert(s) sent in ${humanizeMs(durationMs)}`,
  );

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // Should never happen (main handles its own errors), but be safe.
    log.error(`Unexpected fatal error: ${(err as Error).message}`);
    process.exitCode = 1;
  });
