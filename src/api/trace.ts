/**
 * Which sources a resolution consulted, and how long each took.
 *
 * The list fills `user_audit.sources` (provenance shown in the console), and the timings fill
 * `log_lookup.timings`. Not ordered: a country may ask several registers at once.
 */
export class SourceTrace {
  readonly consulted: string[] = [];
  private readonly timings: Record<string, number> = {};
  /** One start time per source: several sources can run at once. */
  private readonly startedAt = new Map<string, number>();

  /** Marks a source as consulted and starts timing it. */
  begin(source: string): void {
    this.consulted.push(source);
    this.startedAt.set(source, performance.now());
  }

  /**
   * Times something that is not a source, like the read of stored history.
   *
   * Not added to `consulted`, which is published as provenance: "stored" is not a register.
   */
  measure(label: string): void {
    this.startedAt.set(label, performance.now());
  }

  /** Closes a source opened by `begin`. */
  end(source: string): void {
    const startedAt = this.startedAt.get(source);
    // An `end` without `begin` is a bug, so it is left out of the timings.
    if (startedAt === undefined) return;
    this.timings[source] = round(performance.now() - startedAt);
  }

  /** Renames the source just closed, when what answered is only known afterwards. It stays one entry. */
  rename(to: string): void {
    const from = this.consulted.pop();
    if (from === undefined) return;
    this.consulted.push(to);
    const timing = this.timings[from];
    if (timing !== undefined) {
      delete this.timings[from];
      this.timings[to] = timing;
    }
    const startedAt = this.startedAt.get(from);
    if (startedAt !== undefined) {
      this.startedAt.delete(from);
      this.startedAt.set(to, startedAt);
    }
  }

  snapshot(): Record<string, number> {
    return this.timings;
  }
}

/** Milliseconds with one decimal. */
export function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}
