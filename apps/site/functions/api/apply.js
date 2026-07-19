// Cloudflare Pages Function for POST /api/apply — the waitlist capture behind buildexponential.org.
// (Routed under /api/ so it never collides with the /apply.html → /apply page redirect Pages does.)
//
// Launch-phase backend: the hosted sync service (the eventual S2S target in src/apply.ts) isn't
// deployed yet, so submissions are stored in a KV namespace (binding: WAITLIST) as
// `application:<ts>-<uuid>`. Read them from the Cloudflare dashboard (Workers & Pages → KV → WAITLIST)
// or the API. Validation + the honeypot mirror src/apply.ts. No secrets, no external service.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }

  // Honeypot: real people never fill a hidden "website" field. Look successful, store nothing.
  if (typeof body.website === "string" && body.website.trim() !== "") return json({ ok: true });

  const name = str(body.name);
  const company = str(body.company);
  const email = str(body.email);
  const notes = str(body.notes);
  if (!name || !company || !email) return json({ error: "name, company and email are required" }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: "that email doesn't look right" }, 400);

  if (env.WAITLIST) {
    const key = `application:${Date.now()}-${crypto.randomUUID()}`;
    await env.WAITLIST.put(
      key,
      JSON.stringify({ name, company, email, notes: notes || undefined, at: new Date().toISOString() }),
    );
  }
  return json({ ok: true });
}

// Any other method on /api/apply.
export function onRequest() {
  return json({ error: "method not allowed" }, 405);
}
