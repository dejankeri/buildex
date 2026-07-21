"use strict";
// Doc viewer + the WYSIWYG markdown editor (Save dialog: folder tree + name).
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// State it reads on the shared global `S`: `S.config` (roots, for the default folder), `S.tree` (the
// file tree the Save dialog walks), `S.rightTab` (which right panel is showing, to know whether
// the file tree needs a repaint after a save).

/* doc pane */

/**
 * Load a read-only document tab: render its markdown body plus commit history, and wire the Edit
 * button to open the WYSIWYG editor.
 * @param {object} tab - the doc tab ({path, pane}).
 */
async function loadDoc(tab) {
  try {
    const doc = await getJSON("/api/doc?path=" + encodeURIComponent(tab.path));
    const hist = await getJSON("/api/history?path=" + encodeURIComponent(tab.path)).catch(() => ({ history: [] }));
    let h = '<div class="dh"><span class="mono">' + esc(tab.path) + '</span><button class="mini ghost editdoc">✎ Edit</button></div><div class="md">' + md(doc.content) + '</div>';
    if (hist.history && hist.history.length) {
      // The newest commit (index 0) is the current version, so it gets a "current" tag; every earlier
      // version gets a one-tap Restore. Restore is non-destructive - it writes the old version as a new
      // commit, so the current one is kept in history and the restore can itself be undone.
      h += '<div class="dhist"><h4>History</h4>' + hist.history.map((e, i) =>
        '<div class="h"><span class="sha">' + esc((e.sha || "").slice(0, 7)) + '</span><span>' + esc(e.subject) + '</span>'
        + '<span style="margin-left:auto;color:var(--faint)">' + esc(e.author) + '</span>'
        + (i === 0
          ? '<span class="hcur">current</span>'
          : '<button class="mini ghost hrestore" data-sha="' + escAttr(e.sha || "") + '">Restore</button>')
        + '</div>').join("") + '</div>';
    }
    tab.pane.innerHTML = h;
    const eb = $(".editdoc", tab.pane);
    if (eb) eb.onclick = () => openMarkdownEditor(tab.path, doc.content);
    // Wire each Restore button: confirm (destructive-looking, though reversible) → restore → reload.
    tab.pane.querySelectorAll(".hrestore").forEach((btn) => {
      btn.onclick = async () => {
        const sha = btn.getAttribute("data-sha");
        if (!sha) return;
        if (!confirm("Restore this document to the selected earlier version?\n\nYour current version is kept in history, so this can be undone.")) return;
        btn.disabled = true;
        btn.textContent = "Restoring…";
        try {
          await postJSON("/api/doc/restore", { path: tab.path, sha });
          loadDoc(tab); // re-render with the restored content + the new history entry
        } catch (err) {
          btn.disabled = false;
          btn.textContent = "Restore";
        }
      };
    });
  } catch (e) {
    tab.pane.innerHTML = '<div class="empty">Could not open ' + esc(tab.path) + '.</div>';
  }
}

/* markdown editor (new + edit) - WYSIWYG: edit the rendered document; save as markdown. Non-technical
   operators never see markdown syntax. Load: markdown → md() → editable HTML. Save: HTML → markdown
   via wysiToMd (scoped to the brain's markdown subset). */

/**
 * Set the small status message ("Saving…", "Saved ✓", an error) in the editor header.
 * @param {object} tab - the editor tab ({pane}).
 * @param {string} text - the message to show.
 * @param {string} [cls] - a status class ("good"/"bad") applied to the message span.
 */
function setMsg(tab, text, cls) {
  const m = $(".emsg", tab.pane);
  if (m) m.innerHTML = '<span class="' + escAttr(cls || "") + '">' + esc(text) + '</span>';
}

/**
 * Serialize the inline content of a DOM node to markdown, recursing into nested inline formatting.
 * @param {Node} node - the element whose child nodes are walked.
 * @returns {string} the markdown for the node's inline content.
 */
function wysiInline(node) {
  let s = "";
  node.childNodes.forEach((n) => {
    if (n.nodeType === 3) { s += n.textContent; return; } // text node
    if (n.nodeType !== 1) return;
    const t = n.tagName;
    if (t === "BR") s += "\n";
    else if (t === "STRONG" || t === "B") s += "**" + wysiInline(n) + "**";
    else if (t === "EM" || t === "I") s += "*" + wysiInline(n) + "*";
    else if (t === "CODE") s += "`" + n.textContent + "`";
    else if (t === "A") s += "[" + wysiInline(n) + "](" + (n.getAttribute("href") || "") + ")";
    else s += wysiInline(n);
  });
  return s;
}

/**
 * Serialize the editable root (a contenteditable tree) into markdown, block by block.
 * @param {HTMLElement} root - the `.wysi` contenteditable element.
 * @returns {string} the full markdown document (blocks joined by blank lines, trailing newline).
 */
