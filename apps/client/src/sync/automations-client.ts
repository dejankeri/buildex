// The client side of the durable-automation drain protocol. The daemon uses this to pull due runs
// from the always-on sync worker, claim them (atomic lease), and report completion. Auth mirrors
// git smart-HTTP: the machine token rides as the HTTP Basic password.
export type FetchLike = typeof fetch;

export interface DueRun {
  id: string;
  scheduleName: string;
  verb: string;
  dueAt: number;
}

export interface AutomationsClientOpts {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
}

export class AutomationsClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetch: FetchLike;
  constructor(opts: AutomationsClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.authHeader = "Basic " + Buffer.from(`x:${opts.token}`).toString("base64");
    this.fetch = opts.fetch ?? fetch;
  }

  async listDue(): Promise<DueRun[]> {
    const res = await this.fetch(`${this.baseUrl}/api/automations/runs?state=due`, {
      headers: { authorization: this.authHeader },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { runs?: DueRun[] };
    return (body.runs ?? []).map((r) => ({ id: r.id, scheduleName: r.scheduleName, verb: r.verb, dueAt: r.dueAt }));
  }

  async claim(id: string): Promise<DueRun | null> {
    const res = await this.post(`/api/automations/runs/${id}/claim`);
    if (res.status === 200) {
      const body = (await res.json()) as { run: DueRun };
      return body.run;
    }
    return null;
  }

  async report(id: string, r: { state: "done" | "failed"; sessionId?: string; error?: string }): Promise<void> {
    await this.post(`/api/automations/runs/${id}/report`, r);
  }

  async heartbeat(id: string): Promise<void> {
    await this.post(`/api/automations/runs/${id}/heartbeat`);
  }

  private post(path: string, body?: unknown): Promise<Response> {
    return this.fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: this.authHeader,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
}
