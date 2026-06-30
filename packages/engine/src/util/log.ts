/**
 * Tiny leveled logger.
 *
 * Writes to stderr so that stdout stays reserved for structured output
 * (e.g. the dry-run summary table). Level is controlled by `BLIP_LOG_LEVEL`
 * (debug | info | warn | error). Never logs secret values — callers are
 * responsible for not passing tokens/keys here.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLevel(): LogLevel {
  const raw = (process.env["BLIP_LOG_LEVEL"] ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

let currentLevel: LogLevel = resolveLevel();

/** Override the active log level (mainly for tests). */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function emit(level: LogLevel, prefix: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const line = `${new Date().toISOString()} ${prefix}`;
  // All log output goes to stderr to keep stdout clean.
  if (level === "error") {
    console.error(line, ...args);
  } else if (level === "warn") {
    console.warn(line, ...args);
  } else {
    console.error(line, ...args);
  }
}

export const log = {
  debug(...args: unknown[]): void {
    emit("debug", "[debug]", args);
  },
  info(...args: unknown[]): void {
    emit("info", "[info ]", args);
  },
  warn(...args: unknown[]): void {
    emit("warn", "[warn ]", args);
  },
  error(...args: unknown[]): void {
    emit("error", "[error]", args);
  },
};
