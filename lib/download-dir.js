const DB_NAME = "hls-downloader";
const DB_VERSION = 1;
const STORE = "handles";
const KEY = "defaultDir";
const PICKER_ID = "hls-default-dir";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB 打开失败"));
  });
}

function idbOp(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let req;
        try {
          req = fn(store);
        } catch (err) {
          db.close();
          reject(err);
          return;
        }
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
}

function idbGet(key) {
  return idbOp("readonly", (store) => store.get(key));
}

function idbSet(key, value) {
  return idbOp("readwrite", (store) => store.put(value, key));
}

function idbDelete(key) {
  return idbOp("readwrite", (store) => store.delete(key));
}

export function dirDisplayName(handle) {
  return handle?.name || "";
}

export async function loadDefaultDir() {
  try {
    return (await idbGet(KEY)) || null;
  } catch {
    return null;
  }
}

export async function saveDefaultDir(handle) {
  await idbSet(KEY, handle);
}

export async function clearDefaultDir() {
  await idbDelete(KEY);
}

async function permissionState(handle) {
  if (!handle?.queryPermission) return "denied";
  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

export async function ensureDirPermission(handle) {
  if (!handle) return null;
  let state = await permissionState(handle);
  if (state === "granted") return handle;
  if (state === "prompt" && handle.requestPermission) {
    try {
      state = await handle.requestPermission({ mode: "readwrite" });
    } catch {
      return null;
    }
  }
  return state === "granted" ? handle : null;
}

export async function getAuthorizedDefaultDir() {
  const handle = await loadDefaultDir();
  if (!handle) return null;
  const ok = await ensureDirPermission(handle);
  if (ok) return ok;
  await clearDefaultDir();
  return null;
}

export async function pickDefaultDir() {
  const handle = await window.showDirectoryPicker({
    id: PICKER_ID,
    mode: "readwrite",
  });
  const ok = await ensureDirPermission(handle);
  if (!ok) throw new Error("未获得该文件夹的写入权限。");
  await saveDefaultDir(ok);
  return ok;
}

export async function uniqueFileName(dir, filename) {
  const lastDot = filename.lastIndexOf(".");
  const stem = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  const ext = lastDot > 0 ? filename.slice(lastDot) : "";
  let candidate = filename;
  for (let n = 2; n < 1000; n += 1) {
    try {
      await dir.getFileHandle(candidate);
      candidate = `${stem} (${n})${ext}`;
    } catch (err) {
      if (err?.name === "NotFoundError") return candidate;
      throw err;
    }
  }
  return `${stem} (${Date.now()})${ext}`;
}

export async function createFileInDir(dir, filename) {
  const name = await uniqueFileName(dir, filename);
  const fileHandle = await dir.getFileHandle(name, { create: true });
  return {
    fileHandle,
    writable: await fileHandle.createWritable(),
    name,
  };
}

export function materialWriterForDir(dir) {
  return {
    async writeText(name, text) {
      const unique = await uniqueFileName(dir, name);
      const handle = await dir.getFileHandle(unique, { create: true });
      const writer = await handle.createWritable();
      await writer.write(text);
      await writer.close();
    },
    async writeBytes(name, bytes) {
      const unique = await uniqueFileName(dir, name);
      const handle = await dir.getFileHandle(unique, { create: true });
      const writer = await handle.createWritable();
      await writer.write(bytes);
      await writer.close();
    },
  };
}
