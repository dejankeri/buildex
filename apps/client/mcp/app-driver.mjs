#!/usr/bin/env node
// Local app-driver MCP. A stdio JSON-RPC shim exposing list_apps / open_app / read_app /
// click / fill — each forwards to the daemon's app-bus over loopback. It holds no credentials and
// no network beyond 127.0.0.1; the daemon relays commands to the open app window.
import { createInterface } from "node:readline";

const PORT = process.env.BUILDEX_DAEMON_PORT || "4317";
const BASE = `http://127.0.0.1:${PORT}`;

const TOOLS = [
  { name: "list_apps", description: "List installed apps.", inputSchema: { type: "object", properties: {} } },
  { name: "open_app", description: "Open an app by name in the console.", inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] } },
  { name: "read_app", description: "Read text/state from the open app (optional CSS selector).", inputSchema: { type: "object", properties: { app: { type: "string" }, selector: { type: "string" } } } },
  { name: "click", description: "Click an element in the open app.", inputSchema: { type: "object", properties: { app: { type: "string" }, selector: { type: "string" } }, required: ["selector"] } },
  { name: "fill", description: "Fill an input in the open app.", inputSchema: { type: "object", properties: { app: { type: "string" }, selector: { type: "string" }, value: { type: "string" } }, required: ["selector", "value"] } },
];

async function control(op, args) {
  if (op === "list_apps") {
    const r = await fetch(`${BASE}/api/apps`);
    return await r.json();
  }
  const command = { app: args.app || "", op: op === "open_app" ? "open" : op === "read_app" ? "read" : op, selector: args.selector, value: args.value };
  const r = await fetch(`${BASE}/api/app-control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
  return await r.json();
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  const fail = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } }) + "\n");
  try {
    if (msg.method === "initialize") return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "buildex-app-driver", version: "0.1.0" } });
    if (msg.method === "tools/list") return reply({ tools: TOOLS });
    if (msg.method === "tools/call") {
      const out = await control(msg.params.name, msg.params.arguments || {});
      return reply({ content: [{ type: "text", text: JSON.stringify(out) }] });
    }
    if (msg.method === "notifications/initialized") return; // no reply for notifications
    return fail(`unknown method: ${msg.method}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
});