function wysiToMd(root) {
  const blocks = [];
  root.childNodes.forEach((n) => {
    if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) blocks.push(t); return; } // bare text node
    if (n.nodeType !== 1) return;
    const t = n.tagName;
    if (/^H[1-6]$/.test(t)) blocks.push("#".repeat(+t[1]) + " " + wysiInline(n).trim()); // heading level from the digit
    else if (t === "UL") blocks.push([...n.children].filter((c) => c.tagName === "LI").map((li) => "- " + wysiInline(li).trim()).join("\n"));
    else if (t === "OL") { let i = 1; blocks.push([...n.children].filter((c) => c.tagName === "LI").map((li) => (i++) + ". " + wysiInline(li).trim()).join("\n")); }
    else if (t === "BLOCKQUOTE") blocks.push(wysiInline(n).trim().split("\n").map((l) => "> " + l).join("\n"));
    else if (t === "PRE") blocks.push("```\n" + n.textContent.replace(/\n+$/, "") + "\n```");
    else if (t === "HR") blocks.push("---");
    else blocks.push(wysiInline(n).trim()); // P, DIV, …
  });
  // drop empty blocks, join with blank lines, collapse runs of >2 newlines, end with one newline.
  return blocks.filter((b) => b !== "").join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/**
 * Open the WYSIWYG markdown editor as a new tab, for a fresh document or to edit an existing one.
 * @param {string|null} path - the file path to edit, or falsy to start a new document.
 * @param {string} content - the initial markdown content (empty for a new document).
 */
