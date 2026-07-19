// The client drain loop for durable automations. It pulls due runs from the sync worker, claims each
// via the atomic lease, and runs the verb LOCALLY through the same driver→gate executor the manual
// path uses (invariant 5). The in-flight guard (shared `running` Set) prevents overlap with a manual
// "Run now"; the server-side lease prevents another machine running the same job.
export interface DrainSource {
  listDue(): Promise<{ id: string; verb: string }[]>;
  claim(id: string): Promise<{ id: string; verb: string } | null>;
  report(id: string, r: { state: "done" | "failed"; sessionId?: string; error?: string }): Promise<void>;
  /** Optional lease keepalive for long-running verbs; when absent no heartbeat is sent (the server
   *  lease TTL is the only backstop, and a healthy-but-slow run risks being reaped mid-run). */
  heartbeat?(id: string): Promise<void>;
}

export interface DrainDeps {
  source: DrainSource;
  runVerb: (verb: string) => Promise<{ sessionId: string }>;
  running: Set<string>;
  onError?: (e: unknown) => void;
  /** Heartbeat interval while a claimed run executes. Defaults to 4 minutes. */
  heartbeatMs?: number;
}

export async function drainOnce(deps: DrainDeps): Promise<{ ran: string[] }> {
  const ran: string[] = [];
  let due: { id: string; verb: string }[];
  try {
    due = await deps.source.listDue();
  } catch (e) {
    deps.onError?.(e);
    return { ran };
  }
  for (const item of due) {
    if (deps.running.has(item.verb)) continue; // a manual run (or another drain) is already running it
    let claimed: { id: string; verb: string } | null = null;
    try {
      claimed = await deps.source.claim(item.id);
    } catch (e) {
      deps.onError?.(e);
      continue;
    }
    if (!claimed) continue; // lost the race to another machine
    deps.running.add(claimed.verb);
    // Keep a healthy long run's lease alive so a slow verb isn't reaped out from under it (the
    // server also tolerates a late report against a reaped run, but the heartbeat avoids the
    // reap - and the retry/failure bookkeeping it causes - in the common case).
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    if (deps.source.heartbeat) {
      heartbeatTimer = setInterval(() => {
        void deps.source.heartbeat!(claimed!.id).catch(() => {});
      }, deps.heartbeatMs ?? 4 * 60_000);
      heartbeatTimer.unref?.();
    }
    try {
      const { sessionId } = await deps.runVerb(claimed.verb);
      await deps.source.report(claimed.id, { state: "done", sessionId });
      ran.push(claimed.id);
    } catch (e) {
      try {
        await deps.source.report(claimed.id, { state: "failed", error: e instanceof Error ? e.message : String(e) });
      } catch (re) {
        deps.onError?.(re);
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      deps.running.delete(claimed.verb);
    }
  }
  return { ran };
}
