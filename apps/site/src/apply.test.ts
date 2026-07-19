import { describe, it, expect } from "vitest";
import { createApplyHandler, type Application } from "./apply.js";

function makeHandler() {
  const forwarded: Application[] = [];
  const handler = createApplyHandler({ forward: async (a) => { forwarded.push(a); } });
  return { handler, forwarded };
}
const post = (body: unknown) =>
  new Request("https://buildexponential.org/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const valid = { name: "Dana Ops", company: "Northwind Labs", email: "dana@northwind.co", notes: "We run on spreadsheets and want out." };

describe("apply handler", () => {
  it("accepts a valid application and forwards it to sync", async () => {
    const { handler, forwarded } = makeHandler();
    const res = await handler(post(valid));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ company: "Northwind Labs", email: "dana@northwind.co" });
  });

  it("silently drops a bot submission (honeypot filled) without forwarding", async () => {
    const { handler, forwarded } = makeHandler();
    const res = await handler(post({ ...valid, website: "http://spam.example" }));
    expect(res.status).toBe(200); // look successful to the bot
    expect(forwarded).toHaveLength(0);
  });

  it("rejects a missing company or name with 400", async () => {
    const { handler } = makeHandler();
    expect((await handler(post({ ...valid, company: "" }))).status).toBe(400);
    expect((await handler(post({ ...valid, name: undefined }))).status).toBe(400);
  });

  it("rejects an invalid email with 400", async () => {
    const { handler, forwarded } = makeHandler();
    expect((await handler(post({ ...valid, email: "not-an-email" }))).status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });

  it("only handles POST /apply", async () => {
    const { handler } = makeHandler();
    expect((await handler(new Request("https://buildexponential.org/apply"))).status).toBe(405);
    expect((await handler(new Request("https://buildexponential.org/other", { method: "POST" }))).status).toBe(404);
  });
});
