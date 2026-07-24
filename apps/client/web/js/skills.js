"use strict";
// Right rail: the Skills panel and its editors.
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// Lists skills ("verbs"), opens read-only skill tabs, and hosts the
// create/edit editors that POST back to the daemon. State it reads on the shared global `S`:
// `S.config` (company + repo roots, for save targets and run folders), `S.tabs` (to de-dup open
// skill tabs), `S.rightTab` (to refresh the panel in place after a save), and `S.activeProject`
// (to attach spawned run sessions to the current project).

/** Render the Skills panel: header, "Teach" button, and a card per skill (or an empty state). */
async function rSkills() {
  const p = $("#rpanel");
  p.innerHTML = '<div class="rhead"><h4>Skills - verbs your agent runs</h4><button class="radd" id="newSkill">+ Teach</button></div><div id="rl"></div>';
  $("#newSkill").onclick = () => openSkillEditor(null);
  let sk = [];
  try {
    sk = (await getJSON("/api/skills")).skills;
  } catch (e) {}
  const host = $("#rl");
  if (!sk.length) {
    host.innerHTML = '<div class="rmini"><div class="big">✦</div>No verbs yet. Teach your agent one - a repeatable task it runs on request.</div>';
    return;
  }
  sk.forEach((s) => {
    const card = elt("div", "rcard rclick", '<div class="cn">✦ ' + esc(s.name) + '</div><div class="cd">' + esc(s.description || "") + '</div><div class="ra"><button class="mini run">Run</button><button class="mini ghost edit">Edit</button></div>');
    $(".cn", card).onclick = () => openSkillTab(s.name);
    $(".cd", card).onclick = () => openSkillTab(s.name);
    $(".run", card).onclick = (e) => {
      e.stopPropagation();
      runSkill(s.name);
    };
    $(".edit", card).onclick = (e) => {
      e.stopPropagation();
      openSkillEditor(s.name);
    };
    host.appendChild(card);
  });
}

/**
 * Strip a leading YAML frontmatter block from skill markdown.
 * @param {string} c - the raw skill file contents.
 * @returns {string} the body with any `---…---` header removed.
 */
function stripFrontmatter(c) {
  const m = (c || "").match(/^---\n[\s\S]*?\n---\n?/);
  return m ? c.slice(m[0].length) : c;
}

/**
 * Parse a skill file into its description (from frontmatter) and body.
 * @param {string} c - the raw skill file contents.
 * @returns {{description: string, body: string}} the `description:` field and the stripped body.
 */
function parseSkill(c) {
  const m = (c || "").match(/^---\n([\s\S]*?)\n---/);
  let description = "";
  if (m) {
    const d = m[1].match(/^description:\s*(.+)$/m);
    if (d) description = d[1].trim();
  }
  return { description, body: stripFrontmatter(c) };
}

/** Open (or re-focus) a read-only tab rendering skill `name`'s markdown, with Run/Edit actions. */
async function openSkillTab(name) {
  const ex = S.tabs.find((t) => t.type === "skill" && t.name === name);
  if (ex) {
    activateTab(ex.id);
    return;
  }
  const tab = addTab({ type: "skill", title: name, name });
  tab.pane.className = "pane docpane on";
  tab.pane.innerHTML = "loading…";
  try {
    const s = await getJSON("/api/skill?name=" + encodeURIComponent(name));
    tab.pane.innerHTML = '<div class="skhead"><div class="dh">✦ ' + esc(name) + ' <span class="pill ok">' + esc(s.origin || "") + '</span></div><div class="ska"><button class="mini run">Run this verb</button><button class="mini ghost edit">Edit</button></div></div><div class="md">' + md(stripFrontmatter(s.content)) + '</div>';
    $(".run", tab.pane).onclick = () => runSkill(name);
    $(".edit", tab.pane).onclick = () => openSkillEditor(name);
  } catch (e) {
    tab.pane.innerHTML = '<div class="empty">Could not open ' + esc(name) + '.</div>';
  }
}

