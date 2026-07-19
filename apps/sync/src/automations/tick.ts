// The durable automation tick - the cloud's clock. It reads each company's automations.yaml from
// its team bare repo, reconciles it into the ScheduleStore, creates due-runs, and reaps expired
// leases. It is pure bookkeeping over repo/DB state - it NEVER spawns an agent (invariant 1).
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ScheduleStore, type ScheduleDef, type Cadence, type CatchUp } from "./schedule-store.js";

export type DefReader = (companyId: string) => string | null;

export interface TickDeps {
  store: ScheduleStore;
  readDefs: DefReader;
  companies: () => string[];
  backlogCap?: number;
  maxAttempts?: number;
}

export function tickOnce(deps: TickDeps): { created: number; requeued: number; failed: number } {
  let created = 0;
  let requeued = 0;
  let failed = 0;
  for (const companyId of deps.companies()) {
    const text = deps.readDefs(companyId);
    const defs = text ? parseAutomationsYaml(text) : [];
    deps.store.reconcile(companyId, defs);
    created += deps.store.createDueRuns(companyId, { backlogCap: deps.backlogCap ?? 24 }).length;
    const reaped = deps.store.reap(companyId, { maxAttempts: deps.maxAttempts ?? 3 });
    requeued += reaped.requeued;
    failed += reaped.failed;
  }
  return { created, requeued, failed };
}

/** Production reader: `git -C <reposRoot>/<team>.git show HEAD:automations.yaml`. Missing file → null. */
export function gitDefReader(reposRoot: string, teamRepoName: (companyId: string) => string): DefReader {
  return (companyId: string) => {
    const dir = join(reposRoot, `${teamRepoName(companyId)}.git`);
    try {
      return execFileSync("git", ["-C", dir, "show", "HEAD:automations.yaml"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null; // no such repo / no such file / empty repo - nothing scheduled
    }
  };
}

// A local mirror of the client's automations.yaml reader (apps/client/src/brain/automations.ts).
// Duplicated deliberately to keep apps/sync independent of apps/client; the two formats must stay
// in step (both are trivial "- key: value" lists - no js-yaml dependency).
const CADENCES: Cadence[] = ["hourly", "daily", "weekly"];
const NAME_RE = /^[a-z][a-z0-9-]*$/;

export function parseAutomationsYaml(text: string): ScheduleDef[] {
  const out: ScheduleDef[] = [];
  let cur: Record<string, string> | null = null;
  const flush = () => {
    if (!cur) return;
    const name = cur["name"];
    const verb = cur["verb"];
    const cadence = cur["cadence"] as Cadence;
    if (name && NAME_RE.test(name) && verb && CADENCES.includes(cadence)) {
      out.push({
        name,
        verb,
        cadence,
        enabled: cur["enabled"] !== "false",
        catchUp: (cur["catchUp"] === "each" ? "each" : "coalesce") as CatchUp,
      });
    }
    cur = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const item = line.match(/^-\s+(\w+):\s*(.*)$/);
    if (item) {
      flush();
      cur = {};
      cur[item[1]!] = strip(item[2]!);
      continue;
    }
    const kv = line.match(/^\s+(\w+):\s*(.*)$/);
    if (kv && cur) cur[kv[1]!] = strip(kv[2]!);
  }
  flush();
  return out;
}
function strip(v: string): string {
  return v.trim().replace(/^["'](.*)["']$/, "$1");
}
