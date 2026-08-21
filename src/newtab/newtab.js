// Pile — New Tab page.
// Renders the LRU-ordered open tabs as a Grid (Photos-style) or List (Linear-style).
// Talks to the service worker for the snapshot and for activate/close/suspend.

const stage = document.getElementById("stage");
const countEl = document.getElementById("count");
const searchEl = document.getElementById("search");
const tplGrid = document.getElementById("tpl-grid");
const tplRow = document.getElementById("tpl-row");
const scopeBtn = document.getElementById("scope");
const scopeLabel = document.getElementById("scope-label");
const winmenu = document.getElementById("winmenu");
const settingsBtn = document.getElementById("settings");
const setmenu = document.getElementById("setmenu");
const keepwarmInput = document.getElementById("keepwarm");
const kwEcho = document.getElementById("kw-echo");
const groupstripInput = document.getElementById("groupstrip");

let items = [];
let view = localStorage.getItem("pile.view") || "grid";
let filter = "";
let sepStyle = localStorage.getItem("pile.sep") || "rule"; // rule | inset | condensed
let myWindowId = null; // the window this pile lives in
let viewWindowId = null; // the window whose pile we're showing (may be another)
let myTabId = null; // this New Tab page's own tab — hidden from its own pile
let winCache = []; // last-known window list for the switcher

const send = (msg) => chrome.runtime.sendMessage(msg);
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function relTime(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function faviconFor(it) {
  if (it.favIconUrl) return it.favIconUrl;
  // Chrome's own favicon cache, scoped to the page URL.
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", it.url);
  u.searchParams.set("size", "32");
  return u.toString();
}

function matches(it) {
  if (!filter) return true;
  return (it.title + " " + it.url).toLowerCase().includes(filter);
}

// Recency tiers — the "cache with layers" spine of the pile. Rolling windows,
// so there are no calendar/midnight edge cases. Items arrive pre-sorted newest
// first, so buckets come out in order.
const BUCKETS = [
  ["Just now", 15],
  ["Past hour", 60],
  ["Today", 60 * 12],
  ["Yesterday", 60 * 36],
  ["This week", 60 * 24 * 7],
  ["Older", Infinity],
];

function bucketOf(ms) {
  const mins = ms ? (Date.now() - ms) / 60000 : Infinity;
  for (const [name, ceil] of BUCKETS) if (mins < ceil) return name;
  return "Older";
}

function render() {
  const visible = items.filter(matches);
  stage.className = `stage ${view} sep-${sepStyle}`;
  stage.replaceChildren();

  if (!visible.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = items.length ? "Nothing matches that filter." : "No open tabs.";
    stage.append(d);
    countEl.textContent = "";
    return;
  }

  const pinned = visible.filter((it) => it.pinned);
  const warm = visible.filter((it) => !it.pinned && !it.suspended);
  const cold = visible.filter((it) => !it.pinned && it.suspended);

  countEl.textContent =
    `${warm.length + cold.length} in the pile · ${warm.length} warm` +
    (cold.length ? ` · ${cold.length} suspended` : "");

  if (pinned.length) renderPinned(pinned);
  if (warm.length) renderWarm(warm);
  if (cold.length) renderPile(cold);
}

function sectionHead(label, count, cls = "bucket-head") {
  const head = document.createElement("h2");
  head.className = cls;
  head.append(label);
  const n = document.createElement("span");
  n.className = "n";
  n.textContent = String(count);
  head.append(n);
  return head;
}

function renderPinned(list) {
  const section = document.createElement("section");
  section.className = "bucket";
  const body = document.createElement("div");
  body.className = "pins";
  for (const it of list) body.append(pinnedChip(it));
  section.append(sectionHead("Pinned", list.length), body);
  stage.append(section);
}

// The warm set: a flat zone (it's small and all recent), no recency sub-buckets.
function renderWarm(list) {
  const section = document.createElement("section");
  section.className = "bucket warm-zone";
  const body = document.createElement("div");
  body.className = "bucket-body " + view;
  const tpl = view === "grid" ? tplGrid : tplRow;
  for (const it of list) body.append(view === "grid" ? gridCard(it, tpl) : listRow(it, tpl));
  section.append(sectionHead("Warm", list.length), body);
  stage.append(section);
}

// The suspended tail: its own zone (styled by sepStyle) with recency buckets
// inside, plus an inline switcher for the separation style.
function renderPile(list) {
  const zone = document.createElement("section");
  zone.className = "pile-zone";
  zone.append(pileHead(list.length));
  renderBuckets(list, zone);
  stage.append(zone);
}

function pileHead(count) {
  const head = document.createElement("div");
  head.className = "pile-head";
  const label = document.createElement("span");
  label.className = "pile-title";
  label.append("The pile");
  const n = document.createElement("span");
  n.className = "n";
  n.textContent = String(count);
  label.append(n);

  const sw = document.createElement("div");
  sw.className = "sep-switch";
  for (const [id, glyph, tip] of [
    ["rule", "—", "Rule"],
    ["inset", "▢", "Recessed panel"],
    ["condensed", "≡", "Condensed"],
  ]) {
    const b = document.createElement("button");
    b.className = "sep-opt" + (sepStyle === id ? " on" : "");
    b.textContent = glyph;
    b.title = tip;
    b.dataset.sep = id;
    sw.append(b);
  }
  head.append(label, sw);
  return head;
}

function renderBuckets(list, container) {
  const counts = new Map();
  for (const it of list) {
    const b = bucketOf(it.lastAccessed);
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  const tpl = view === "grid" ? tplGrid : tplRow;
  let lastBucket = null;
  let body = null;

  for (const it of list) {
    const b = bucketOf(it.lastAccessed);
    if (b !== lastBucket) {
      const section = document.createElement("section");
      section.className = "bucket";
      body = document.createElement("div");
      body.className = "bucket-body " + view;
      section.append(sectionHead(b, counts.get(b)), body);
      container.append(section);
      lastBucket = b;
    }
    body.append(view === "grid" ? gridCard(it, tpl) : listRow(it, tpl));
  }
}

function pinnedChip(it) {
  const chip = document.createElement("button");
  chip.className = "chip";
  chip.dataset.id = it.id;
  if (it.active) chip.classList.add("is-active");
  if (it.suspended) chip.classList.add("is-discarded");
  const fav = document.createElement("img");
  fav.className = "favicon";
  fav.alt = "";
  fav.src = faviconFor(it);
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = it.title;
  chip.append(fav, title);
  return chip;
}

function stateClasses(node, it) {
  node.dataset.id = it.id;
  if (it.active) node.classList.add("is-active");
  if (it.suspended) node.classList.add("is-discarded");
  // "Send to pile" only applies to a warm, non-active tab.
  if (it.suspended || it.active) node.querySelector(".act.pile")?.remove();
}

function gridCard(it, tpl) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  stateClasses(node, it);
  const img = node.querySelector(".thumb img");
  const fallback = node.querySelector(".fallback");
  if (it.thumb) { img.src = it.thumb; fallback.remove(); }
  else fallback.textContent = "◍";
  node.querySelector(".favicon").src = faviconFor(it);
  node.querySelector(".title").textContent = it.title;
  node.querySelector(".badge").textContent = it.active ? "active" : it.suspended ? "suspended" : "";
  return node;
}

function listRow(it, tpl) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  stateClasses(node, it);
  node.querySelector(".favicon").src = faviconFor(it);
  node.querySelector(".title").textContent = it.title;
  node.querySelector(".url").textContent = host(it.url);
  node.querySelector(".when").textContent = relTime(it.lastAccessed);
  // Active rows are shown by highlight; only suspended needs a badge here.
  node.querySelector(".badge").textContent = it.suspended ? "suspended" : "";
  return node;
}