async function openMarkdownEditor(path, content) {
  const isNew = !path;
  const tab = addTab({ type: "mdedit", title: isNew ? "New document" : ("Edit: " + path.split("/").pop()), path: path || null });
  tab.pane.className = "pane mdeditpane on";
  const roots = (S.config.roots || []).map((r) => r.name).filter((n) => n !== "core");
  let folder = (tab.path ? tab.path.slice(0, tab.path.lastIndexOf("/")) : (roots[0] || ""));
  // The header states WHAT this document is, and nothing else. An unsaved document is "New document";
  // a saved one shows its name. Where it lives is a question for the moment you save it - asking it
  // up front, as a folder-path field, made the first thing an operator saw a thing they couldn't answer.
  const pathRow = '<div class="mdpath"><span class="mdname">' + esc(isNew ? "New document" : path.split("/").pop()) + "</span>"
    + '<span class="mdwhere">' + (isNew ? "not saved yet" : esc(locationLabel(path.slice(0, path.lastIndexOf("/"))))) + "</span></div>";
  const tb = '<div class="mdtoolbar">'
    + '<button class="mtb" data-md="para" title="Normal text">¶</button><button class="mtb" data-md="h1" title="Heading 1">H1</button><button class="mtb" data-md="h2" title="Heading 2">H2</button><button class="mtb" data-md="h3" title="Heading 3">H3</button><span class="mtsep"></span>'
    + '<button class="mtb" data-md="bold" title="Bold (⌘B)"><b>B</b></button><button class="mtb" data-md="italic" title="Italic (⌘I)"><i>I</i></button><button class="mtb" data-md="code" title="Inline code">&lt;&gt;</button><span class="mtsep"></span>'
    + '<button class="mtb" data-md="ul" title="Bullet list">•</button><button class="mtb" data-md="ol" title="Numbered list">1.</button><button class="mtb" data-md="quote" title="Quote">❝</button><button class="mtb" data-md="codeblock" title="Code block">▤</button><span class="mtsep"></span>'
    + '<button class="mtb" data-md="link" title="Link">🔗</button><button class="mtb" data-md="hr" title="Divider">―</button></div>';
  tab.pane.innerHTML = '<div class="mdehead">' + pathRow + '<div class="mdeact"><span class="emsg"></span><div class="savewrap"><button class="mini save">Save</button><button class="mini savecaret" title="Save options">▾</button></div></div></div>'
    + tb + '<div class="wysi md" contenteditable="true" spellcheck="true"></div>';
  const wysi = $(".wysi", tab.pane);
  wysi.innerHTML = (content ? md(content) : "") || "<p><br></p>";
  try { document.execCommand("styleWithCSS", false, false); } catch (e) {} // prefer <b>/<i> tags over inline styles

  /**
   * Run a document.execCommand after refocusing the editor.
   * @param {string} cmd - the execCommand name.
   * @param {string} [val] - the command value, where applicable.
   */
  const exec = (cmd, val) => {
    wysi.focus();
    try { document.execCommand(cmd, false, val); } catch (e) {}
  };

  /** Wrap the current selection in a <code> element (inline code), falling back if surroundContents throws. */
  const inlineCode = () => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (r.collapsed) return;
    const c = document.createElement("code");
    try {
      r.surroundContents(c);
    } catch (e) {
      // surroundContents fails across element boundaries — rebuild the range's content by hand.
      c.textContent = r.toString();
      r.deleteContents();
      r.insertNode(c);
    }
    sel.removeAllRanges();
  };

  // toolbar-button id → the editing action it performs.
  const actions = {
    para: () => exec("formatBlock", "P"), h1: () => exec("formatBlock", "H1"), h2: () => exec("formatBlock", "H2"), h3: () => exec("formatBlock", "H3"),
    bold: () => exec("bold"), italic: () => exec("italic"), code: inlineCode,
    ul: () => exec("insertUnorderedList"), ol: () => exec("insertOrderedList"), quote: () => exec("formatBlock", "BLOCKQUOTE"), codeblock: () => exec("formatBlock", "PRE"),
    link: () => { const u = window.prompt("Link URL", "https://"); if (u) exec("createLink", u); }, hr: () => exec("insertHorizontalRule")
  };
  // mousedown (not click) so the editor keeps its selection while the button fires.
  tab.pane.querySelectorAll(".mtb").forEach((b) => b.onmousedown = (e) => { e.preventDefault(); (actions[b.dataset.md] || (() => {}))(); });
  wysi.addEventListener("paste", (e) => { e.preventDefault(); const t = (e.clipboardData || window.clipboardData).getData("text/plain"); document.execCommand("insertText", false, t); }); // paste stays clean
  wysi.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) { e.preventDefault(); actions.bold(); }
    if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) { e.preventDefault(); actions.italic(); }
    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); $(".save", tab.pane).click(); }
  });
  setTimeout(() => wysi.focus(), 0);

  /**
   * Save the current WYSIWYG content to `savePath` as markdown, updating tab/header/tree on success.
   * @param {string} savePath - the repo-relative path to write.
   */
  const doSave = async (savePath) => {
    setMsg(tab, "Saving…", "");
    try {
      const r = await postJSON("/api/doc", { path: savePath, content: wysiToMd(wysi) });
      if (r.error) { setMsg(tab, r.error, "bad"); return; }
      setMsg(tab, "Saved ✓", "good");
      tab.path = savePath;
      tab.title = "Edit: " + savePath.split("/").pop();
      folder = savePath.slice(0, savePath.lastIndexOf("/"));
      renderTabbar();
      await loadTree();
      if (S.rightTab === "files") renderTree();
      const head = $(".mdpath", tab.pane);
      if (head) head.innerHTML = '<span class="mdname">' + esc(savePath.split("/").pop()) + '</span><span class="mdwhere">' + esc(locationLabel(folder)) + "</span>";
    } catch (e) {
      setMsg(tab, String(e && e.message || e), "bad");
    }
  };

  // Save on a document that has never been saved asks WHERE, the way every editor does: a dialog with
  // the folder tree and a name. A document that already has a home just saves.
  $(".save", tab.pane).onclick = () => {
    if (tab.path) return doSave(tab.path);
    openSaveDialog({ folder, name: "", onSave: doSave });
  };
  $(".savecaret", tab.pane).onclick = (e) => {
    e.stopPropagation();
    openSaveMenu(tab, e.currentTarget, () => folder, doSave);
  };
}

/**
 * Human-readable location for a repo-relative folder: the brain it belongs to, then the path inside
 * it. The operator never sees the repo's real name ("team-acme") - the Files panel doesn't show it
 * either, and a save dialog is the worst possible place to introduce a word they don't know.
 * @param {string} folder - repo-relative folder path ("team-acme/clients/globex").
 * @returns {string} e.g. "Company · clients/globex", or just "Company" at the root.
 */
function locationLabel(folder) {
  if (!folder) return "";
  const parts = String(folder).split("/");
  const brain = { team: "Company", private: "Private", core: "BuildEx library" }[rootSlot(parts[0])] || parts[0];
  const rest = parts.slice(1).join("/");
  return rest ? brain + " · " + rest : brain;
}

/**
 * The Save dialog: pick a folder from the tree, type a name, save. This is the ONE place a document's
 * location is decided, and it is deliberately the same shape every desktop app uses - the brains are
 * named ("Company", "Private"), the read-only library is absent (saving there would be refused), and
 * an existing name is called out BEFORE the save rather than after it overwrites something.
 * @param {{folder?:string, name?:string, onSave:(path:string)=>void}} o
 */
