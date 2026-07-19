// The /apply edge function for buildexponential.org. A tiny web-standard handler:
// validate the application, drop obvious bots (a honeypot field), and forward the rest to the sync
// service over S2S - which files it into BuildEx's own team repo (dogfood: the funnel is a loop).
// `forward` is injected so the edge function is testable without the sync service.
export interface Application {
  name: string;
  company: string;
  email: string;
  notes?: string;
}

export interface ApplyDeps {
  forward: (application: Application) => Promise<void>;
}

export type Handler = (req: Request) => Promise<Response>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createApplyHandler(deps: ApplyDeps): Handler {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname !== "/apply") return json({ error: "not found" }, 404);
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid body" }, 400);
    }

    // Honeypot: real people never fill a hidden "website" field. Look successful, forward nothing.
    if (typeof body["website"] === "string" && body["website"].trim() !== "") {
      return json({ ok: true });
    }

    const name = str(body["name"]);
    const company = str(body["company"]);
    const email = str(body["email"]);
    if (!name || !company || !email) return json({ error: "name, company and email are required" }, 400);
    if (!EMAIL_RE.test(email)) return json({ error: "that email doesn't look right" }, 400);

    await deps.forward({ name, company, email, notes: str(body["notes"]) || undefined });
    return json({ ok: true });
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