// ---- Interactions --------------------------------------------------------

stage.addEventListener("click", async (e) => {
  const sep = e.target.closest(".sep-opt");
  if (sep) {
    setSep(sep.dataset.sep);
    return;
  }
  const el = e.target.closest("[data-id]");
  if (!el) return;
  const id = Number(el.dataset.id);
  const act = e.target.closest(".act");
  if (act?.classList.contains("close")) {
    e.stopPropagation();
    await send({ type: "close", tabId: id });
    items = items.filter((it) => it.id !== id);
    render();
    return;
  }
  if (act?.classList.contains("pile")) {
    e.stopPropagation();
    await send({ type: "pile", tabId: id });
    refresh();
    return;
  }
  await send({ type: "activate", tabId: id });
});

document.getElementById("view-grid").addEventListener("click", () => setView("grid"));
document.getElementById("view-list").addEventListener("click", () => setView("list"));

function setView(v) {
  view = v;
  localStorage.setItem("pile.view", v);
  document.getElementById("view-grid").classList.toggle("is-on", v === "grid");
  document.getElementById("view-list").classList.toggle("is-on", v === "list");
  render();
}

function setSep(v) {
  sepStyle = v;
  localStorage.setItem("pile.sep", v);
  render();
}

searchEl.addEventListener("input", () => { filter = searchEl.value.trim().toLowerCase(); render(); });

// ---- Scope switcher (peek at another window's pile) ----------------------

async function loadWindows() {
  winCache = (await send({ type: "windows" })) || [];
  scopeBtn.hidden = winCache.length <= 1; // only surfaces when there's a choice
}

function updateScopeLabel() {
  const peeking = viewWindowId !== myWindowId;
  scopeBtn.classList.toggle("peeking", peeking);
  const w = winCache.find((x) => x.windowId === viewWindowId);
  scopeLabel.textContent = peeking ? truncate(w ? w.title : "Other window", 26) : "This window";
}

