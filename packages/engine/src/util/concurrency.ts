/** Run an array of async tasks with a bounded concurrency limit. */

/**
 * Map `items` through `worker` running at most `limit` tasks at once.
 * Results preserve input order. A rejecting worker rejects the whole call,
 * so callers that must not abort should make `worker` itself never throw.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const max = Math.max(1, Math.min(limit, items.length || 1));
  let next = 0;

  async function run(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await worker(item, index);
    }
  }

  const runners: Promise<void>[] = [];
  for (let i = 0; i < max; i++) runners.push(run());
  await Promise.all(runners);
  return results;
}
