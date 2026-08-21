// Pile — service worker.
//
// Responsibilities (v1, discard-first):
//   1. Serve the New Tab page a live, LRU-ordered snapshot of open tabs.
//   2. Capture a thumbnail of the active tab as the user moves around, so the
//      grid view has real content to show.
//   3. Suspend (discard) tabs that fall past a "keep-warm" horizon to save
//      memory — the core payoff, and it never removes a tab from the strip.
//   4. Handle activate / close / discard actions from the New Tab page.
//
// LRU ordering is derived from Chrome's own `tab.lastAccessed`, so it survives
// service-worker restarts for free — no order array to persist. Newly opened
// (cmd+click) tabs carry a fresh timestamp and land near the top of the pile,
// which matches the "just threw it on the pile" mental model.

import { putThumb, getAllThumbs, deleteThumb, migrateThumb } from "../lib/thumbs.js";

const DEFAULT_KEEP_WARM = 10; // tabs kept in memory; the rest get discarded
const CAPTURE_DEBOUNCE_MS = 600;
const MAINTAIN_DEBOUNCE_MS = 350;
const PILE_GROUP_COLOR = "grey";

let captureTimer = null;

// The keep-warm threshold is per-window. A window's own value lives in
// chrome.storage.session under `keepWarm:<windowId>` (window ids aren't stable
// across a relaunch, so this is intentionally ephemeral); the global default in
// chrome.storage.local is the fallback.
async function keepWarm(windowId) {
  if (windowId != null) {
    const key = `keepWarm:${windowId}`;
    const s = await chrome.storage.session.get(key);
    if (Number.isInteger(s[key]) && s[key] > 0) return s[key];
  }
  const { keepWarm } = await chrome.storage.local.get("keepWarm");
  return Number.isInteger(keepWarm) && keepWarm > 0 ? keepWarm : DEFAULT_KEEP_WARM;
}

// Whether to declutter the strip by collapsing cold tabs into a "Pile" group.
async function groupingEnabled() {
  const { groupStrip } = await chrome.storage.local.get("groupStrip");
  return groupStrip !== false; // default on
}

// ---- LRU snapshot --------------------------------------------------------

async function snapshot(windowId) {
  // A pile is scoped to one window by default. windowId is the window whose pile
  // to return (the New Tab page's own window, unless it's peeking at another).
  const query = windowId ? { windowId } : {};
  const [tabs, thumbs] = await Promise.all([
    chrome.tabs.query(query),
    getAllThumbs().catch(() => new Map()),
  ]);
  // Single source of truth: a tab is "suspended" in the pile's eyes if it's in
  // the cold tail of the SAME partition that drives grouping/discarding — not
  // whatever Chrome's in-memory `discarded` flag happens to say. This keeps the
  // page's warm/suspended counts in lockstep with the actual tab strip.
  let coldIds = new Set();
  if (windowId != null) {
    try {
      const { coldTabs } = await partition(windowId);
      coldIds = new Set(coldTabs.map((t) => t.id));
    } catch {
      /* window gone */
    }
  }
  // Pinned tabs are included (the New Tab page renders them as anchors, not in
  // the recency flow) but never counted toward the warm budget or discarded.
  const items = tabs
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    .map((t, i) => {
      const url = t.url || t.pendingUrl || "";
      const cached = thumbs.get(t.id);
      // tabId is not stable across a browser relaunch, so a cached shot could
      // belong to a different page now. Only trust it if the URL still matches.
      const thumb = cached && cached.url === url ? cached.dataUrl : "";
      return {
        id: t.id,
        windowId: t.windowId,
        title: t.title || url || "Untitled",
        url,
        favIconUrl: t.favIconUrl || "",
        active: t.active,
        pinned: t.pinned,
        suspended: coldIds.has(t.id), // in the pile's cold tail
        discarded: t.discarded, // Chrome's raw memory state (informational)
        lastAccessed: t.lastAccessed ?? 0,
        rank: i,
        thumb,
      };
    });
  return items;
}

// ---- Thumbnail capture ---------------------------------------------------

async function captureActive(windowId) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!tab || !tab.id) return;
    // captureVisibleTab can't shoot chrome:// / extension pages — skip quietly.
    if (!/^https?:/.test(tab.url || "")) return;
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 55,
    });
    if (dataUrl) {
      await putThumb({ tabId: tab.id, url: tab.url, title: tab.title, dataUrl });
    }
  } catch {
    // Capture races with navigation/permission and throws often; ignore.
  }
}

function scheduleCapture(windowId) {
  clearTimeout(captureTimer);
  captureTimer = setTimeout(() => captureActive(windowId), CAPTURE_DEBOUNCE_MS);
}

// List of open windows for the pile-switcher, each labelled by its active tab.
async function listWindows() {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  return wins
    .map((w) => {
      const tabs = w.tabs.filter((t) => !t.pinned);
      const active = w.tabs.find((t) => t.active);
      return {
        windowId: w.id,
        focused: w.focused,
        count: tabs.length,
        title: active?.title || `${tabs.length} tabs`,
      };
    })
    .sort((a, b) => b.count - a.count);
}