function renderMenu() {
  winmenu.replaceChildren();
  for (const w of winCache) {
    const item = document.createElement("button");
    item.className = "wm-item" + (w.windowId === viewWindowId ? " on" : "");
    item.dataset.wid = String(w.windowId);
    const tick = document.createElement("span");
    tick.className = "tick"; tick.textContent = "✓";
    const title = document.createElement("span");
    title.className = "wm-title"; title.textContent = truncate(w.title, 42);
    if (w.windowId === myWindowId) {
      const self = document.createElement("span");
      self.className = "self"; self.textContent = "this window";
      title.append(self);
    }
    const cnt = document.createElement("span");
    cnt.className = "wm-count"; cnt.textContent = String(w.count);
    item.append(tick, title, cnt);
    winmenu.append(item);
  }
}

function closeMenu() { winmenu.hidden = true; scopeBtn.setAttribute("aria-expanded", "false"); }

scopeBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (winmenu.hidden) {
    await loadWindows();
    renderMenu();
    winmenu.hidden = false;
    scopeBtn.setAttribute("aria-expanded", "true");
  } else closeMenu();
});

winmenu.addEventListener("click", (e) => {
  const item = e.target.closest(".wm-item");
  if (!item) return;
  viewWindowId = Number(item.dataset.wid);
  closeMenu();
  updateScopeLabel();
  loadKeepWarm(); // this window may have its own threshold
  refresh();
});

function closeSet() { setmenu.hidden = true; settingsBtn.setAttribute("aria-expanded", "false"); }

document.addEventListener("click", () => { if (!winmenu.hidden) closeMenu(); if (!setmenu.hidden) closeSet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); closeSet(); } });

// ---- Settings: keep-warm threshold ---------------------------------------

const KW_MIN = 1;
const KW_MAX = 60;
const clampKw = (n) => Math.max(KW_MIN, Math.min(KW_MAX, n | 0));

// Keep-warm is per-window (session key), falling back to the global default.
async function loadKeepWarm() {
  const key = `keepWarm:${viewWindowId}`;
  const [s, l] = await Promise.all([
    chrome.storage.session.get(key),
    chrome.storage.local.get("keepWarm"),
  ]);
  const v = Number.isInteger(s[key]) ? s[key] : Number.isInteger(l.keepWarm) ? l.keepWarm : 10;
  keepwarmInput.value = String(v);
  kwEcho.textContent = String(v);
}

function commitKeepWarm(v) {
  const n = clampKw(v);
  keepwarmInput.value = String(n);
  kwEcho.textContent = String(n);
  chrome.storage.session.set({ [`keepWarm:${viewWindowId}`]: n }); // SW re-runs upkeep
}

async function loadGroupStrip() {
  const { groupStrip } = await chrome.storage.local.get("groupStrip");
  groupstripInput.checked = groupStrip !== false; // default on
}
groupstripInput.addEventListener("change", () => {
  chrome.storage.local.set({ groupStrip: groupstripInput.checked });
});

settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = setmenu.hidden;
  closeMenu();
  setmenu.hidden = !willOpen;
  settingsBtn.setAttribute("aria-expanded", String(willOpen));
});
setmenu.addEventListener("click", (e) => {
  e.stopPropagation();
  const step = e.target.closest(".step");
  if (step) commitKeepWarm(Number(keepwarmInput.value) + Number(step.dataset.step));
});
keepwarmInput.addEventListener("change", () => commitKeepWarm(Number(keepwarmInput.value)));

// ---- Live data -----------------------------------------------------------

async function refresh() {
  await loadWindows();
  // If the window we were peeking at closed, fall back to our own pile.
  if (myWindowId && !winCache.some((w) => w.windowId === viewWindowId)) {
    viewWindowId = myWindowId;
  }
  const snap = (await send({ type: "snapshot", windowId: viewWindowId })) || [];
  // Hide this New Tab page from its own pile (it'd otherwise show as a card).
  items = snap.filter((it) => it.id !== myTabId);
  updateScopeLabel();
  render();
}

// Keep the pile fresh as tabs change elsewhere.
for (const ev of [
  chrome.tabs.onActivated,
  chrome.tabs.onRemoved,
  chrome.tabs.onUpdated,
  chrome.tabs.onCreated,
  chrome.tabs.onReplaced, // id swap on discard
]) {
  ev.addListener(debounce(refresh, 250));
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function init() {
  const [w, self] = await Promise.all([
    chrome.windows.getCurrent(),
    chrome.tabs.getCurrent(),
  ]);
  myWindowId = w.id;
  viewWindowId = w.id;
  myTabId = self?.id ?? null;
  await Promise.all([loadKeepWarm(), loadGroupStrip()]);
  setView(view);
  await refresh();
}
init();
