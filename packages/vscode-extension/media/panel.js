// Blast radius panel (webview). Only textContent is used for daemon data.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  let target = null;
  let filters = { set: "all" };
  let editRevision;
  let shown = 0;
  let total = 0;
  let selected = null;
  let lastDetail = null;
  let screenshots = false;

  function el(tag, props, ...children) {
    const n = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const c of children) if (c !== undefined && c !== null && c !== false) n.append(typeof c === "string" ? document.createTextNode(c) : c);
    return n;
  }

  const fmt = (n) => Number(n).toLocaleString("en-US");

  function load(offset) {
    vscode.postMessage({ type: "load", set: filters.set, group: filters.group, side: filters.side, offset, editRevision });
  }

  // ------------------------------------------------------------- toolbar

  function renderSides() {
    const box = $("sides");
    box.replaceChildren();
    const sides = (target && target.sides) || [];
    if (sides.length < 2) return;
    const label = { pages: "Reaches now", gained: "Starts reaching", lost: "Stops reaching" };
    for (const s of sides) {
      const active = (filters.side || "pages") === s;
      box.append(
        el("button", {
          class: active ? "active" : "",
          text: label[s] || s,
          onclick: () => {
            filters = { set: "all", side: s === "pages" ? undefined : s };
            renderSides();
            load(0);
          },
        }),
      );
    }
  }

  function renderSets(count) {
    const box = $("sets");
    box.replaceChildren();
    const entries = [
      ["all", "All", count.exact + count.possible + count.unknown],
      ["exact", "Exact", count.exact],
      ["possible", "Possible", count.possible],
      ["unknown", "Unknown", count.unknown],
    ];
    for (const [key, name, n] of entries) {
      if (key !== "all" && key !== filters.set && n === 0) continue;
      box.append(
        el("button", {
          class: filters.set === key ? "active" : "",
          text: `${name} ${fmt(n)}`,
          title: key === "possible" ? "Matching needs a closer look (L1 refines these)" : key === "unknown" ? "Couldn't be evaluated (e.g. unsupported selector or failed page)" : undefined,
          onclick: () => {
            filters.set = key;
            load(0);
          },
        }),
      );
    }
  }

  function renderGroups(groups) {
    const sel = $("group");
    sel.replaceChildren(el("option", { value: "", text: "All sections" }));
    for (const g of groups) {
      const n = g.exact + g.possible + g.unknown;
      sel.append(el("option", { value: g.name, text: `${g.name} (${fmt(n)})`, selected: g.name === filters.group }));
    }
    sel.hidden = groups.length < 2 && !filters.group;
  }

  $("group").addEventListener("change", (e) => {
    filters.group = e.target.value || undefined;
    load(0);
  });
  $("more").addEventListener("click", () => load(shown));

  // ---------------------------------------------------------------- list

  function pageItem(p) {
    const li = el(
      "li",
      {
        class: `page ${p.set}${selected === p.url ? " selected" : ""}`,
        tabindex: "0",
        title: p.set === "exact" ? "Matches on the captured page" : p.set === "possible" ? "May match (state or structure dependent)" : "Not evaluated",
        onclick: () => selectPage(p.url, li),
        onkeydown: (e) => {
          if (e.key === "Enter") selectPage(p.url, li);
        },
      },
      el("span", { class: `badge ${p.set}`, text: p.set === "exact" ? "●" : p.set === "possible" ? "◐" : "?" }),
      el("span", { class: "url", text: p.url }),
      p.template ? el("span", { class: "template muted", text: p.template }) : null,
    );
    li.dataset.url = p.url;
    return li;
  }

  function onPages(m) {
    const r = m.result;
    editRevision = r.editRevision;
    filters = Object.assign({ set: "all" }, m.filters || {});
    $("summary").textContent = m.summary;
    $("subtitle").textContent = m.subtitle;
    $("listerror").hidden = true;
    renderSides();
    renderSets(r.count);
    renderGroups(r.groups);
    const ul = $("pages");
    if (!m.append) {
      ul.replaceChildren();
      shown = 0;
    }
    for (const p of r.pages) ul.append(pageItem(p));
    shown = r.offset + r.pages.length;
    total = r.total;
    $("more").hidden = shown >= total;
    $("more").textContent = `Load more (${fmt(total - shown)} left)`;
    $("listmeta").textContent = total ? `${fmt(Math.min(shown, total))} of ${fmt(total)}` : "";
    if (!total) ul.append(el("li", { class: "muted empty", text: r.count.complete ? "No pages." : "Resolving…" }));
    if (m.refresh && lastDetail) markDetailStale();
  }

  function selectPage(url, li) {
    selected = url;
    for (const n of document.querySelectorAll("#pages li.selected")) n.classList.remove("selected");
    if (li) li.classList.add("selected");
    request({ type: "page", url });
  }

  function request(msg) {
    lastDetail = msg;
    const d = $("detail");
    d.replaceChildren(detailHeader(msg.url), el("div", { class: "muted loading", text: msg.type === "live" ? "Loading the live page…" : msg.type === "render" ? "Rendering before and after…" : "Finding elements…" }));
    vscode.postMessage(msg);
  }

  function markDetailStale() {
    const d = $("detail");
    if (d.querySelector(".stale-note")) return;
    d.prepend(
      el(
        "div",
        { class: "stale-note" },
        "Your edits changed since this view. ",
        el("button", { class: "link", text: "Refresh", onclick: () => lastDetail && request(Object.assign({}, lastDetail, { screenshots })) }),
      ),
    );
  }

  // -------------------------------------------------------------- detail

  function detailHeader(url, extra) {
    const shotBox = el("input", { type: "checkbox", id: "shots", checked: screenshots, onchange: (e) => (screenshots = e.target.checked) });
    return el(
      "div",
      { class: "detail-head" },
      el("h2", { text: url }),
      extra || null,
      el(
        "div",
        { class: "actions" },
        el("button", { text: "Elements", title: "Which elements the edited rules match (L1)", onclick: () => request({ type: "page", url }) }),
        el("button", { text: "Render diff", title: "Render the stored page before and after the edit (L2)", onclick: () => request({ type: "render", url, screenshots }) }),
        el("button", { text: "Live check", title: "Load the live page and apply the edit (L3)", onclick: () => request({ type: "live", url, screenshots }) }),
        el("label", { class: "muted" }, shotBox, " screenshots"),
      ),
    );
  }

  function matchesView(matches) {
    if (!matches.length) return el("div", { class: "muted", text: "No edited selectors to look up on this page." });
    const box = el("div", { class: "matches" });
    for (const s of matches) {
      const sec = el("div", { class: "match" }, el("code", { class: "selector", text: s.selector }));
      if (s.dropped && s.dropped.length) sec.append(el("div", { class: "muted small", text: `Ignoring ${s.dropped.join(", ")} (state-dependent)` }));
      if (s.error) sec.append(el("div", { class: "error", text: s.error }));
      for (const v of s.variants) {
        const head = el("div", { class: "variant" }, el("strong", { text: v.variant }), ` · ${fmt(v.count)} element${v.count === 1 ? "" : "s"}`);
        sec.append(head);
        if (v.elements.length) {
          const ul = el("ul", { class: "elements" });
          for (const e of v.elements) ul.append(el("li", null, el("code", { text: e })));
          if (v.count > v.elements.length) ul.append(el("li", { class: "muted", text: `…and ${fmt(v.count - v.elements.length)} more` }));
          sec.append(ul);
        }
      }
      if (!s.variants.length && !s.error) sec.append(el("div", { class: "muted", text: "No elements." }));
      box.append(sec);
    }
    return box;
  }

  function renderView(r) {
    const box = el("div", { class: `render ${r.status}` });
    const head =
      r.status === "changed"
        ? `${fmt(r.changedElements)} element${r.changedElements === 1 ? "" : "s"} change${r.movedElements ? `, ${fmt(r.movedElements)} move` : ""}`
        : r.status === "unchanged"
          ? "Nothing visible changes on this page"
          : "Inconclusive";
    box.append(el("div", { class: "render-head" }, el("span", { class: `status ${r.status}`, text: head }), el("span", { class: "muted", text: ` · ${r.mode} · ${r.variant} · ${fmt(r.timingMs)} ms` })));
    if (r.reason) box.append(el("div", { class: "muted", text: r.reason }));
    for (const w of r.warnings || []) box.append(el("div", { class: "warning", text: w }));
    if (r.elements.length) {
      const table = el("table", { class: "elements" }, el("tr", null, el("th", { text: "Element" }), el("th", { text: "Change" }), el("th", { text: "Before → after" })));
      for (const e of r.elements) {
        const cell = el("td");
        for (const p of e.props) cell.append(el("div", null, el("code", { text: p.prop }), ": ", el("span", { class: "before", text: p.before }), " → ", el("span", { class: "after", text: p.after })));
        if (e.box && e.box.before && e.box.after) {
          const [bx, by, bw, bh] = e.box.before;
          const [ax, ay, aw, ah] = e.box.after;
          cell.append(el("div", { class: "muted small", text: `box ${bx},${by} ${bw}×${bh} → ${ax},${ay} ${aw}×${ah}` }));
        }
        table.append(el("tr", null, el("td", null, el("code", { text: e.path })), el("td", { text: e.kind }), cell));
      }
      box.append(table);
      if (r.truncated) box.append(el("div", { class: "muted small", text: "List truncated." }));
    }
    if (r.screenshots) {
      box.append(
        el(
          "div",
          { class: "shots" },
          el("figure", null, el("figcaption", { text: "Before" }), el("img", { src: `data:image/jpeg;base64,${r.screenshots.before}`, alt: "Before" })),
          el("figure", null, el("figcaption", { text: "After" }), el("img", { src: `data:image/jpeg;base64,${r.screenshots.after}`, alt: "After" })),
        ),
      );
    }
    if (r.comparedProps && r.comparedProps.length) box.append(el("div", { class: "muted small", text: `Compared: ${r.comparedProps.join(", ")}` }));
    return box;
  }

  function onDetail(m) {
    if (!lastDetail || m.url !== lastDetail.url || m.kind !== lastDetail.type) return;
    const d = $("detail");
    const first = m.results.find((x) => x.result);
    const meta = first
      ? el("div", { class: "muted small", text: [first.result.template && `template ${first.result.template}`, `captured ${new Date(first.result.capturedAt).toLocaleString()}`, `${fmt(m.ms)} ms`].filter(Boolean).join(" · ") })
      : null;
    d.replaceChildren(detailHeader(m.url, meta));
    if (!m.results.length) d.append(el("div", { class: "muted", text: "No changed files." }));
    const multi = m.results.length > 1;
    for (const x of m.results) {
      const sec = el("section", { class: "file" });
      if (multi || x.error) sec.append(el("h3", null, el("button", { class: "link", text: x.file, onclick: () => vscode.postMessage({ type: "openFile", path: x.path }) })));
      if (x.error) sec.append(el("div", { class: "error", text: x.error }));
      else {
        if (x.result.render) sec.append(renderView(x.result.render));
        sec.append(el("h4", { text: "Elements the edited rules match" }), matchesView(x.result.matches));
      }
      d.append(sec);
    }
  }

  // ------------------------------------------------------------ messages

  window.addEventListener("message", (e) => {
    const m = e.data;
    switch (m.type) {
      case "target":
        target = m.target;
        filters = { set: "all", side: m.target.side };
        editRevision = undefined;
        selected = null;
        lastDetail = null;
        $("title").textContent = m.target.title;
        $("subtitle").textContent = m.subtitle;
        $("summary").textContent = "";
        $("pages").replaceChildren(el("li", { class: "muted empty", text: "Loading…" }));
        $("detail").replaceChildren(el("div", { class: "muted placeholder", text: "Select a page to see which elements the edit reaches." }));
        renderSides();
        break;
      case "pages":
        onPages(m);
        break;
      case "error":
        $("listerror").hidden = false;
        $("listerror").textContent = m.message;
        if (!shown) $("pages").replaceChildren();
        break;
      case "detail":
        onDetail(m);
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
