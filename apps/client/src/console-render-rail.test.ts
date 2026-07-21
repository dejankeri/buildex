// Browser test net for the operator console — the right rail (Files tree), the
// title-bar sync dot, and the middle-column tab bar. Like its sibling console-render.test.ts, this
// loads the REAL bundle into jsdom (see console-harness.ts) and asserts renderer DOM output — above
// all that operator/agent-supplied text (file/dir names, tab titles) is ESCAPED not injected, the
// property the innerHTML→builder migration must preserve.
import { describe, it, expect } from "vitest";
import { loadConsole } from "./console-harness.js";

describe("console renderers (jsdom) — Files right rail", () => {
  it("renders the tree: a node + row per file and per dir, with the dir's child nested", () => {
    const { doc, c } = loadConsole();
    c.S.tree = [
      { type: "dir", name: "src", children: [{ type: "file", name: "app.ts", path: "src/app.ts" }] },
      { type: "file", name: "README.md", path: "README.md" },
    ];
    c.rFiles(); // builds #rpanel (header, find box, #agenthealth, #tree) then draws the tree
    expect(doc.querySelector("#rpanel .rhead h4")!.textContent).toBe("Files");
    expect(doc.querySelectorAll("#tree .tnode")).toHaveLength(3); // dir + its child file + top-level file
    expect(doc.querySelectorAll("#tree .trow")).toHaveLength(3);
    expect(doc.querySelector("#tree .trow")!.textContent).toContain("src");
    expect(doc.querySelector("#tree img")).toBeNull(); // sanity: benign data, no live elements
  });

  it("shows an empty tree host when there are no files", () => {
    const { doc, c } = loadConsole();
    c.S.tree = [];
    c.rFiles();
    const host = doc.querySelector("#tree")!;
    expect(host).not.toBeNull();
    expect(doc.querySelectorAll("#tree .tnode")).toHaveLength(0);
    expect(host.innerHTML).toBe("");
  });

  it("ESCAPES an XSS-y file name — the payload is inert text, never a live element", () => {
    const { doc, c } = loadConsole();
    c.S.tree = [{ type: "file", name: "<img src=x onerror=alert(1)>", path: "<img src=x onerror=alert(1)>" }];
    c.rFiles();
    expect(doc.querySelector("#tree img")).toBeNull(); // payload did NOT become a real element
    expect(doc.querySelector("#tree .trow")!.textContent).toContain("<img"); // survives as visible text
  });

  // A provisioned workspace's three roots, as /api/tree returns them.
  const threeRoots = () => [
    { type: "dir", name: "core", path: "core", children: [{ type: "file", name: "conventions.md", path: "core/conventions.md" }] },
    { type: "dir", name: "team-acme", path: "team-acme", children: [{ type: "file", name: "runway.md", path: "team-acme/runway.md" }] },
    { type: "dir", name: "private-you", path: "private-you", children: [{ type: "file", name: "notes.md", path: "private-you/notes.md" }] },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sections = (doc: any) => Array.from(doc.querySelectorAll("#tree .tsec .tsec-t") as any, (n: any) => n.textContent);

  it("splits the two brains into labelled sections and HIDES core by default", () => {
    const { doc, c } = loadConsole();
    c.S.tree = threeRoots();
    c.rFiles();
    expect(sections(doc)).toEqual(["Company", "Private"]); // core is machinery, not the operator's work
    const tx = doc.querySelector("#tree")!.textContent;
    expect(tx).toContain("runway.md");
    expect(tx).toContain("notes.md");
    expect(tx).not.toContain("conventions.md"); // core's contents are hidden with it
    // the repo names themselves never reach the UI - "team-acme" is not a word the operator knows
    expect(tx).not.toContain("team-acme");
    expect(tx).not.toContain("private-you");
    expect(doc.querySelector("#tree .tsec .tsec-s")!.textContent).toBe("shared with your team");
  });

  it("'Show everything' adds the core library and the derived agent files, still sectioned", () => {
    const { doc, c } = loadConsole();
    c.S.tree = threeRoots();
    c.rFiles(); // builds #tree; the derived surface is fetched, so hand it over and repaint directly
    c.S.showAllFiles = true;
    c.S.agentView = { tree: [{ type: "dir", name: ".claude", path: ".claude", children: [] }], summary: {} };
    c.renderTree();
    expect(sections(doc)).toEqual(["Company", "Private", "BuildEx library", "Agent files"]);
    expect(doc.querySelector("#tree")!.textContent).toContain("conventions.md");
  });

  it("rootSlot maps company-suffixed roots to their slot, and leaves a stray name alone", () => {
    const { c } = loadConsole();
    expect([c.rootSlot("core"), c.rootSlot("team-acme"), c.rootSlot("team"), c.rootSlot("private-you"), c.rootSlot("scratch")])
      .toEqual(["core", "team", "team", "private", "scratch"]);
  });

  it("still shows an UNRECOGNISED root — the operator's data is never hidden by a naming rule", () => {
    const { doc, c } = loadConsole();
    c.S.tree = [{ type: "dir", name: "scratch", path: "scratch", children: [{ type: "file", name: "idea.md", path: "scratch/idea.md" }] }];
    c.rFiles();
    expect(doc.querySelector("#tree")!.textContent).toContain("idea.md");
  });

  it("a section the find-box empties drops its heading too", () => {
    const { doc, c } = loadConsole();
    c.S.tree = threeRoots();
    c.S.treeFilter = "runway";
    c.rFiles();
    expect(sections(doc)).toEqual(["Company"]); // no bare "Private" heading over nothing
    c.S.treeFilter = "";
  });

  it("offers create actions on a section and on a folder, but never on read-only surfaces", () => {
    const { doc, c } = loadConsole();
    c.S.tree = threeRoots();
    c.rFiles(); // builds #tree; the derived surface is fetched, so flip the switch and repaint here
    c.S.showAllFiles = true;
    c.renderTree();
    // Company + Private headings carry ＋folder / ＋file, and NO ⋯ (a brain isn't deletable here)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const heads = Array.from(doc.querySelectorAll("#tree .tsec") as any, (n: any) => n);
    expect(heads[0].querySelectorAll(".tmkdir")).toHaveLength(1);
    expect(heads[0].querySelectorAll(".tmkfile")).toHaveLength(1);
    expect(heads[0].querySelectorAll(".tmore")).toHaveLength(0);
    // the core library's heading offers nothing - the daemon would refuse the write anyway
    const lib = heads.find((h: any) => h.textContent.includes("BuildEx library"));
    expect(lib.querySelectorAll(".tact")).toHaveLength(0);
  });

  it("gives a folder ＋folder/＋file/⋯ and a file just ⋯", () => {
    const { doc, c } = loadConsole();
    c.S.tree = [{ type: "dir", name: "team-acme", path: "team-acme", children: [
      { type: "dir", name: "clients", path: "team-acme/clients", children: [] },
      { type: "file", name: "runway.md", path: "team-acme/runway.md" },
    ] }];
    c.rFiles();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = Array.from(doc.querySelectorAll("#tree .tsec-b .trow") as any, (n: any) => n);
    const folder = rows.find((r: any) => r.textContent.includes("clients"));
    const file = rows.find((r: any) => r.textContent.includes("runway.md"));
    expect(Array.from(folder.querySelectorAll(".tact") as any, (b: any) => b.className.split(" ")[1])).toEqual(["tmkdir", "tmkfile", "tmore"]);
    expect(Array.from(file.querySelectorAll(".tact") as any, (b: any) => b.className.split(" ")[1])).toEqual(["tmore"]);
  });

  it("a folder's ＋ acts INSIDE that folder and never also folds it", async () => {
    const { doc, w, c } = loadConsole();
    const posts: { url: string; body: any }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    w.fetch = (url: string, o?: any) => {
      if (o && o.method === "POST") posts.push({ url: String(url), body: JSON.parse(o.body) });
      const data = String(url).includes("/api/tree") ? { tree: [] } : { ok: true };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    };
    c.S.tree = [{ type: "dir", name: "team-acme", path: "team-acme", children: [{ type: "dir", name: "clients", path: "team-acme/clients", children: [] }] }];
    c.rFiles();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = Array.from(doc.querySelectorAll("#tree .trow") as any, (n: any) => n).find((r: any) => r.textContent.includes("clients"));
    const node = row.parentNode;
    const wasClosed = node.className.includes("closed");
    let stopped = false;
    row.querySelector(".tmkdir").onclick({ stopPropagation: () => (stopped = true), currentTarget: row.querySelector(".tmkdir") });
    expect(stopped).toBe(true); // the row's own toggle must not fire too
    expect(node.className.includes("closed")).toBe(wasClosed);
    const inp: any = doc.querySelector(".ovbackdrop .ovinput");
    inp.value = "globex";
    (doc.querySelector(".ovbackdrop .ovyes") as any).onclick();
    await new Promise((r) => setTimeout(r, 0));
    expect(posts[0]!.url).toContain("/api/fs/folder");
    expect(posts[0]!.body.path).toBe("team-acme/clients/globex"); // inside the folder that was clicked
  });

  it("a new document gets .md when the name has no extension, and opens", async () => {
    const { doc, w, c } = loadConsole();
    const posts: { url: string; body: any }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    w.fetch = (url: string, o?: any) => {
      if (o && o.method === "POST") posts.push({ url: String(url), body: JSON.parse(o.body) });
      const u = String(url);
      const data = u.includes("/api/tree") ? { tree: [] } : u.includes("/api/projects") ? { projects: [{ id: "p1", name: "Work", items: [], createdAt: 0 }] } : u.includes("/api/sessions") ? { sessions: [] } : u.includes("/api/sync") ? { status: "ok" } : u.includes("/api/doc") ? { path: "x", content: "" } : { ok: true };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    };
    c.openFileMenu(doc.createElement("button"), "team-acme");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = Array.from(doc.querySelectorAll(".dropdown button") as any, (b: any) => b);
    expect(items.map((b: any) => b.textContent)).toEqual(["▤New document", "⇧Upload a file…"]);
    items[0]!.onclick();
    const inp: any = doc.querySelector(".ovbackdrop .ovinput");
    inp.value = "Kickoff notes";
    (doc.querySelector(".ovbackdrop .ovyes") as any).onclick();
    await new Promise((r) => setTimeout(r, 0));
    expect(posts[0]!.body.path).toBe("team-acme/Kickoff notes.md");
    expect(c.S.tabs.some((t: any) => t.type === "doc" && t.path === "team-acme/Kickoff notes.md")).toBe(true);
  });

  it("delete ASKS first, and a refusal is shown to the operator instead of being swallowed", async () => {
    const { doc, w, c } = loadConsole();
    const posts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    w.fetch = (url: string, o?: any) => {
      if (o && o.method === "POST") posts.push(String(url));
      const data = String(url).includes("/api/fs/") ? { error: "the shared BuildEx library is read-only" } : { tree: [] };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    };
    c.openTreeMoreMenu(doc.createElement("button"), "team-acme/runway.md", "file");
    (doc.querySelector(".dropdown button") as any).onclick();
    const card: any = doc.querySelector(".ovbackdrop .ovcard");
    expect(card.textContent).toContain("Delete this file?");
    expect(posts).toHaveLength(0); // nothing deleted while the question is on screen
    card.querySelector(".ovyes").onclick();
    await new Promise((r) => setTimeout(r, 0));
    expect(posts.some((u) => u.includes("/api/fs/delete"))).toBe(true);
    expect((doc.querySelector(".toast") as any).textContent).toBe("the shared BuildEx library is read-only");
  });

  it("remembers which folders are open, so creating something doesn't fold the tree shut", () => {
    const { doc, c } = loadConsole();
    c.S.tree = [{ type: "dir", name: "team-acme", path: "team-acme", children: [{ type: "dir", name: "clients", path: "team-acme/clients", children: [] }] }];
    c.rFiles();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const node: any = doc.querySelector("#tree .tsec-b .tnode");
    expect(node.className).toContain("closed"); // a section's top level starts folded
    (doc.querySelector("#tree .tsec-b .trow") as any).onclick(); // the operator opens it
    expect(c.S.treeOpen["team-acme/clients"]).toBe(true);
    c.renderTree(); // …and a repaint (what every create/delete ends with) leaves it open
    expect((doc.querySelector("#tree .tsec-b .tnode") as any).className).not.toContain("closed")
  });

  it("has NO apps tab — apps live in the left rail + Store, and a stale 'apps' request lands on Files", () => {
    const { doc, c } = loadConsole();
    expect(doc.querySelector('#rtabs button[data-r="apps"]')).toBeNull();
    c.switchRight("apps"); // e.g. a persisted rightTab from an older build must not blank the panel
    expect(doc.querySelector("#rpanel .rhead h4")!.textContent).toBe("Files");
  });

  it("switchRight('files') marks the Files tab active and renders the Files panel", () => {
    const { doc, c } = loadConsole();
    c.switchRight("files");
    expect(c.S.rightTab).toBe("files");
    expect(doc.querySelector("#rpanel .rhead h4")!.textContent).toBe("Files");
  });
});

describe("console renderers (jsdom) — title-bar sync dot", () => {
  it("paints the requested state class and its tooltip", () => {
    const { doc, c } = loadConsole();
    c.setSync("busy");
    const el = doc.querySelector("#sync")!;
    expect(el.className).toContain("busy");
    expect(el.getAttribute("title")).toContain("Syncing");
    c.setSync("off");
    expect(el.className).toContain("off");
    expect(el.className).not.toContain("busy"); // prior state class was cleared
    expect(el.getAttribute("title")).toContain("Offline");
  });

  it("falls back to 'Synced' for an unknown state", () => {
    const { doc, c } = loadConsole();
    c.setSync("whoknows");
    expect(doc.querySelector("#sync")!.getAttribute("title")).toContain("Synced");
  });
});

describe("console renderers (jsdom) — tab bar", () => {
  it("renders one .tab per open tab, flags the active one, and shows per-type icons", () => {
    const { doc, c } = loadConsole();
    c.S.tabs = [
      { id: "t1", type: "doc", title: "README.md" },
      { id: "t2", type: "chat", title: "Chat", status: "idle" },
    ];
    c.S.active = "t1";
    c.renderTabbar();
    const tabs = doc.querySelectorAll("#tabbar .tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.className).toContain("active");
    expect(tabs[1]!.className).not.toContain("active");
    expect(doc.querySelector("#tabbar .tab .ti")).not.toBeNull(); // doc tab: per-type glyph
    expect(doc.querySelector("#tabbar .tab .st")).not.toBeNull(); // chat tab: live status dot
    expect(doc.querySelector("#tabbar .tab .tt")!.textContent).toBe("README.md");
    expect(doc.querySelector("#tabAdd")).not.toBeNull(); // the add button is preserved
  });

  it("renders no tabs (only the add button) when the tab list is empty", () => {
    const { doc, c } = loadConsole();
    c.S.tabs = [];
    c.renderTabbar();
    expect(doc.querySelectorAll("#tabbar .tab")).toHaveLength(0);
    expect(doc.querySelector("#tabAdd")).not.toBeNull();
  });

  it("ESCAPES an XSS-y tab title — the payload is inert text, never a live element", () => {
    const { doc, c } = loadConsole();
    c.S.tabs = [{ id: "t1", type: "doc", title: "<img src=x onerror=alert(1)>" }];
    c.S.active = "t1";
    c.renderTabbar();
    expect(doc.querySelector("#tabbar img")).toBeNull(); // payload did NOT become a real element
    expect(doc.querySelector("#tabbar .tab .tt")!.textContent).toContain("<img"); // survives as text
  });
});

// The sessions list fetches its own data (getJSON/postJSON). Route `fetch` to controlled JSON,
// method-aware because /api/projects is both the list (GET) and the create (POST).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function routeProjects(w: any, projects: any[], created?: any, sessions: any[] = []): void {
  w.fetch = (url: string, opt?: { method?: string }) => {
    const u = String(url);
    const post = (opt && opt.method) === "POST";
    let data: unknown = null;
    if (post && /\/api\/projects\/[^/]+\/(items|rename|remove-item|delete)/.test(u)) {
      data = { ok: true }; // sub-routes (add-item etc.) must NOT be mistaken for the create call
    } else if (u.includes("/api/projects") && post) {
      projects.push(created); // the store appends on create - mirror that, so order is under test
      data = { project: created };
    } else if (u.includes("/api/projects")) data = { projects };
    else if (u.includes("/api/sessions")) data = { sessions };
    else if (u.includes("/api/sync")) data = { status: "ok" };
    else if (u.includes("/api/apps")) data = { apps: [] };
    else return Promise.reject(new Error("no route: " + u));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  };
}

const proj = (id: string, name: string) => ({ id, name, items: [], createdAt: 0 });

describe("console renderers (jsdom) — sessions left rail", () => {
  it("lists the NEWEST session first, inverting the store's append order", async () => {
    const { doc, w, c } = loadConsole();
    routeProjects(w, [proj("p1", "Oldest"), proj("p2", "Middle"), proj("p3", "Newest")]);
    await c.refreshProjects();
    const names = Array.from(doc.querySelectorAll("#convos .project .pname") as any, (n: any) => n.textContent);
    expect(names).toEqual(["Newest", "Middle", "Oldest"]);
    expect(c.S.projects.map((p: any) => p.id)).toEqual(["p3", "p2", "p1"]); // S order matches the DOM
  });

  it("newProject() puts the fresh session on TOP, makes it active, and shows its start screen", async () => {
    const { doc, w, c } = loadConsole();
    routeProjects(w, [proj("p1", "Older")], proj("p9", "New session"));
    c.S.activeProject = "p1";
    c.S.tabs = [{ id: "t1", type: "doc", title: "Leftover.md", pane: doc.createElement("div") }];
    c.S.active = "t1";
    await c.newProject();
    const names = Array.from(doc.querySelectorAll("#convos .project") as any, (n: any) => n.dataset.p);
    expect(names[0]).toBe("p9"); // top of the list, not the bottom
    expect(c.S.activeProject).toBe("p9");
    expect(c.S.tabs).toHaveLength(0); // the previous session's tabs were unloaded
    expect(doc.querySelector("#startScreen")).not.toBeNull(); // middle column offers the next step
    expect(doc.querySelector('.project[data-p="p9"] .prename')).not.toBeNull(); // named on arrival
  });
});

describe("console renderers (jsdom) — session status dot", () => {
  const chat = (id: string) => ({ type: "chat", sessionId: id, title: "Chat" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dotFor = async (c: any, w: any, statuses: string[]) => {
    const items = statuses.map((_, i) => chat("s" + i));
    const sessions = statuses.map((st, i) => ({ id: "s" + i, title: "Chat " + i, status: st }));
    routeProjects(w, [{ id: "p1", name: "Session", items, createdAt: 0 }], undefined, sessions);
    await c.refreshProjects();
    return w.document.querySelector(".project .phdr .pdot");
  };

  it("worst state wins the roll-up: error > waiting > working > done", () => {
    const { c } = loadConsole();
    const roll = (states: string[]) =>
      c.projectStatus({ items: states.map((_, i) => chat("s" + i)) },
        Object.fromEntries(states.map((st, i) => ["s" + i, { status: st }]))).k;
    expect(roll(["idle", "idle"])).toBe("idle");
    expect(roll(["idle", "running"])).toBe("running");
    expect(roll(["running", "needs-attention"])).toBe("needs-attention");
    expect(roll(["needs-attention", "error"])).toBe("error");
    expect(c.projectStatus({ items: [] }, {}).k).toBe("none"); // nothing has run yet
  });

  it("paints the dot ahead of the session name, with a tooltip that counts the chats", async () => {
    const { w, c } = loadConsole();
    const dot: any = await dotFor(c, w, ["idle", "running"]);
    expect(dot).not.toBeNull();
    expect(dot.className).toContain("pd-running");
    expect(dot.getAttribute("title")).toBe("1 of 2 chats are working");
    expect(dot.nextElementSibling.className).toBe("pname"); // sits in FRONT of the name
  });

  it("a session whose chats are all finished reads green (idle), not empty", async () => {
    const { w, c } = loadConsole();
    const dot: any = await dotFor(c, w, ["idle"]);
    expect(dot.className).toContain("pd-idle");
    expect(dot.className).not.toContain("pd-none");
  });

  it("a chat with no live session yet counts as idle, never as a missing dot", async () => {
    const { w, c } = loadConsole();
    routeProjects(w, [{ id: "p1", name: "S", items: [chat("gone")], createdAt: 0 }], undefined, []);
    await c.refreshProjects();
    expect(w.document.querySelector(".project .phdr .pdot")!.className).toContain("pd-idle");
  });
});

describe("console renderers (jsdom) — the ＋ add-menu", () => {
  const XSS_TITLE = "<img src=x onerror=alert(1)>";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openMenu = (doc: any, c: any, apps: any[], pid?: string) => {
    c.S.apps = apps;
    const anchor = doc.createElement("button");
    doc.body.appendChild(anchor);
    c.openAddMenu(anchor, pid);
    return doc.querySelector(".dropdown.addmenu");
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const labels = (m: any) => Array.from(m.querySelectorAll("button") as any, (b: any) => b.textContent);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const click = (m: any, text: string) => (labels(m).findIndex((t: any) => String(t).includes(text)) >= 0
    ? (m.querySelectorAll("button") as any)[labels(m).findIndex((t: any) => String(t).includes(text))].onclick()
    : Promise.reject(new Error("no menu item: " + text)));

  it("offers the primitives AND every installed app, with a Store row as the on-ramp", () => {
    const { doc, c } = loadConsole();
    const m: any = openMenu(doc, c, [{ repo: "team", name: "notion", title: "Notion", kind: "local" }]);
    const tx = labels(m).join("|");
    expect(tx).toContain("New chat");
    expect(tx).toContain("New document");
    expect(tx).toContain("Web browser");
    expect(tx).toContain("Notion"); // the app is startable straight from the ＋
    expect(tx).toContain("Add apps & tools");
    expect(m.querySelector(".mhd")).not.toBeNull(); // apps sit under their own heading
  });

  it("leaves 'Open a document' OUT of the menu but KEEPS its keyboard shortcut", () => {
    const { doc, c } = loadConsole();
    const m: any = openMenu(doc, c, []);
    expect(labels(m).join("|")).not.toContain("Open a document"); // not a thing you START
    expect(c.ADD_ACTIONS.find((a: any) => a.label === "Open a document").key).toBe("o");
  });

  it("names the empty case instead of showing a bare heading", () => {
    const { doc, c } = loadConsole();
    const m: any = openMenu(doc, c, []);
    expect(m.querySelector(".mhd")!.textContent).toContain("none yet");
  });

  it("a session's ＋ switches to THAT session before starting the new thing", async () => {
    const { doc, w, c } = loadConsole();
    routeProjects(w, [proj("p1", "First"), proj("p2", "Second")]);
    c.S.activeProject = "p1";
    const m: any = openMenu(doc, c, [], "p2");
    await click(m, "Web browser");
    expect(c.S.activeProject).toBe("p2"); // never starts in the previously-active session
    expect(c.S.tabs.some((t: any) => t.type === "browser")).toBe(true);
  });

  it("the tab bar's ＋ (no session id) starts in whatever session is already active", async () => {
    const { doc, w, c } = loadConsole();
    routeProjects(w, [proj("p1", "First"), proj("p2", "Second")]);
    c.S.activeProject = "p1";
    const m: any = openMenu(doc, c, []);
    await click(m, "Web browser");
    expect(c.S.activeProject).toBe("p1");
  });

  it("ESCAPES an XSS-y app title — the payload is inert text, never a live element", () => {
    const { doc, c } = loadConsole();
    const m: any = openMenu(doc, c, [{ repo: "team", name: "x", title: XSS_TITLE, kind: "local" }]);
    expect(m.querySelector("img[onerror]")).toBeNull(); // payload did NOT become a real element
    expect(labels(m).join("|")).toContain("<img"); // survives as visible text
  });
});

describe("console renderers (jsdom) — the rail lists chats, and only chats", () => {
  const chat = (sid: string, title: string, app?: string) => ({ type: "chat", sessionId: sid, title, ...(app ? { app } : {}) });
  // A session holding one of everything: only the chat may reach the rail.
  const mixed = () => [{
    id: "p1", name: "Work", createdAt: 0,
    items: [chat("s1", "Kickoff"), { type: "doc", path: "notes/plan.md" }, { type: "browser", url: "https://example.com" }],
  }];
  // Record POSTs so "did it actually delete?" is asserted on the wire, not on the DOM.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recordPosts = (w: any): string[] => {
    const posts: string[] = [];
    const inner = w.fetch as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    w.fetch = (u: string, o?: any) => {
      if (o && o.method === "POST") posts.push(String(u));
      return inner(u, o);
    };
    return posts;
  };

  it("hides docs and browsers — they are views in the middle column, not session content", async () => {
    const { doc, w, c } = loadConsole();
    routeProjects(w, mixed());
    await c.refreshProjects();
    const rows = Array.from(doc.querySelectorAll("#convos .pitem") as any, (n: any) => n.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Kickoff");
    expect(doc.querySelector("#convos .pitems")!.textContent).not.toContain("plan.md");
    expect(doc.querySelector("#convos .phdr .pcount")!.textContent).toBe("1"); // counts chats, not items
  });

  it("says 'no chats yet' for a session that only holds a doc", async () => {
    const { doc, w, c } = loadConsole();
    routeProjects(w, [{ id: "p1", name: "Work", createdAt: 0, items: [{ type: "doc", path: "notes/plan.md" }] }]);
    await c.refreshProjects();
    expect(doc.querySelector("#convos .pempty")!.textContent).toContain("No chats yet");
  });

  it("badges a chat started from an app, and leaves a plain chat unbadged", async () => {
    const { doc, w, c } = loadConsole();
    c.S.apps = [{ repo: "team", name: "stripe", title: "Stripe", kind: "local", icon: "◆" }];
    routeProjects(w, [{ id: "p1", name: "Work", createdAt: 0, items: [chat("s1", "Plain"), chat("s2", "Payments", "stripe")] }]);
    await c.refreshProjects();
    const rows = Array.from(doc.querySelectorAll("#convos .pitem") as any, (n: any) => n);
    expect(rows[0].querySelector(".pia")).toBeNull();
    expect(rows[1].querySelector(".pia")!.getAttribute("title")).toBe("Stripe chat");
    // the dot still leads the row - the badge is an addition, not a replacement
    expect(rows[1].firstChild.className).toContain("st");
  });

  it("ESCAPES an XSS-y app title in the badge tooltip", async () => {
    const { doc, w, c } = loadConsole();
    c.S.apps = [{ repo: "team", name: "x", title: "<img src=x onerror=alert(1)>", kind: "local" }];
    routeProjects(w, [{ id: "p1", name: "Work", createdAt: 0, items: [chat("s1", "Chat", "x")] }]);
    await c.refreshProjects();
    expect(doc.querySelector("#convos .pitem img[onerror]")).toBeNull();
    expect(doc.querySelector("#convos .pitem .pia")!.getAttribute("title")).toContain("<img");
  });

  it("the row's × ASKS before deleting, and only then removes the chat", async () => {
    const { doc, w, c } = loadConsole();
    routeProjects(w, mixed());
    const posts = recordPosts(w);
    await c.refreshProjects();
    (doc.querySelector("#convos .pitem .pix") as any).onclick({ stopPropagation() {} });
    const card: any = doc.querySelector(".ovbackdrop .ovcard");
    expect(card.textContent).toContain("Delete this chat?");
    expect(posts.some((u) => u.includes("remove-item"))).toBe(false); // nothing deleted yet
    card.querySelector(".ovyes").onclick();
    await new Promise((r) => setTimeout(r, 0));
    expect(posts.some((u) => u.includes("/api/projects/p1/remove-item"))).toBe(true);
    expect(doc.querySelector(".ovbackdrop")).toBeNull(); // dialog dismissed itself
  });

  it("Cancel leaves the chat alone", async () => {
    const { doc, w, c } = loadConsole();
    routeProjects(w, mixed());
    const posts = recordPosts(w);
    await c.refreshProjects();
    (doc.querySelector("#convos .pitem .pix") as any).onclick({ stopPropagation() {} });
    (doc.querySelector(".ovbackdrop .ovno") as any).onclick();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.querySelector(".ovbackdrop")).toBeNull();
    expect(posts.some((u) => u.includes("remove-item"))).toBe(false);
  });
});

describe("console renderers (jsdom) — closing a tab from the tab bar", () => {
  it("closes a doc tab outright — it is only a view of a file that still exists", () => {
    const { doc, c } = loadConsole();
    c.S.tabs = [{ id: "t1", type: "doc", title: "plan.md", pane: doc.createElement("div") }];
    c.S.active = "t1";
    c.requestCloseTab("t1");
    expect(doc.querySelector(".ovbackdrop")).toBeNull(); // no ceremony
    expect(c.S.tabs).toHaveLength(0);
  });

  it("treats closing a CHAT tab as deleting it from its session, after a confirmation", async () => {
    const { doc, w, c } = loadConsole();
    routeProjects(w, [{ id: "p1", name: "Work", createdAt: 0, items: [{ type: "chat", sessionId: "s1", title: "Kickoff" }] }]);
    await c.refreshProjects();
    const posts: string[] = [];
    const inner = w.fetch as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    w.fetch = (u: string, o?: any) => {
      if (o && o.method === "POST") posts.push(String(u));
      return inner(u, o);
    };
    c.S.tabs = [{ id: "t1", type: "chat", title: "Kickoff", sessionId: "s1", pane: doc.createElement("div") }];
    c.S.active = "t1";
    c.requestCloseTab("t1");
    expect(doc.querySelector(".ovbackdrop")!.textContent).toContain("Delete this chat?");
    expect(c.S.tabs).toHaveLength(1); // still open while the operator decides
    (doc.querySelector(".ovbackdrop .ovyes") as any).onclick();
    await new Promise((r) => setTimeout(r, 0));
    expect(posts.some((u) => u.includes("/api/projects/p1/remove-item"))).toBe(true);
    expect(c.S.tabs).toHaveLength(0); // the tab went with it
  });

  it("Cancel keeps the chat open and undeleted", async () => {
    const { doc, w, c } = loadConsole();
    routeProjects(w, [{ id: "p1", name: "Work", createdAt: 0, items: [{ type: "chat", sessionId: "s1", title: "Kickoff" }] }]);
    await c.refreshProjects();
    c.S.tabs = [{ id: "t1", type: "chat", title: "Kickoff", sessionId: "s1", pane: doc.createElement("div") }];
    c.S.active = "t1";
    c.requestCloseTab("t1");
    (doc.querySelector(".ovbackdrop .ovno") as any).onclick();
    expect(c.S.tabs).toHaveLength(1);
  });
});

describe("console renderers (jsdom) — the document editor's Save flow", () => {
  const tree = () => [
    { type: "dir", name: "core", path: "core", children: [{ type: "dir", name: "rules", path: "core/rules", children: [] }] },
    { type: "dir", name: "team-acme", path: "team-acme", children: [
      { type: "dir", name: "clients", path: "team-acme/clients", children: [{ type: "dir", name: "globex", path: "team-acme/globex", children: [] }] },
      { type: "file", name: "runway.md", path: "team-acme/runway.md" },
    ] },
    { type: "dir", name: "private-you", path: "private-you", children: [] },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (doc: any) => Array.from(doc.querySelectorAll(".savedlg .sd-row .sd-n") as any, (r: any) => r.textContent.trim());

  it("a new document asks WHERE only when you save — the header just names it", () => {
    const { doc, c } = loadConsole();
    c.S.config = { company: { name: "Acme" }, roots: [{ name: "core" }, { name: "team-acme" }] };
    c.openMarkdownEditor(null, "");
    const head: any = doc.querySelector(".mdeditpane .mdpath");
    expect(head.textContent).toContain("New document");
    expect(head.textContent).toContain("not saved yet");
    expect(doc.querySelector(".mdeditpane .f-name")).toBeNull(); // no path field to decode
    expect(doc.querySelector(".mdeditpane .folderbtn")).toBeNull();
    expect(doc.querySelector(".mdeditpane .save")).not.toBeNull(); // …and Save is on the right
  });

  it("Save on an unsaved document opens the folder tree, naming the brains and hiding core", () => {
    const { doc, c } = loadConsole();
    c.S.tree = tree();
    c.openSaveDialog({ onSave: () => {} });
    // Roots read as brains, core is absent (saving there would be refused), and the default target -
    // the first writable brain - is already open so its folders are one click away.
    expect(rows(doc)).toEqual(["Company", "clients", "Private"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clients: any = Array.from(doc.querySelectorAll(".sd-row") as any, (r: any) => r)[1];
    clients.onclick();
    expect(rows(doc)).toEqual(["Company", "clients", "globex", "Private"]); // picking a folder opens it
    expect((doc.querySelector(".sd-where") as any).textContent).toContain("Saving to Company · clients");
  });

  it("saves to the chosen folder, adding .md when the name has no extension", () => {
    const { doc, c } = loadConsole();
    c.S.tree = tree();
    let saved = "";
    c.openSaveDialog({ folder: "team-acme/clients", onSave: (p: string) => (saved = p) });
    (doc.querySelector(".sd-name") as any).value = "Globex kickoff";
    (doc.querySelector(".savedlg .ovyes") as any).onclick();
    expect(saved).toBe("team-acme/clients/Globex kickoff.md");
    expect(doc.querySelector(".ovbackdrop")).toBeNull(); // dialog closed itself
  });

  it("warns BEFORE saving over a file that already exists", () => {
    const { doc, c } = loadConsole();
    c.S.tree = tree();
    c.openSaveDialog({ folder: "team-acme", onSave: () => {} });
    const nameEl: any = doc.querySelector(".sd-name");
    nameEl.value = "runway.md";
    nameEl.oninput();
    const where: any = doc.querySelector(".sd-where");
    expect(where.className).toContain("warn");
    expect(where.textContent).toContain("already exists");
    nameEl.value = "runway-2.md";
    nameEl.oninput();
    expect((doc.querySelector(".sd-where") as any).className).not.toContain("warn");
  });

  it("an empty name can never be saved", () => {
    const { doc, c } = loadConsole();
    c.S.tree = tree();
    let saved = "";
    c.openSaveDialog({ onSave: (p: string) => (saved = p) });
    (doc.querySelector(".savedlg .ovyes") as any).onclick();
    expect(saved).toBe("");
    expect(doc.querySelector(".ovbackdrop")).not.toBeNull(); // stays open rather than inventing a name
  });

  it("locationLabel speaks brains, never repo names", () => {
    const { c } = loadConsole();
    expect(c.locationLabel("team-acme")).toBe("Company");
    expect(c.locationLabel("team-acme/clients/globex")).toBe("Company · clients/globex");
    expect(c.locationLabel("private-you/1-1s")).toBe("Private · 1-1s");
  });
});
