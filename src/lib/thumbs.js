// Tiny IndexedDB wrapper for tab thumbnails.
// Thumbnails are large (data URLs), so they live in IndexedDB rather than
// chrome.storage. Keyed by tabId; a stored record also carries the url/title
// so the New Tab page can show a sensible placeholder if the shot is stale.

const DB_NAME = "pile";
const STORE = "thumbs";
const MAX_THUMBS = 250; // opportunistic cap so the DB can't grow unbounded

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "tabId" });
        os.createIndex("ts", "ts");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function putThumb(record) {
  const db = await open();
  await new Promise((res, rej) => {
    const r = tx(db, "readwrite").put({ ...record, ts: Date.now() });
    r.onsuccess = res;
    r.onerror = () => rej(r.error);
  });
  evict(db); // fire-and-forget
}

export async function getAllThumbs() {
  const db = await open();
  return new Promise((res, rej) => {
    const r = tx(db, "readonly").getAll();
    r.onsuccess = () => {
      const map = new Map();
      for (const rec of r.result) map.set(rec.tabId, rec);
      res(map);
    };
    r.onerror = () => rej(r.error);
  });
}

export async function deleteThumb(tabId) {
  const db = await open();
  tx(db, "readwrite").delete(tabId);
}

// Move a thumbnail to a new tab id (Chrome can swap ids when discarding a tab).
export async function migrateThumb(oldId, newId) {
  const db = await open();
  const store = tx(db, "readwrite");
  const get = store.get(oldId);
  get.onsuccess = () => {
    const rec = get.result;
    if (!rec) return;
    store.put({ ...rec, tabId: newId });
    store.delete(oldId);
  };
}

// Keep only the newest MAX_THUMBS records.
async function evict(db) {
  const idx = tx(db, "readonly").index("ts");
  const countReq = idx.count();
  countReq.onsuccess = () => {
    const over = countReq.result - MAX_THUMBS;
    if (over <= 0) return;
    const delStore = tx(db, "readwrite").index("ts");
    let removed = 0;
    delStore.openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur || removed >= over) return;
      cur.delete();
      removed++;
      cur.continue();
    };
  };
}
