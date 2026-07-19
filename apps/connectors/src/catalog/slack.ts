// Slack connector. Read-only by construction - files channel messages under
// sources/slack/; no send (posting to Slack is an outward action through the agent's gated path).
import type { Connector } from "../framework.js";

export interface SlackMessage {
  id: string;
  channel: string;
  user: string;
  text: string;
  /** ISO timestamp - watermark ordering key. */
  ts: string;
}

export interface SlackDeps {
  list: (since?: string) => Promise<SlackMessage[]>;
}

export function createSlackConnector(deps: SlackDeps): Connector {
  return {
    name: "slack",
    auth: "oauth",
    cadence: "10m",
    filingRecipe:
      "File messages under sources/slack/<channel>.md, appended in time order; keep the channel " +
      "name as the H1 and prefix each line with the sender.",
    async sync(ctx) {
      const messages = await deps.list(ctx.watermark);
      // Group by channel so each channel is one appended-to file.
      const byChannel = new Map<string, SlackMessage[]>();
      let watermark = ctx.watermark ?? "";
      for (const m of messages) {
        (byChannel.get(m.channel) ?? byChannel.set(m.channel, []).get(m.channel)!).push(m);
        if (m.ts > watermark) watermark = m.ts;
      }
      for (const [channel, msgs] of byChannel) {
        const body =
          `# #${channel}\n\n` + msgs.map((m) => `- **${m.user}** (${m.ts}): ${m.text}`).join("\n") + "\n";
        const first = msgs[0]!;
        ctx.writeSource(`${channel}.md`, body, { source: "slack", id: first.id, at: first.ts });
      }
      return { watermark, wrote: byChannel.size };
    },
  };
}
