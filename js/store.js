// This browser's own storage for labs that run in it (IndexedDB): nothing leaves the machine.
//   labs   one record per lab: its inputs, the built lab, ratings, whole-song renders
//   files  MIDI bytes, keyed "<lab>/<file>"
//   meta   the visitor's own soundfont, if they picked one (else the built-in plays)
const DB = "rearranged";
let opening = null;

function open() {
  opening = opening || new Promise((ok, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("labs", { keyPath: "id" });
      db.createObjectStore("files");
      db.createObjectStore("meta");
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
  return opening;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((ok, fail) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => ok(req?.result);
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);
  });
}

export const store = {
  get: (s, key) => run(s, "readonly", (o) => o.get(key)),
  put: (s, value, key) => run(s, "readwrite", (o) => (key === undefined ? o.put(value) : o.put(value, key))),
  del: (s, key) => run(s, "readwrite", (o) => o.delete(key)),
  all: (s) => run(s, "readonly", (o) => o.getAll()),
  /** every key starting with `prefix` removed (a lab's files) */
  async clear(s, prefix) {
    const db = await open();
    return new Promise((ok, fail) => {
      const tx = db.transaction(s, "readwrite");
      const range = IDBKeyRange.bound(prefix, prefix + "￿");
      tx.objectStore(s).delete(range);
      tx.oncomplete = () => ok();
      tx.onerror = () => fail(tx.error);
    });
  },
};