function openSaveDialog(o) {
  closeMenus();
  const bd = elt("div", "ovbackdrop");
  bd.innerHTML = '<div class="ovcard savedlg"><h3 class="ovh">Save document</h3>'
    + '<div class="sd-tree"></div>'
    + '<label class="ovlabel">File name<input class="ovinput sd-name" placeholder="untitled.md"></label>'
    + '<p class="sd-where"></p>'
    + '<div class="ovrow"><button class="mini ghost ovno">Cancel</button><button class="mini ovyes">Save</button></div></div>';
  document.body.appendChild(bd);
  const host = $(".sd-tree", bd), nameEl = $(".sd-name", bd), whereEl = $(".sd-where", bd);
  // Writable brains only - core is read-only, and the derived agent surface isn't a place at all.
  const writable = (S.tree || []).filter((n) => rootSlot(n.name) !== "core");
  let folder = o.folder && writable.some((r) => String(o.folder).split("/")[0] === r.name) ? o.folder : (writable[0] || {}).name || "";
  const open = {}; // which folders are expanded in THIS dialog (independent of the Files panel)
  String(folder).split("/").reduce((acc, seg) => { const p = acc ? acc + "/" + seg : seg; open[p] = true; return p; }, "");

  /** Find a node by path anywhere in the tree (the dialog needs the chosen folder's children). */
  const findNode = (nodes, path) => {
    for (const n of nodes || []) {
      if (n.path === path) return n;
      const hit = n.children ? findNode(n.children, path) : null;
      if (hit) return hit;
    }
    return null;
  };
  /** Would saving replace something? Saving IS an overwrite (/api/doc writes), so say so first. */
  const exists = () => {
    const nm = fileName();
    const dir = findNode(S.tree, folder);
    return !!(nm && dir && (dir.children || []).some((c) => c.type === "file" && c.name === nm));
  };
  const fileName = () => {
    const v = (nameEl.value || "").trim();
    if (!v) return "";
    return /\.[a-z0-9]+$/i.test(v) ? v : v + ".md";
  };
  const paint = () => {
    host.innerHTML = "";
    const draw = (nodes, parent, depth) => {
      (nodes || []).filter((n) => n.type === "dir").forEach((n) => {
        const kids = (n.children || []).filter((c) => c.type === "dir");
        const row = elt("div", "sd-row" + (n.path === folder ? " on" : ""));
        row.style.paddingLeft = 6 + depth * 14 + "px";
        // A root is labelled by its brain; everything under it by its own folder name.
        row.innerHTML = '<span class="sd-caret">' + (kids.length ? (open[n.path] ? "▼" : "▸") : "") + "</span>"
          + '<span class="sd-n">' + esc(depth === 0 ? locationLabel(n.name) : n.name) + "</span>";
        $(".sd-caret", row).onclick = (e) => {
          e.stopPropagation();
          open[n.path] = !open[n.path];
          paint();
        };
        row.onclick = () => {
          folder = n.path;
          open[n.path] = true;
          paint();
        };
        parent.appendChild(row);
        if (open[n.path] && kids.length) draw(kids, parent, depth + 1);
      });
    };
    draw(writable, host, 0);
    const nm = fileName();
    whereEl.className = "sd-where" + (exists() ? " warn" : "");
    whereEl.textContent = exists()
      ? "“" + nm + "” already exists in " + locationLabel(folder) + " - saving replaces it."
      : "Saving to " + locationLabel(folder) + (nm ? " / " + nm : "");
  };
  const close = () => bd.remove();
  const go = () => {
    const nm = fileName();
    if (!nm) return nameEl.focus();
    close();
    o.onSave(folder + "/" + nm);
  };
  nameEl.value = o.name || "";
  nameEl.oninput = paint;
  nameEl.onkeydown = (e) => {
    if (e.key === "Enter") go();
    if (e.key === "Escape") close();
  };
  bd.onclick = (e) => {
    if (e.target === bd) close();
  };
  $(".ovno", bd).onclick = close;
  $(".ovyes", bd).onclick = go;
  paint();
  nameEl.focus();
}

/**
 * Open the "Save options" dropdown (currently just "Save as…") beside `anchor`.
 * @param {object} tab - the editor tab ({path}).
 * @param {HTMLElement} anchor - the caret button the menu hangs off.
 * @param {function(): string} getFolder - returns the current folder, for the picker's initial state.
 * @param {function(string)} doSave - the save callback invoked with the resolved path.
 */
function openSaveMenu(tab, anchor, getFolder, doSave) {
  closeMenus();
  const m = elt("div", "dropdown savemenu");
  // build a menu button with label `label` running `fn` (after closing the menu).
  const item = (label, fn) => {
    const b = elt("button", null, label);
    b.onclick = () => { closeMenus(); fn(); };
    m.appendChild(b);
  };
  // "Save as…" is the same dialog, pre-filled with where this document already lives.
  item("Save as…", () => openSaveDialog({ folder: getFolder(), name: tab.path ? tab.path.split("/").pop() : "", onSave: doSave }));
  anchor.parentElement.appendChild(m);
  m.dataset.menu = "1";
}
