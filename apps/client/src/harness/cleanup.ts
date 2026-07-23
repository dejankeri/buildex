// Interrupt-safety foundation for the proof composition (next module): a stack of teardown steps
// (destroy the provider workspace, remove local scratch, etc.) that runs to completion on both
// SIGINT and normal completion, in reverse registration order, without letting one step's failure
// strand the rest. No process/signal wiring here - the CLI shell owns catching SIGINT and calling
// runAll(); this module only owns the LIFO bookkeeping.

interface CleanupEntry {
  label: string;
  fn: () => Promise<void> | void;
  ran: boolean;
}

export class CleanupRegistry {
  private readonly entries: CleanupEntry[] = [];

  /** Register a teardown step. Order matters: runAll unwinds LIFO, so the most recently acquired
   *  resource (e.g. a minted sandbox) is torn down first, mirroring acquisition order. */
  push(label: string, fn: () => Promise<void> | void): void {
    this.entries.push({ label, fn, ran: false });
  }

  /** Run every not-yet-run entry, most recently pushed first, awaiting each before starting the
   *  next (so ordering holds even across async gaps). A throwing/rejecting entry is caught, marked
   *  ran anyway (never retried - "at most once ever"), and reported via `log` if given; it never
   *  stops the remaining entries and is never rethrown. Entries pushed while runAll() is in flight
   *  are deferred to the next runAll() call — register teardown steps up front. Safe to call
   *  twice: a second call only finds entries that were never reached the first time. Returns the
   *  labels of the entries THIS call found failing (empty when everything in this call succeeded),
   *  so a caller who needs to react to a specific teardown's failure (proof.ts, for the minted
   *  sandbox) can - without runAll itself ever throwing. */
  async runAll(log?: (line: string) => void): Promise<string[]> {
    const failed: string[] = [];
    for (const entry of [...this.entries].reverse()) {
      if (entry.ran) continue;
      entry.ran = true;
      try {
        await entry.fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log?.(`cleanup '${entry.label}' failed: ${message}`);
        failed.push(entry.label);
      }
    }
    return failed;
  }
}
