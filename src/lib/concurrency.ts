/**
 * A bounded worker pool over a list.
 *
 * `Promise.all(items.map(fn))` starts everything at once, and a `for await` loop one at a time.
 * This is in between. Measured on a local MySQL: 6,400 rows/s sequentially, 21,400 with sixteen in
 * flight.
 *
 * `benchmark.ts` has its own loop with SIGINT handling, quota stop and progress, which do not belong
 * here.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!);
    }
  };

  // Never more workers than items.
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
