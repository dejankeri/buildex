"use strict";
// Doc viewer + the WYSIWYG markdown editor (folder picker, save menu).
//
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.
// State it reads on the shared global `S`: `S.config` (roots, for the folder list), `S.tree` (the
// file tree the folder picker walks), `S.rightTab` (which right panel is showing, to know whether
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
  // new docs get a folder picker + name input; existing docs just show their path.
  const pathRow = isNew
    ? '<div class="mdpath"><button class="folderbtn" title="Choose a folder"><span class="ficon">📁</span><span class="foldertxt">' + esc(folder || "choose folder") + '</span><span class="fcaret">▾</span></button><span class="pslash">/</span><input class="f-name" placeholder="untitled.md"></div>'
    : '<div class="mdpath"><span class="mono">' + esc(path) + '</span></div>';
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
      if (head) head.innerHTML = '<span class="mono">' + esc(savePath) + '</span>'; // becomes an existing file
    } catch (e) {
      setMsg(tab, String(e && e.message || e), "bad");
    }
  };

  /**
   * Resolve the target path for a fresh document from the folder picker + name input.
   * @returns {string|null} the path to save to, or null (with a status message set) if incomplete.
   */
  const newPath = () => {
    if (tab.path) return tab.path;
    if (!folder) { setMsg(tab, "Choose a folder.", "bad"); return null; }
    let rel = ($(".f-name", tab.pane).value || "").trim();
    if (!rel) { setMsg(tab, "Enter a file name.", "bad"); return null; }
    if (!/\.md$/.test(rel)) rel += ".md";
    return folder + "/" + rel;
  };
  $(".save", tab.pane).onclick = () => { const p = newPath(); if (p) doSave(p); };
  $(".savecaret", tab.pane).onclick = (e) => { e.stopPropagation(); openSaveMenu(tab, e.currentTarget, () => folder, doSave); };
  const fb = $(".folderbtn", tab.pane);
  if (fb) fb.onclick = (e) => { e.stopPropagation(); openFolderPicker(e.currentTarget, folder, (chosen) => { folder = chosen; $(".foldertxt", tab.pane).textContent = chosen; }); };
}

/**
 * Collect every directory path in a file-tree, depth-first, into `out`.
 * @param {object[]} nodes - tree nodes ({type, path, children}).
 * @param {string[]} out - the accumulator, returned for convenience.
 * @returns {string[]} `out`, with all dir paths pushed onto it.
 */
function folderPaths(nodes, out) {
  (nodes || []).forEach((n) => {
    if (n.type === "dir") { out.push(n.path); folderPaths(n.children, out); }
  });
  return out;
}

/**
 * Open a searchable folder-picker dropdown anchored to `anchor`.
 * @param {HTMLElement} anchor - the element the dropdown is appended beside.
 * @param {string} current - the currently-selected folder (highlighted in the list).
 * @param {function(string)} onPick - called with the chosen folder path.
 */
function openFolderPicker(anchor, current, onPick) {
  closeMenus();
  const folders = folderPaths(S.tree, []).filter((p) => p.split("/")[0] !== "core");
  const m = elt("div", "dropdown folderpick");
  m.innerHTML = '<input class="ffind" placeholder="Find a folder…"><div class="flist"></div>';
  const list = $(".flist", m), inp = $(".ffind", m);
  // (re)draw the list, filtered by the typed substring `f`.
  const draw = (f) => {
    list.innerHTML = "";
    const shown = folders.filter((p) => !f || p.toLowerCase().includes(f));
    if (!shown.length) { list.innerHTML = '<div class="amini">No folders. Type a path when you name the file.</div>'; }
    shown.forEach((p) => {
      const b = elt("button", (p === current ? "sel" : null), '<span class="ficon">📁</span>' + esc(p));
      b.onclick = () => { onPick(p); closeMenus(); };
      list.appendChild(b);
    });
  };
  inp.oninput = () => draw(inp.value.toLowerCase().trim());
  draw("");
  anchor.parentElement.appendChild(m);
  m.dataset.menu = "1";
  setTimeout(() => inp.focus(), 0);
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
  item("Save as…", () => openFolderPicker(anchor, getFolder(), (chosen) => { const base = tab.path ? tab.path.split("/").pop() : "untitled.md"; const name = window.prompt("Save as - file name", base); if (!name) return; let rel = name.trim(); if (!/\.md$/.test(rel)) rel += ".md"; doSave(chosen + "/" + rel); }));
  anchor.parentElement.appendChild(m);
  m.dataset.menu = "1";
}