// ---- Warm/cold partition -------------------------------------------------
// A window's tabs split into: pinned (anchors, left alone), the active tab, the
// warmest N by recency (kept in memory + in the strip), and everything else —
// the "cold" tail that gets discarded and, when grouping is on, tucked away.

// Tabs Pile is allowed to manage (group/discard). Excludes pinned tabs, our own
// New Tab page, and chrome:// pages that can't sensibly be grouped.
function isManageable(t) {
  if (t.pinned) return false;
  const u = t.url || t.pendingUrl || "";
  if (u.startsWith("chrome://newtab")) return false;
  if (u.startsWith(chrome.runtime.getURL(""))) return false;
  return true;
}

// Tabs the user explicitly sent to the pile. They're an INPUT to the partition:
// forced cold regardless of recency, until the tab is activated again (which
// removes it). Session-scoped, since tab ids don't survive a relaunch.
async function getPiled() {
  const { piledTabs } = await chrome.storage.session.get("piledTabs");
  return new Set(Array.isArray(piledTabs) ? piledTabs : []);
}
async function addPiled(id) {
  const s = await getPiled();
  s.add(id);
  await chrome.storage.session.set({ piledTabs: [...s] });
}
async function removePiled(id) {
  const s = await getPiled();
  if (s.delete(id)) await chrome.storage.session.set({ piledTabs: [...s] });
}

async function partition(windowId) {
  const all = await chrome.tabs.query({ windowId });
  const warm = await keepWarm(windowId);
  const piled = await getPiled();
  const manageable = all
    .filter(isManageable)
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const active = all.find((t) => t.active);
  const warmIds = new Set();
  if (active && isManageable(active)) warmIds.add(active.id); // active is always warm
  for (const t of manageable) {
    if (warmIds.size >= warm) break;
    if (piled.has(t.id)) continue; // manually sent to pile — never warm
    warmIds.add(t.id);
  }
  return {
    warmTabs: manageable.filter((t) => warmIds.has(t.id)),
    coldTabs: manageable.filter((t) => !warmIds.has(t.id)),
  };
}

async function discardCold(windowId) {
  const { coldTabs } = await partition(windowId);
  for (const t of coldTabs) {
    if (t.audible || t.discarded) continue; // leave audio/already-suspended alone
    await chrome.tabs.discard(t.id).catch(() => {});
  }
}

// ---- Materialized strip: collapse cold tabs into a "Pile" group ----------

const maintainTimers = new Map();
const maintaining = new Set(); // re-entrancy guard per window

// Locate this window's Pile group: trust the cached id, else find one by title.
async function getPileGroup(windowId) {
  const key = `pileGroup:${windowId}`;
  const cached = (await chrome.storage.session.get(key))[key];
  if (cached != null) {
    try {
      await chrome.tabGroups.get(cached);
      return cached;
    } catch {
      /* stale (e.g. after restart) — fall through to search */
    }
  }
  const groups = await chrome.tabGroups.query({ windowId });
  const found = groups.find((g) => (g.title || "").startsWith("Pile"));
  const id = found ? found.id : null;
  await chrome.storage.session.set({ [key]: id });
  return id;
}

async function setPileGroup(windowId, id) {
  await chrome.storage.session.set({ [`pileGroup:${windowId}`]: id });
}

// Bring the strip in line with the warm/cold partition: cold → collapsed group
// (and discarded), warm → loose in the strip. Idempotent, so the tab events our
// own moves generate settle to a no-op rather than looping.
async function reconcileGroup(windowId) {
  const { warmTabs, coldTabs } = await partition(windowId);
  let groupId = await getPileGroup(windowId);

  const toUngroup = warmTabs.filter((t) => groupId != null && t.groupId === groupId).map((t) => t.id);
  if (toUngroup.length) await chrome.tabs.ungroup(toUngroup).catch(() => {});

  // Only absorb tabs that are ungrouped (-1) — never yank a tab out of a group
  // the user made themselves.
  const toGroup = coldTabs.filter((t) => t.groupId === -1).map((t) => t.id);
  if (toGroup.length) {
    groupId = await chrome.tabs.group(
      groupId != null ? { groupId, tabIds: toGroup } : { createProperties: { windowId }, tabIds: toGroup }
    );
    await setPileGroup(windowId, groupId);
  }

  if (groupId != null) {
    const inGroup = await chrome.tabs.query({ groupId }).catch(() => []);
    if (inGroup.length) {
      await chrome.tabGroups
        .update(groupId, { collapsed: true, color: PILE_GROUP_COLOR, title: `Pile · ${inGroup.length}` })
        .catch(() => {});
    } else {
      await setPileGroup(windowId, null); // Chrome auto-removes an emptied group
    }
  }

  for (const t of coldTabs) {
    if (t.audible || t.discarded) continue;
    await chrome.tabs.discard(t.id).catch(() => {});
  }
}

// Dissolve every Pile group (used when the user turns grouping off).
async function unpileAll() {
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  for (const w of wins) {
    const gid = await getPileGroup(w.id);
    if (gid == null) continue;
    const tabs = await chrome.tabs.query({ groupId: gid });
    if (tabs.length) await chrome.tabs.ungroup(tabs.map((t) => t.id)).catch(() => {});
    await setPileGroup(w.id, null);
  }
}

