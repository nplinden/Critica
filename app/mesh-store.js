// Persistent mesh cache in IndexedDB: the built parts of top-level items,
// keyed by item-keys.js, so reloading an unchanged scene shows it at once.
// Entries are evicted least recently used beyond `maxBytes`.
//
//   const store = await openMeshStore();        // null without IndexedDB
//   const found = await store.getMany(keys);    // Map<key, parts>
//   store.put(key, parts); store.clear(); store.bytes

const bytesOf = (parts) =>
  parts.reduce((n, p) => n + (p.mesh ? p.mesh.positions.byteLength + p.mesh.normals.byteLength + p.mesh.tags.byteLength + p.mesh.indices.byteLength : 0) + (p.leaves?.byteLength ?? 0), 0);

const request = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export async function openMeshStore({ name = "critica-mesh-cache", maxBytes = 300 * 2 ** 20 } = {}) {
  if (!globalThis.indexedDB) return null;
  let db;
  try {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("data");
      open.result.createObjectStore("meta");
    };
    db = await request(open);
  } catch {
    return null; // private mode, blocked storage
  }
  // Sizes and last use of every entry (small), for eviction.
  const meta = new Map();
  try {
    const tx = db.transaction("meta", "readonly").objectStore("meta");
    const [keys, values] = await Promise.all([request(tx.getAllKeys()), request(tx.getAll())]);
    keys.forEach((k, i) => meta.set(k, values[i]));
  } catch {
    // Unreadable metadata: start empty.
  }
  let total = [...meta.values()].reduce((n, m) => n + m.bytes, 0);
  let broken = false;

  function touch(keys) {
    const now = Date.now();
    try {
      const store = db.transaction("meta", "readwrite").objectStore("meta");
      for (const k of keys) {
        const m = meta.get(k);
        if (!m) continue;
        m.used = now;
        store.put(m, k);
      }
    } catch {
      // Best effort.
    }
  }

  function evict() {
    if (total <= maxBytes) return;
    const oldest = [...meta].sort((a, b) => a[1].used - b[1].used);
    const tx = db.transaction(["data", "meta"], "readwrite");
    for (const [k, m] of oldest) {
      if (total <= maxBytes * 0.8) break;
      tx.objectStore("data").delete(k);
      tx.objectStore("meta").delete(k);
      meta.delete(k);
      total -= m.bytes;
    }
  }

  return {
    get bytes() {
      return total;
    },
    get entries() {
      return meta.size;
    },
    /** The cached parts of the `keys` found in the store. */
    async getMany(keys) {
      const found = new Map();
      const wanted = keys.filter((k) => meta.has(k));
      if (broken || !wanted.length) return found;
      try {
        const store = db.transaction("data", "readonly").objectStore("data");
        const values = await Promise.all(wanted.map((k) => request(store.get(k))));
        wanted.forEach((k, i) => values[i] && found.set(k, values[i]));
        touch([...found.keys()]);
      } catch {
        // A failed read is a miss.
      }
      return found;
    },
    put(key, parts) {
      if (broken || meta.has(key)) return;
      const bytes = bytesOf(parts);
      const m = { bytes, used: Date.now() };
      try {
        const tx = db.transaction(["data", "meta"], "readwrite");
        tx.objectStore("data").put(parts, key);
        tx.objectStore("meta").put(m, key);
        tx.onerror = () => {
          // Quota exceeded or similar: stop caching for this session.
          broken = true;
        };
        meta.set(key, m);
        total += bytes;
        evict();
      } catch {
        broken = true;
      }
    },
    async clear() {
      const tx = db.transaction(["data", "meta"], "readwrite");
      tx.objectStore("data").clear();
      tx.objectStore("meta").clear();
      await new Promise((resolve) => (tx.oncomplete = resolve));
      meta.clear();
      total = 0;
    },
  };
}
