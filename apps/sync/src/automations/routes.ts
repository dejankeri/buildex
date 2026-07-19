// The authed drain protocol for durable automations. Every route resolves the machine token to a
// company (invariant 6) and only ever touches that company's rows. Read-only bookkeeping + lease
// mutations - no agent ever runs here (invariant 1).
import type { ScheduleStore } from "./schedule-store.js";

export interface Caller {
  companyId: string;
  machineId: string;
}

export interface AutomationRoutesDeps {
  schedules: ScheduleStore;
  /** Map a raw machine token → { companyId, machineId }, or null if unknown/revoked. */
  resolve: (token: string) => Caller | null;
  leaseMs?: number;
}

const RUN_ROUTE = /^\/api\/automations\/runs\/([A-Za-z0-9_-]+)\/(claim|report|heartbeat)$/;

export async function handleAutomationRoutes(
  deps: AutomationRoutesDeps,
  req: Request,
  url: URL,
): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith("/api/automations/")) return null;

  const token = basicPassword(req.headers.get("authorization"));
  const caller = token ? deps.resolve(token) : null;
  if (!caller) return json({ error: "unauthorized" }, 401);
  const { companyId, machineId } = caller;

  const leaseMs = deps.leaseMs ?? 30 * 60_000;

  if (req.method === "GET" && path === "/api/automations/runs") {
    const state = url.searchParams.get("state") as "due" | "claimed" | "done" | "failed" | null;
    const runs = deps.schedules.listRuns(companyId, state ?? undefined);
    return json({ runs });
  }

  const m = path.match(RUN_ROUTE);
  if (m && req.method === "POST") {
    const id = m[1]!;
    const action = m[2]!;
    // claimed_by is the non-secret machine id (never the raw token) - the control DB hashes
    // credentials at rest; a raw token in a column would leak via backups (secrets invariant).
    if (action === "claim") {
      const run = deps.schedules.claim(companyId, id, machineId, leaseMs);
      return run ? json({ run }) : json({ error: "not claimable" }, 409);
    }
    if (action === "heartbeat") {
      const run = deps.schedules.heartbeat(companyId, id, machineId, leaseMs);
      return run ? json({ run }) : json({ error: "not held" }, 409);
    }
    // report
    const b = (await safeJson(req)) as { state?: "done" | "failed"; sessionId?: string; error?: string };
    if (b.state !== "done" && b.state !== "failed") return json({ error: "state must be done|failed" }, 400);
    const run = deps.schedules.report(companyId, id, { state: b.state, sessionId: b.sessionId, error: b.error });
    return run ? json({ run }) : json({ error: "not reportable" }, 409);
  }

  return json({ error: "not found" }, 404);
}

function basicPassword(header: string | null): string | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    return idx === -1 ? null : decoded.slice(idx + 1);
  } catch {
    return null;
  }
}

async function safeJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