/** Run skill `name`: create a session (attached to the active project), open a chat tab, prefill it. */
async function runSkill(name) {
  const folder = (S.config.company && S.config.company.name) || "Conversations";
  const { id } = await postJSON("/api/sessions", { folder, title: "Run: " + name });
  if (S.activeProject) await postJSON("/api/projects/" + S.activeProject + "/items", { item: { type: "chat", sessionId: id, title: "Run: " + name } });
  await refreshProjects();
  const tab = addTab({ type: "chat", title: "Run: " + name, sessionId: id, status: "idle", prefill: "Use the `" + name + "` skill." });
  buildChatPane(tab);
  loadSession(tab);
}

/** Open the skill editor tab: a create form, or an edit form pre-filled from an existing skill. */
async function openSkillEditor(name) {
  const tab = addTab({ type: "skilledit", title: name ? ("Edit: " + name) : "New verb", name });
  tab.pane.className = "pane editorpane on";
  tab.pane.innerHTML = "loading…";
  let init = { name: name || "", description: "", instructions: "" };
  if (name) {
    // editing: seed the form from the saved skill's frontmatter + body.
    try {
      const s = await getJSON("/api/skill?name=" + encodeURIComponent(name));
      const pr = parseSkill(s.content);
      init = { name, description: pr.description, instructions: pr.body };
    } catch (e) {}
  } else {
    // creating: seed the instructions box with the server-provided template.
    try {
      init.instructions = (await getJSON("/api/skill")).template;
    } catch (e) {}
  }
  const roots = (S.config.roots || []).map((r) => r.name).filter((n) => n !== "core");
  const opts = roots.map((r) => '<option value="' + escAttr(r) + '">' + esc(r) + '</option>').join("") || '<option value="">(no writable repo)</option>';
  tab.pane.innerHTML = '<div class="editor"><h3>' + (name ? "Edit verb" : "Teach a new verb") + '</h3>'
    + '<label>Name (kebab-case)<input class="f-name" placeholder="weekly-review" value="' + escAttr(init.name) + '"' + (name ? " disabled" : "") + '></label>'
    + '<label>When to use it - the trigger<input class="f-desc" placeholder="Use when the week closes so progress is captured…" value="' + escAttr(init.description) + '"></label>'
    + '<label>Instructions<textarea class="f-body" rows="15">' + esc(init.instructions) + '</textarea></label>'
    + '<label>Save into<select class="f-repo">' + opts + '</select></label>'
    + '<div class="ebar"><button class="mini save">Save verb</button><span class="emsg"></span></div>'
    + '<p class="ehint">Saved verbs are linked into the agent and committed to the repo. A good description ("Use when…") is what makes the agent reach for it.</p></div>';
  $(".save", tab.pane).onclick = async () => {
    const body = { name: ($(".f-name", tab.pane).value || init.name).trim(), description: $(".f-desc", tab.pane).value.trim(), instructions: $(".f-body", tab.pane).value, repo: $(".f-repo", tab.pane).value };
    const msg = $(".emsg", tab.pane);
    if (!body.repo) {
      msg.innerHTML = '<span class="bad">No writable repo to save into.</span>';
      return;
    }
    msg.textContent = "Saving…";
    try {
      const r = await postJSON("/api/skill", body);
      if (r.error) {
        msg.innerHTML = '<span class="bad">' + esc(r.error) + '</span>';
        return;
      }
      msg.innerHTML = (r.issues && r.issues.length) ? '<span class="warn">Saved - notes: ' + esc(r.issues.join("; ")) + '</span>' : '<span class="good">Saved ✓ linked &amp; committed</span>';
      // Verbs live in the Brain map's Policy stage now — refresh it so the new verb shows immediately.
      if (S.rightTab === "brain") rBrain();
      openSkillTab(body.name);
    } catch (e) {
      msg.innerHTML = '<span class="bad">' + esc(e && e.message || e) + '</span>';
    }
  };
}