// One pass of upkeep for a window: group+discard, or discard-only.
async function maintainWindow(windowId) {
  if (maintaining.has(windowId)) return;
  maintaining.add(windowId);
  try {
    if (await groupingEnabled()) await reconcileGroup(windowId);
    else await discardCold(windowId);
  } catch {
    /* window may have closed mid-pass */
  } finally {
    maintaining.delete(windowId);
  }
}

function maintainSoon(windowId) {
  if (windowId == null || windowId < 0) return;
  clearTimeout(maintainTimers.get(windowId));
  maintainTimers.set(windowId, setTimeout(() => maintainWindow(windowId), MAINTAIN_DEBOUNCE_MS));
}

// ---- Events --------------------------------------------------------------

chrome.tabs.onActivated.addListener((info) => {
  removePiled(info.tabId); // waking a tab pulls it back out of the pile
  scheduleCapture(info.windowId);
  maintainSoon(info.windowId);
});

chrome.tabs.onCreated.addListener((tab) => maintainSoon(tab.windowId));

chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === "complete" && tab.active) scheduleCapture(tab.windowId);
  // React to loads and pin/unpin, but ignore our own group-membership churn.
  if (info.status === "complete" || info.pinned !== undefined) maintainSoon(tab.windowId);
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  deleteThumb(tabId).catch(() => {});
  removePiled(tabId);
  if (!info.isWindowClosing) maintainSoon(info.windowId);
});

// Discarding a tab can swap its id (Chrome fires onReplaced). Carry our per-tab
// state — piled membership and thumbnail — over to the new id so a suspended tab
// doesn't silently reset to "warm, no screenshot".
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const piled = await getPiled();
  if (piled.has(removedTabId)) {
    piled.delete(removedTabId);
    piled.add(addedTabId);
    await chrome.storage.session.set({ piledTabs: [...piled] });
  }
  await migrateThumb(removedTabId, addedTabId).catch(() => {});
  const tab = await chrome.tabs.get(addedTabId).catch(() => null);
  if (tab) maintainSoon(tab.windowId);
});

// Tabs dragged between windows change both piles.
chrome.tabs.onAttached.addListener((_id, info) => maintainSoon(info.newWindowId));
chrome.tabs.onDetached.addListener((_id, info) => maintainSoon(info.oldWindowId));

// Re-settle every window on launch/install (Chrome restores group state, so the
// "Pile" group is found again by title).
async function maintainAll() {
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  for (const w of wins) maintainSoon(w.id);
}
chrome.runtime.onStartup.addListener(maintainAll);
chrome.runtime.onInstalled.addListener(maintainAll);

// Settings changes: per-window keep-warm (session), or the global default /
// grouping toggle (local). Re-run upkeep on the affected window(s).
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "session") {
    for (const key of Object.keys(changes)) {
      const m = /^keepWarm:(\d+)$/.exec(key);
      if (m) maintainSoon(Number(m[1]));
    }
    return;
  }
  if (area !== "local") return;
  if (changes.groupStrip && changes.groupStrip.newValue === false) await unpileAll();
  if (changes.keepWarm || changes.groupStrip) {
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    for (const w of wins) maintainSoon(w.id);
  }
});

// ---- Messages from the New Tab page --------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "snapshot":
        // Default to the New Tab page's own window; msg.windowId overrides it
        // when the page is peeking at another window's pile.
        sendResponse(await snapshot(msg.windowId ?? sender.tab?.windowId));
        break;
      case "windows":
        sendResponse(await listWindows());
        break;
      case "activate": {
        const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
        if (tab) {
          await chrome.windows.update(tab.windowId, { focused: true });
          await chrome.tabs.update(msg.tabId, { active: true });
        }
        sendResponse({ ok: !!tab });
        break;
      }
      case "close":
        await chrome.tabs.remove(msg.tabId).catch(() => {});
        sendResponse({ ok: true });
        break;
      case "pile": {
        // Deliberately send a warm tab to the pile: mark it, then re-partition.
        const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
        if (tab) {
          await addPiled(msg.tabId);
          maintainSoon(tab.windowId);
        }
        sendResponse({ ok: !!tab });
        break;
      }
      default:
        sendResponse({ error: "unknown message" });
    }
  })();
  return true; // async response
});

// ---- Keyboard: "scroll the pile" ----------------------------------------
// Moves activation one step down/up the LRU order within the focused window.

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "pile-scroll-down" && command !== "pile-scroll-up") return;
  const win = await chrome.windows.getLastFocused({ populate: true });
  if (!win) return;
  const ordered = win.tabs
    .filter((t) => !t.pinned)
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const activeIdx = ordered.findIndex((t) => t.active);
  if (activeIdx < 0) return;
  const delta = command === "pile-scroll-down" ? 1 : -1;
  const next = ordered[activeIdx + delta];
  if (next) await chrome.tabs.update(next.id, { active: true });
});
