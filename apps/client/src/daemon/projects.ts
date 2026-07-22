// Project store - daemon-owned, one local JSON file, NEVER synced. A project is a task container
// (the console's left rail): a named group holding a mix of tabs - chats, open
// browsers, docs, the map - so an operator keeps everything for one task in one place and can leave
// and return to it. Chats live in the session store; a project references them by id.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ItemType = "chat" | "browser" | "doc" | "map" | "app";

export interface ProjectItem {
  type: ItemType;
  /** chat → the session id; browser → the url; doc → the brain path; app → repo+name. */
  sessionId?: string;
  url?: string;
  path?: string;
  title?: string;
  repo?: string;
  name?: string;
  /** chat only: the app/pack id this chat was started from, so the rail can badge it with the app's
   *  mark and re-opening the chat restores its app context. Absent on a plain chat. */
  app?: string;
}

export interface Project {
  id: string;
  name: string;
  items: ProjectItem[];
  createdAt: number;
}

export class FileProjectStore {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
    private readonly idFactory: () => string = randomUUID,
  ) {
    mkdirSync(dirname(file), { recursive: true });
  }

  list(): Project[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(parsed) ? (parsed as Project[]) : [];
    } catch {
      return [];
    }
  }

  get(id: string): Project | undefined {
    return this.list().find((p) => p.id === id);
  }

  create(name: string): Project {
    const project: Project = { id: this.idFactory(), name: name?.trim() || "New project", items: [], createdAt: this.now() };
    const list = this.list();
    list.push(project);
    this.save(list);
    return project;
  }

  addItem(id: string, item: ProjectItem): Project {
    const list = this.list();
    const p = list.find((x) => x.id === id);
    if (!p) throw new Error(`project not found: ${id}`);
    const same = (a: ProjectItem, b: ProjectItem) =>
      a.type === b.type &&
      ((a.sessionId != null && a.sessionId === b.sessionId) ||
        (a.path != null && a.path === b.path) ||
        (a.url != null && a.url === b.url) ||
        (a.type === "app" && a.repo != null && a.repo === b.repo && a.name === b.name) ||
        (a.type === "map" && b.type === "map"));
    if (!p.items.some((it) => same(it, item))) p.items.push(item);
    this.save(list);
    return p;
  }

  removeItem(id: string, index: number): Project {
    const list = this.list();
    const p = list.find((x) => x.id === id);
    if (!p) throw new Error(`project not found: ${id}`);
    if (index >= 0 && index < p.items.length) p.items.splice(index, 1);
    this.save(list);
    return p;
  }

  rename(id: string, name: string): Project {
    const list = this.list();
    const p = list.find((x) => x.id === id);
    if (!p) throw new Error(`project not found: ${id}`);
    p.name = name?.trim() || p.name;
    this.save(list);
    return p;
  }

  remove(id: string): void {
    this.save(this.list().filter((p) => p.id !== id));
  }

  private save(list: Project[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(list, null, 2) + "\n");
  }
}
