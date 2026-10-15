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
  let sides; // the one picked edit's sides, when it has more than one
  let single; // the one picked edit's label

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

  function renderChips(chips, count, all) {
    const box = $("chips");
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
        group.append(toggle(label, ch.selected ? "all" : "none", { path: file.path, changeId: ch.id },
          ch.selected ? "Click to unpick this edit" : "Click to pick this edit"));
      }
      box.append(group);
    }
  }

  let tabsMsg = null;

  // Tabs: what your CSS is compared with. A click shows the tab right away; the list follows.
  function renderTabs(active) {
    const box = $("tabs");
    box.replaceChildren();
    for (const tab of tabsMsg.tabs) {
      const node = button(tab.name, tab.base === active, () => {
        if (tab.base === active) return;
        renderTabs(tab.base);
        $("mainBox").hidden = true;
        $("pages").replaceChildren(el("div", "empty muted", "Finding pages…"));
        vscode.postMessage({ type: "tab", base: tab.base });
      });
      node.setAttribute("role", "tab");
      node.setAttribute("aria-selected", tab.base === active ? "true" : "false");
      node.title = tab.tip;
      box.append(node);
    }
    const main = active === "production" && tabsMsg.main;
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
    const label = { pages: "Reaches now", gained: "Starts reaching", lost: "Stops reaching" };
    for (const side of sides) {
      box.append(button(label[side], (filters.side || "pages") === side, () => {
        filters = { set: "all", side: side === "pages" ? undefined : side };
        load(0);
      }));
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

  function renderRows() {
    const list = $("pages");
    const visible = searchQuery ? (searchRows || []) : rows;
    const before = list.scrollTop;
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
    list.scrollTop = before;
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
    if (m.type === "tabs") {
      tabsMsg = m;
      renderTabs(m.base);
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
      + ` · checked in ${fmt(m.ms || 0)} ms · compared with ${m.baseLabel}`;
    $("branch").textContent = m.branchNote ? `ⓘ ${m.branchNote}` : "";
    $("branch").hidden = !m.branchNote;
    $("warning").textContent = m.lostChanges > 1
      ? "⚠ Some pages lose a style they had — see the edits below"
      : m.lost ? `⚠ ${fmt(m.lost)} pages lose a style they had` : "";
    if (!m.append) {
      rows = [];
      losses = {};
    }
    rows.push(...m.result.pages);
    renderChips(m.chips, m.allCount || count, m.all);
    renderSides();
    renderSets(count);
    renderGroups(m.result.groups);
    renderRows();
    renderAssess();
  });

  vscode.postMessage({ type: "ready" });
})();
