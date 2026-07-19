// Gmail connector. Read-only by construction: it only files messages under
// sources/gmail/ via the framework's guarded writeSource - it has no send capability (sending an
// email is an outward action that goes through the agent's ask-gated path, never the connector).
// The Gmail API call is injected so the connector is hermetically testable against fixtures.
import type { Connector } from "../framework.js";

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  /** ISO timestamp - also the watermark ordering key. */
  date: string;
  body: string;
  link?: string;
}

export interface GmailDeps {
  /** List messages newer than `since` (undefined = full backfill). In production this calls the
   *  Gmail API with the operator's OAuth token from the keychain; in tests it returns fixtures. */
  list: (since?: string) => Promise<GmailMessage[]>;
}

export function createGmailConnector(deps: GmailDeps): Connector {
  return {
    name: "gmail",
    auth: "oauth",
    cadence: "15m",
    filingRecipe:
      "File each email thread under sources/gmail/<threadId>.md. Keep the subject as the H1; " +
      "record sender and date; append later replies to the same thread file.",
    async sync(ctx) {
      const messages = await deps.list(ctx.watermark);
      let watermark = ctx.watermark ?? "";
      for (const m of messages) {
        const body = `# ${m.subject}\n\n- From: ${m.from}\n- Date: ${m.date}\n\n${m.body}\n`;
        ctx.writeSource(`${m.threadId}.md`, body, {
          source: "gmail",
          id: m.id,
          at: m.date,
          ...(m.link ? { link: m.link } : {}),
        });
        if (m.date > watermark) watermark = m.date;
      }
      return { watermark, wrote: messages.length };
    },
  };
}
