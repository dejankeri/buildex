// Chat session store - daemon-owned, one JSON file per session, NEVER synced.
// Each session carries metadata (folder, title, live status) so the console's left rail can group
// conversations like a projects panel. The underlying Claude session id (for --resume) is stored but
// stripped from any browser-facing read. The id must be a uuid: that is the path-traversal chokepoint.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UiEvent } from "../agent/types.js";

export type SessionStatus = "idle" | "running" | "needs-attention" | "error";

export interface SessionMeta {
  id: string;
  folder: string;
  title: string;
  status: SessionStatus;
  updatedAt: number;
  preview?: string;
}

interface SessionFile extends SessionMeta {
  events: UiEvent[];
  claudeSessionId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class FileSessionStore {
  constructor(
    private readonly baseDir: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(baseDir, { recursive: true });
  }

  create(meta?: { folder?: string; title?: string }): string {
    const id = randomUUID();
    this.write({
      id,
      folder: meta?.folder ?? "Conversations",
      title: meta?.title ?? "New chat",
      status: "idle",
      updatedAt: this.now(),
      events: [],
    });
    return id;
  }

  /** All sessions (metadata only, newest first) - for the left-rail list. A single corrupt/half-written
   *  file must never brick the whole list (never-lose-work posture): unparseable files are quarantined
   *  (skipped), not thrown, so `GET /api/sessions` keeps working. */
  list(): SessionMeta[] {
    let files: string[];
    try {
      files = readdirSync(this.baseDir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: SessionMeta[] = [];
    for (const f of files) {
      try {
        const s = JSON.parse(readFileSync(join(this.baseDir, f), "utf8")) as SessionFile;
        out.push({ id: s.id, folder: s.folder, title: s.title, status: s.status, updatedAt: s.updatedAt, ...(s.preview ? { preview: s.preview } : {}) });
      } catch {
        // Skip a corrupt file rather than failing the whole list - the other sessions still load.
        continue;
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  append(id: string, event: UiEvent): void {
    const s = this.load(id);
    s.events.push(event);
    s.updatedAt = this.now();
    if (event.kind === "text") s.preview = event.text.slice(0, 80);
    this.write(s);
  }

  setStatus(id: string, status: SessionStatus): void {
    const s = this.load(id);
    s.status = status;
    s.updatedAt = this.now();
    this.write(s);
  }

  setTitle(id: string, title: string): void {
    const s = this.load(id);
    s.title = title;
    this.write(s);
  }

  setClaudeSessionId(id: string, claudeSessionId: string): void {
    const s = this.load(id);
    s.claudeSessionId = claudeSessionId;
    this.write(s);
  }
  getClaudeSessionId(id: string): string | undefined {
    return this.load(id).claudeSessionId;
  }

  /** Browser-facing read: metadata + events, without the underlying claude session id. */
  read(id: string): SessionMeta & { events: UiEvent[] } {
    const s = this.load(id);
    return { id: s.id, folder: s.folder, title: s.title, status: s.status, updatedAt: s.updatedAt, ...(s.preview ? { preview: s.preview } : {}), events: s.events };
  }

  private load(id: string): SessionFile {
    return JSON.parse(readFileSync(this.pathFor(id), "utf8")) as SessionFile;
  }
  private write(s: SessionFile): void {
    // Atomic write: a whole-file rewrite that's interrupted (crash, power loss) must never leave a
    // half-written JSON that would then be unreadable. Write a temp sibling, then rename over the
    // target - rename is atomic on POSIX, so a reader sees either the old file or the fully new one,
    // never a truncated one. A leftover .tmp from a crash is ignored by list() (it filters *.json).
    const path = this.pathFor(s.id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, path);
  }
  private pathFor(id: string): string {
    if (!UUID_RE.test(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`);
    return join(this.baseDir, `${id}.json`);
  }
}
