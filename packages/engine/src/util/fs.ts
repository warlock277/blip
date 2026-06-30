/** Filesystem helpers: JSON read/write with directory creation and atomic-ish writes. */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Ensure a directory exists (recursive, no error if present). */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Read and parse a JSON file. Returns `fallback` when the file is missing or
 * cannot be parsed (so a corrupt/absent data file never aborts a run).
 */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Write JSON to disk atomically: write to a temp file in the same directory
 * then rename over the target (rename is atomic on the same filesystem).
 * This prevents readers from ever seeing a half-written file.
 */
export async function writeJson(path: string, value: unknown, pretty = true): Promise<void> {
  await ensureDir(dirname(path));
  const body = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${body}\n`, "utf8");
  await rename(tmp, path);
}
