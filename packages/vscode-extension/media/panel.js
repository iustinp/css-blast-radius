(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString("en-US");
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let target = { title: "All edits" };
  let filters = { set: "all" };
  let rows = [];
  let losses = {};
  let editRevision;
  let total = 0;
  let searchQuery = "";
  let searchRows = null;
  let searchTotal = 0;
  let searchTimer;
  let assessment = null; // the list's PagesResult.assessment
  let assessing = null; // { done, total } while an assessment runs
  let nonePicked = false;
  let sides; // the one picked edit's page lists ({side, count}), when it has more than one
  let single; // the one picked edit's label
  const edits = new Map(); // "path\nid" -> { path, id, label, props, file, line }

  function load(offset) {
    vscode.postMessage({ type: "load", ...filters, offset, editRevision });
  }

  function button(text, active, action) {
    const node = el("button", active ? "active" : "", text);
    node.addEventListener("click", action);
    return node;
  }

  // A picked edit is highlighted; a file with only some of its edits picked gets a dashed outline.
  function toggle(text, state, msg, title) {
    const node = button(text, state === "all", () => vscode.postMessage({ type: "toggle", ...msg }));
    if (state === "some") node.classList.add("partial");
    node.setAttribute("aria-pressed", state === "all" ? "true" : state === "some" ? "mixed" : "false");
    node.title = title;
    return node;
  }

  const SVG = "http://www.w3.org/2000/svg";
  function arrow() {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", "M2.5 9.5 9.5 2.5M9.5 2.5h-5.5M9.5 2.5v5.5");
    svg.append(path);
    return svg;
  }

  // The green ↗ at the end of an edit: opens its file at the change, to adjust it.
  // Hovering it shows the edit's rule (the card), which says the same, so no tooltip.
  function goButton(path, id, text) {
    const node = el("button", text ? "go wide" : "go");
    node.append(arrow());
    if (text) node.append(document.createTextNode(text));
    if (text) node.title = "Go to this rule in the file";
    node.setAttribute("aria-label", "Go to this rule in the file");
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "goto", path, changeId: id });
    });
    return node;
  }

  function renderChips(chips, count, all) {
    const box = $("chips");
    // Rebuilding the list would drop its scroll position: keep the clicked edit in place.
    const top = box.scrollTop;
    edits.clear();
    const some = chips.some((f) => f.state !== "none");
    box.replaceChildren(toggle(`All edits · ${fmt(count.exact + count.possible + count.unknown)}`,
      all ? "all" : some ? "some" : "none", {}, all ? "Click to unpick every edit" : "Click to pick every edit"));
    for (const file of chips) {
      const group = el("div", "file-chips");
      group.append(el("div", "file-name", file.label));
      group.append(toggle(`${file.changed} edit${file.changed === 1 ? "" : "s"} · ${file.count}`, file.state, { path: file.path },
        file.state === "all" ? "Click to unpick this file's edits" : "Click to pick all of this file's edits"));
      for (const ch of file.changes) {
        const label = `${ch.label} · ${ch.count}${ch.lost ? ` · ${fmt(ch.lost)} lose this style ⚠` : ""}`;
        const item = el("span", "edit");
        item.dataset.key = `${file.path}\n${ch.id}`;
        edits.set(item.dataset.key, { path: file.path, id: ch.id, label: ch.label, props: ch.props, file: file.label, line: ch.line });
        item.append(toggle(label, ch.selected ? "all" : "none", { path: file.path, changeId: ch.id },
          ch.selected ? "Click to unpick this edit" : "Click to pick this edit"), goButton(file.path, ch.id));
        group.append(item);
      }
      box.append(group);
    }
    if (box.scrollTop !== top) box.scrollTop = top;
    // The card follows its edit through re-renders (picking, typing).
    if (cardKey === null) return;
    cardAnchor = [...box.querySelectorAll(".edit")].find((n) => n.dataset.key === cardKey) || null;
    if (!cardAnchor) closeCard();
    else placeCard();
  }

  // ----------------------------------------------------------- edit card
  // Hovering an edit's green button shows its whole rule: the declarations it changes in
  // green, the others gray, removed ones struck out. It stays open while the
  // pointer is on it, so its text can be selected and copied.

  const card = $("card");
  const details = new Map(); // "path\nid" -> the host's reply
  let cardKey = null;
  let cardAnchor = null;
  let detailSeq = 0;
  let showTimer;
  let hideTimer;

  function requestDetail(key) {
    const e = edits.get(key);
    if (e) vscode.postMessage({ type: "rule", path: e.path, changeId: e.id, seq: detailSeq });
  }

  function openCard(item) {
    // The list re-rendered while waiting to open: that chip is gone.
    if (!item.isConnected || !edits.has(item.dataset.key)) return;
    clearTimeout(hideTimer);
    cardKey = item.dataset.key;
    cardAnchor = item;
    if (!details.has(cardKey)) requestDetail(cardKey);
    renderCard();
    if (cardKey === null) return;
    card.hidden = false;
    placeCard();
  }

  function closeCard() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    cardKey = null;
    cardAnchor = null;
    card.hidden = true;
  }

  function hideSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(closeCard, 250);
  }

  function placeCard() {
    if (card.hidden || !cardAnchor) return;
    const r = (cardAnchor.querySelector(".go") || cardAnchor).getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const below = vh - r.bottom - 10;
    const above = r.top - 10;
    card.style.setProperty("max-width", `${Math.max(200, Math.min(560, vw - 16))}px`);
    card.style.setProperty("max-height", `${Math.max(120, Math.max(below, above))}px`);
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const top = h <= below || below >= above ? r.bottom + 4 : r.top - 4 - h;
    card.style.setProperty("left", `${Math.max(8, Math.min(r.left, vw - w - 8))}px`);
    card.style.setProperty("top", `${Math.max(4, top)}px`);
  }

  // The rule as CSS: what Copy puts on the clipboard (a removed rule as it was).
  function cssText(r) {
    const lines = [];
    let ind = "";
    for (const c of r.conditions) {
      lines.push(`${ind}${c} {`);
      ind += "  ";
    }
    lines.push(`${ind}${r.selector} {`);
    for (const x of r.decls) if (r.removed || x.state !== "removed") lines.push(`${ind}  ${x.text};`);
    lines.push(`${ind}}`);
    for (let i = 0; i < r.conditions.length; i++) {
      ind = ind.slice(2);
      lines.push(`${ind}}`);
    }
    return lines.join("\n");
  }

  function cardNote(d) {
    const r = d.rule;
    if (!r) return el("div", "card-note", d.summary || "");
    if (r.removed) return el("div", "card-note", "Rule removed: none of it applies any more.");
    const whole = {
      added: "New rule: all of it is part of the edit.",
      selector: "New selector: every declaration now reaches other elements.",
      condition: "New conditions: every declaration applies in other situations.",
      moved: "Rule moved: it now comes before or after other rules.",
    }[d.kind];
    if (whole) return el("div", "card-note", whole);
    const note = el("div", "card-note");
    const parts = [["changed", "changed"], ["removed", "removed"], ["same", "unchanged"]]
      .map(([state, word]) => [state, r.decls.filter((x) => x.state === state).length, word])
      .filter(([, n]) => n > 0);
    parts.forEach(([state, n, word], i) => {
      if (i) note.append(document.createTextNode(" · "));
      note.append(el("span", state, `${fmt(n)} ${word}`));
    });
    return note;
  }

  function cardCode(d) {
    const r = d.rule;
    const box = el("div", "card-code");
    let ind = "";
    const line = (text, cls, was) => {
      const node = el("div", `ln ${cls}`, ind + text);
      if (was !== undefined) node.append(el("span", "was", `was ${was}`));
      box.append(node);
    };
    const whole = d.kind !== "declarations";
    if (r.oldConditions) line(r.oldConditions.join(" › ") || "(no @media or other conditions)", "removed");
    for (const c of r.conditions) {
      line(`${c} {`, r.removed ? "removed" : r.oldConditions || d.kind === "added" ? "changed" : "ctx");
      ind += "  ";
    }
    if (r.oldSelector) line(r.oldSelector, "removed");
    line(`${r.selector} {`, r.removed ? "removed" : whole ? "changed" : "ctx");
    for (const x of r.decls) line(`  ${x.text};`, x.state, x.was);
    line("}", r.removed ? "removed" : "ctx");
    for (let i = 0; i < r.conditions.length; i++) {
      ind = ind.slice(2);
      line("}", r.removed ? "removed" : "ctx");
    }
    return box;
  }

  function renderCard() {
    const e = edits.get(cardKey);
    if (!e) return closeCard();
    const m = details.get(cardKey);
    const d = m && m.detail;
    card.replaceChildren();
    const head = el("div", "card-head");
    head.append(el("div", "card-where muted", `${e.file} · line ${fmt(d ? d.line : e.line)}`));
    const actions = el("div", "card-actions");
    if (d && d.rule) {
      const copy = el("button", "", "Copy");
      copy.title = d.rule.removed ? "Copy the rule as it was" : "Copy the rule";
      copy.addEventListener("click", () => {
        vscode.postMessage({ type: "copy", text: cssText(d.rule) });
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1200);
      });
      actions.append(copy);
    }
    actions.append(goButton(e.path, e.id, "Go to rule"));
    head.append(actions);
    card.append(head);
    if (!m) {
      card.append(el("div", "card-note muted", "Reading the rule…"));
    } else if (m.error) {
      // An older server: what the list knows.
      card.append(el("div", "card-code", e.props && e.props.length ? `${e.label}\n  changed: ${e.props.join(", ")}` : e.label));
      card.append(el("div", "card-note warning", m.error));
    } else {
      card.append(cardNote(d));
      if (d.rule) card.append(cardCode(d));
    }
  }

  // Only the green button opens the card, so picking edits doesn't pop it up.
  const goOf = (node) => node && node.closest ? node.closest(".edit > .go") : null;
  $("chips").addEventListener("mouseover", (e) => {
    const go = goOf(e.target);
    if (!go) return;
    const item = go.parentElement;
    clearTimeout(hideTimer);
    if (item.dataset.key === cardKey) return;
    clearTimeout(showTimer);
    // Right away when moving from one edit to the next; after a short pause otherwise.
    showTimer = setTimeout(() => openCard(item), card.hidden ? 300 : 60);
  });
  $("chips").addEventListener("mouseout", (e) => {
    const go = goOf(e.target);
    if (!go || go.contains(e.relatedTarget)) return;
    clearTimeout(showTimer);
    if (!card.hidden) hideSoon();
  });
  $("chips").addEventListener("focusin", (e) => {
    const go = goOf(e.target);
    if (go && e.target.matches(":focus-visible")) openCard(go.parentElement);
  });
  $("chips").addEventListener("focusout", (e) => {
    if (!card.hidden && !card.contains(e.relatedTarget) && !goOf(e.relatedTarget)) hideSoon();
  });
  card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  card.addEventListener("mouseleave", hideSoon);
  card.addEventListener("focusout", (e) => { if (!card.contains(e.relatedTarget)) hideSoon(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !card.hidden) closeCard(); });
  document.addEventListener("mousedown", (e) => {
    if (!card.hidden && !card.contains(e.target) && !goOf(e.target)) closeCard();
  });
  document.addEventListener("scroll", (e) => { if (!card.hidden && !card.contains(e.target)) closeCard(); }, true);
  window.addEventListener("resize", placeCard);

  let tabsMsg = null;

  // Tabs: which of your changes count. A click shows the tab right away; the list follows.
  function renderTabs(active) {
    const box = $("tabs");
    box.replaceChildren();
    for (const tab of tabsMsg.tabs) {
      const node = button(tab.name, tab.tab === active, () => {
        if (tab.tab === active) return;
        renderTabs(tab.tab);
        $("pages").replaceChildren(el("div", "empty muted", "Finding pages…"));
        vscode.postMessage({ type: "tab", tab: tab.tab });
      });
      node.setAttribute("role", "tab");
      node.setAttribute("aria-selected", tab.tab === active ? "true" : "false");
      node.title = tab.tip;
      box.append(node);
    }
    const scan = tabsMsg.scan;
    $("scanLine").hidden = !scan;
    if (scan) {
      $("scanLine").textContent = scan.text;
      $("scanLine").title = scan.tip;
      $("scanLine").classList.toggle("busy", scan.busy);
    }
    const main = tabsMsg.main;
    $("mainBox").hidden = !main;
    if (!main) return;
    $("mainChanges").checked = main.shown;
    $("mainLabel").textContent = `Show ${main.name}'s ${plural(main.behind, "newer commit", "newer commits")} you haven't pulled`;
    $("mainBox").title = main.shown
      ? `Their changes count as if your branch undid them. Uncheck to count only your branch's changes.`
      : `Count them too, as if your branch undid them (a plain comparison of your files with the live site).`;
  }

  $("mainChanges").addEventListener("change", (e) => {
    $("pages").replaceChildren(el("div", "empty muted", "Finding pages…"));
    vscode.postMessage({ type: "mainChanges", show: e.target.checked });
  });

  function renderSides() {
    const box = $("sides");
    box.replaceChildren();
    if (!sides || sides.length < 2) return;
    // Only a changed selector has these: it can start or stop matching on a page.
    const label = { pages: "All affected", gained: "Gain the rule", lost: "Lose the rule" };
    const tip = {
      pages: "Every page this edit touches: where the old selector matched, where the new one matches, or both. "
        + "Pages matched both before and after are only in this list: there the rule may now style other elements.",
      gained: "Pages where only the new selector matches: the rule's styles now show up on them, where they didn't before.",
      lost: "Pages where only the old selector matched: the rule's styles disappear from them.",
    };
    for (const { side, count } of sides) {
      const node = button(`${label[side]} · ${count}`, (filters.side || "pages") === side, () => {
        filters = { set: "all", side: side === "pages" ? undefined : side };
        load(0);
      });
      node.title = tip[side];
      box.append(node);
    }
  }

  function renderSets(count) {
    const box = $("sets");
    box.replaceChildren();
    for (const [set, label, n] of [
      ["all", "All", count.exact + count.possible + count.unknown],
      ["exact", "Matches", count.exact],
      ["possible", "May match", count.possible],
      ["unknown", "Not checked", count.unknown],
    ]) {
      if (set !== "all" && !n && filters.set !== set) continue;
      box.append(button(`${label} ${fmt(n)}`, filters.set === set, () => {
        filters.set = set;
        load(0);
      }));
    }
  }

  function renderGroups(groups) {
    const sel = $("group");
    sel.replaceChildren();
    const all = el("option", "", "All linked groups");
    all.value = "";
    sel.append(all);
    for (const group of groups) {
      const count = group.exact + group.possible + group.unknown;
      const opt = el("option", "", `${group.name} (${fmt(count)})`);
      opt.value = group.name;
      sel.append(opt);
    }
    sel.value = filters.group || "";
    sel.hidden = !groups.length;
  }

  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

  function impactText(im) {
    if (im.status === "unchanged") return "No visual change";
    if (im.status === "inconclusive") return `Couldn't tell: ${im.reason || "the page couldn't be compared"}`;
    const part = (d) => [d.changed ? plural(d.changed, "element changes", "elements change") : "", d.moved ? `${fmt(d.moved)} move` : ""]
      .filter(Boolean).join(", ") || (d.status === "inconclusive" ? "couldn't tell" : "no change");
    return `Looks different · ${im.devices.length > 1 ? im.devices.map((d) => `${d.name}: ${part(d)}`).join(" · ") : part(im)}`;
  }

  // Deeper blue for more changed elements (log scale); a faint tint when things only move.
  function heat(im) {
    if (!im || im.status !== "changed") return 0;
    if (!im.changed) return 0.08;
    const max = (assessment && assessment.maxChanged) || im.changed;
    return Math.min(0.6, 0.14 + 0.46 * Math.log1p(im.changed) / Math.log1p(max));
  }

  function renderAssess() {
    const btn = $("assess");
    const busy = !!assessing;
    $("list").classList.toggle("assessing", busy);
    btn.classList.toggle("running", busy);
    btn.classList.toggle("wave", busy && !assessing.total);
    btn.hidden = !assessment || !total;
    if (btn.hidden) return;
    if (busy) {
      btn.disabled = true;
      btn.textContent = assessing.total ? `Assessing impact… ${fmt(assessing.done)} / ${fmt(assessing.total)}` : "Assessing impact…";
      btn.style.setProperty("--progress", `${assessing.total ? Math.round((100 * assessing.done) / assessing.total) : 0}%`);
      return;
    }
    btn.style.removeProperty("--progress");
    if (assessment.pending > 0) {
      btn.disabled = false;
      btn.textContent = assessment.assessed
        ? `Assess impact · ${plural(assessment.pending, "more page", "more pages")}`
        : `Assess impact · ${plural(assessment.pending, "page", "pages")}`;
      return;
    }
    btn.disabled = true;
    btn.textContent = `Impact assessed: ${fmt(assessment.changed)} of ${plural(assessment.assessed, "page looks", "pages look")} different`;
  }

  // The page list keeps its scroll position through redraws. When one makes it shorter for a moment
  // (while typing, its loss notes come a little later), it scrolls back once the list is long again.
  const listBox = $("list");
  let listTop = 0; // where the user left it
  let growBack = 0; // until when a shortened list goes back to listTop
  let ownScroll = 0; // redraws whose scroll events aren't the user's
  listBox.addEventListener("scroll", () => {
    if (ownScroll) return;
    listTop = listBox.scrollTop;
    growBack = 0;
  });

  function renderRows() {
    const list = $("pages");
    const visible = searchQuery ? (searchRows || []) : rows;
    if (performance.now() > growBack) listTop = listBox.scrollTop;
    list.replaceChildren();
    for (const p of visible) {
      const row = el("div", `page ${p.set}`);
      row.tabIndex = 0;
      const h = heat(p.impact);
      if (h) {
        row.classList.add("impact");
        row.style.setProperty("--heat", `${Math.round(h * 100)}%`);
      }
      const open = () => vscode.postMessage({ type: "page", url: p.url });
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
      row.append(el("div", "url", p.url));
      const details = [p.groups && p.groups.join(", "), single, p.template,
        p.set === "possible" ? "may match" : p.set === "unknown" ? "not checked" : ""].filter(Boolean);
      if (details.length) row.append(el("div", "muted detail", details.join(" · ")));
      if (p.impact) row.append(el("div", `detail impact-${p.impact.status}${p.impact.status === "changed" ? "" : " muted"}`, impactText(p.impact)));
      if (losses[p.url]) row.append(el("div", "warning detail", `⚠ loses ${losses[p.url].join(", ")}`));
      else if (filters.side === "lost") row.append(el("div", "warning detail", "⚠ loses this style"));
      list.append(row);
    }
    if (!visible.length) list.append(el("div", "empty muted", searchQuery
      ? searchRows ? "No page matches that URL." : "Searching all affected pages…"
      : nonePicked ? "No edits picked. Click an edit above to see the pages it reaches." : "No affected pages yet."));
    ownScroll++;
    listBox.scrollTop = listTop;
    if (listBox.scrollTop < listTop - 1) growBack = performance.now() + 3000;
    requestAnimationFrame(() => requestAnimationFrame(() => { ownScroll--; }));
    const remaining = searchQuery ? searchTotal - visible.length : total - visible.length;
    $("more").hidden = remaining <= 0;
    $("more").textContent = `Show more (${fmt(remaining)} left)`;
  }

  $("assess").addEventListener("click", () => {
    assessing = { done: 0, total: 0 };
    renderAssess();
    vscode.postMessage({ type: "assess" });
  });
  $("group").addEventListener("change", (e) => { filters.group = e.target.value || undefined; load(0); });
  $("more").addEventListener("click", () => {
    if (searchQuery) vscode.postMessage({ type: "searchMore", query: searchQuery, offset: searchRows.length });
    else load(rows.length);
  });
  $("search").addEventListener("input", (e) => {
    searchQuery = e.target.value.trim();
    searchRows = null;
    searchTotal = 0;
    clearTimeout(searchTimer);
    renderRows();
    searchTimer = setTimeout(() => vscode.postMessage({ type: "search", query: searchQuery }), 200);
  });

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "target") {
      target = m.target;
      filters = { set: "all", side: target.side };
      sides = undefined;
      single = undefined;
      editRevision = undefined;
      rows = [];
      losses = {};
      searchRows = null;
      searchTotal = 0;
      assessment = null;
      assessing = null;
      renderAssess();
      $("pages").replaceChildren(el("div", "empty muted", "Finding pages…"));
      return;
    }
    if (m.type === "rule") {
      if (m.seq !== detailSeq) return; // asked before the last edit
      const key = `${m.path}\n${m.changeId}`;
      details.set(key, m);
      if (key === cardKey) {
        renderCard();
        placeCard();
      }
      return;
    }
    if (m.type === "tabs") {
      tabsMsg = m;
      renderTabs(m.tab);
      return;
    }
    if (m.type === "error") {
      $("error").textContent = m.message;
      $("error").hidden = false;
      return;
    }
    if (m.type === "searchResults") {
      if (m.query !== searchQuery) return;
      searchRows = m.pages;
      searchTotal = m.total;
      renderRows();
      return;
    }
    if (m.type === "searchMore") {
      if (m.query !== searchQuery || !searchRows) return;
      searchRows.push(...m.pages);
      renderRows();
      return;
    }
    if (m.type === "assessProgress") {
      const p = m.progress;
      // A late update from an assessment an edit already replaced.
      if (p.running && p.editRevision !== undefined && editRevision !== undefined && p.editRevision !== editRevision) return;
      if (p.running) assessing = { done: p.done, total: p.total };
      else if (!p.total) assessing = null; // nothing to assess, or it failed
      renderAssess();
      return;
    }
    if (m.type === "losses") {
      if (m.editRevision !== editRevision) return;
      for (const [url, labels] of Object.entries(m.pages)) losses[url] = [...new Set([...(losses[url] || []), ...labels])];
      renderRows();
      return;
    }
    if (m.type !== "pages") return;
    $("error").hidden = true;
    filters = m.filters;
    target = m.target;
    sides = m.sides;
    single = m.single;
    nonePicked = !m.ruleList && m.pickedEdits === 0;
    editRevision = m.result.editRevision;
    total = m.result.total;
    assessment = m.result.assessment || null;
    assessing = assessment && assessment.running ? { done: assessment.done, total: assessment.total } : null;
    const count = m.result.count;
    $("number").textContent = fmt(count.exact + count.possible + count.unknown);
    $("summary").textContent = m.ruleList
      ? `${m.summary} reached by ${target.title} (of ${fmt(m.scopePages)} in linked groups)`
      : `${m.summary} affected of ${fmt(m.scopePages)} in linked groups`;
    const edits = m.chips.reduce((n, c) => n + c.changed, 0);
    const files = `${fmt(m.chips.length)} file${m.chips.length === 1 ? "" : "s"}`;
    $("meta").textContent = `${m.all ? `${plural(edits, "edit", "edits")} in ${files}` : `${fmt(m.pickedEdits)} of ${plural(edits, "edit", "edits")} picked in ${files}`}`
      + ` · checked in ${fmt(m.ms || 0)} ms · compared with the live site`;
    $("branch").textContent = m.branchNote ? `ⓘ ${m.branchNote}` : "";
    $("branch").hidden = !m.branchNote;
    $("warning").textContent = m.lostChanges > 1
      ? "⚠ Some pages lose a style they had — see the edits below"
      : m.lost ? `⚠ ${fmt(m.lost)} pages lose a style they had` : "";
    if (!m.append) {
      rows = [];
      losses = {};
      // The edits may have changed: cards ask again (the open one keeps showing until the answer).
      details.clear();
      detailSeq++;
    }
    rows.push(...m.result.pages);
    for (const [url, labels] of Object.entries(m.losses || {})) losses[url] = [...new Set([...(losses[url] || []), ...labels])];
    renderChips(m.chips, m.allCount || count, m.all);
    if (!m.append && cardKey !== null) requestDetail(cardKey);
    renderSides();
    renderSets(count);
    renderGroups(m.result.groups);
    renderRows();
    renderAssess();
  });

  vscode.postMessage({ type: "ready" });
})();
