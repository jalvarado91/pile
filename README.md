# Pile

A New Tab page that treats your open tabs as an **LRU pile**: what you touched most
recently sits on top, older "sessions" stay browsable underneath, and cold tabs get
suspended to save memory.

This is the first of several tab mental-model experiments.

## The model

- **One pile per window.** A pile is scoped to its own window — each window is a
  separate "session". A tucked-away scope switcher (top-left, only appears when you have
  more than one window) lets you *peek* at another window's pile and jump into it; clicking
  a tab there focuses that window.
- **Order = recency.** Tabs are sorted by Chrome's own `lastAccessed`, so the pile
  survives service-worker restarts with no bookkeeping. cmd+clicking links opens fresh
  tabs that land near the top — "thrown on the pile."
- **Recency tiers.** The pile is split into rolling buckets — *Just now / Past hour /
  Today / Yesterday / This week / Older* — so it reads as a cache with layers, not one
  long sorted list.
- **Pinned tabs are anchors, not pile.** They render in their own **Pinned** row at the
  top (accent-edged chips, both views), sit outside the recency buckets, and are never
  suspended or counted toward the keep-warm budget.
- **Warm vs Pile split.** Each view separates the **Warm** set (materialized top-N, flat)
  from **The Pile** (the suspended tail, recency-bucketed). The pile's own header carries a
  subtle switcher (`—` / `▢` / `≡`) for how strongly it's separated:
  - **Rule** — a divider; the pile recedes via its dim state.
  - **Recessed** — the pile drops into a sunken panel.
  - **Condensed** — the pile shrinks to compact, thumbnail-less items.
- **Two views** of the same pile:
  - **List** — Linear-style dense rows with host + recency. The demo spine.
  - **Grid** — iOS-Photos-style thumbnails (captured opportunistically as you visit tabs;
    older tabs you haven't revisited fall back to favicon cards).
- **Memory:** tabs past a keep-warm horizon are `discard()`ed. The threshold is
  **adjustable per window** in the ⚙ settings menu (default 10); lowering it suspends the
  newly-cold tabs immediately. Discarding is non-destructive — the tab reloads on activation.
  The header shows a live `N warm · M suspended` readout so you can see it working.
- **Materialized strip (⚙ "Declutter strip", on by default).** The cold tail is collapsed
  into a native **`Pile · N`** tab group and discarded, so the real tab bar shows just your
  pinned + warm tabs + one chip — and it *reacts*: open a tab and something drops into the
  group, close one and a cold tab is promoted back out. Tabs you've grouped yourself are
  left untouched. Turn it off and the pile ungroups cleanly (tabs stay, just un-collapsed).

## Install

Pile isn't on the Chrome Web Store (yet), so it installs as an **unpacked
extension** — about a minute of setup.

**Option A — download a release (easiest)**

1. Download the latest `pile-vX.Y.Z.zip` from the
   [Releases page](https://github.com/jalvarado91/pile/releases) and unzip it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and pick the unzipped `pile` folder (the one containing
   `manifest.json`).
5. Open a new tab — that's the pile.

**Option B — from source**

```bash
git clone https://github.com/jalvarado91/pile.git
```

Then follow steps 2–5 above, selecting the cloned folder.

### Good to know

- On launch Chrome may warn about "extensions running in developer mode" — that's
  normal for any unpacked extension. Keep Pile enabled.
- Pile requests **read your data on all sites**. It's used only to screenshot the
  active tab for the grid view; nothing leaves your machine (thumbnails live in local
  IndexedDB).
- **Keyboard:** ⌘⇧↓ / ⌘⇧↑ step down/up the pile (rebind at
  `chrome://extensions/shortcuts`).
- **Updating:** replace the folder with a newer release and click the ↻ reload icon on
  Pile's card in `chrome://extensions`.

## Architecture

| Piece | File | Role |
|-------|------|------|
| Service worker | `src/background/service-worker.js` | LRU snapshot, thumbnail capture, discard cold tabs, message API, keyboard commands |
| Thumbnail store | `src/lib/thumbs.js` | IndexedDB cache of JPEG thumbnails, capped + evicted |
| New Tab page | `src/newtab/` | Grid/List rendering, filter, activate/close/suspend |

State that must persist lives in Chrome (`lastAccessed`, IndexedDB) — never in
service-worker globals, which are ephemeral in MV3.

## Deferred (on purpose)

Two Oracle consults shaped these calls:

- **Strip virtualization via `chrome.tabs.hide` — dropped, not just deferred.** Hidden tabs
  keep running, so hide buys *zero* memory (that's `discard`'s job) while adding real risk:
  it can't intercept native `⌘⇧[`/`]`, a cross-window LRU can drive a window's visible count
  to zero ("window appears closed"), and every relaunch flashes ~70 tabs into the strip
  before the worker re-hides them. Discard delivers 100% of the memory goal with none of it.
- **Decluttering the real strip → collapsed `chrome.tabGroups`** *(now built — see
  "Materialized strip" above).* A native "Pile · N" chip that survives restart, with no
  `tabHide` permission or window-closed risk. This was the Oracle's recommended path over
  `tabs.hide`, and it's what makes the strip react to the warm/cold set.
- **From-anywhere switcher HUD → deferred.** `chrome.commands` has no keyup event, so a
  literal ⌘-Tab hold/release is unbuildable for the opening keystroke, and an injected
  overlay dies on `chrome://`, the Web Store, and PDFs. A cheap positional toast on each
  scroll command ("4 of 62 · yesterday 2:14pm") is the next thing to build; the full HUD
  only if the toast doesn't feel like enough.

Known gap (say it out loud): discard-only does **not** declutter the crowded tab strip — it
just grays cold tabs. That's the price of the safe path; `tabGroups` collapse is the fix.
