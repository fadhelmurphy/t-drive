// "Ingat passphrase 1 jam": the passphrase is kept encrypted in localStorage with a
// non-extractable AES key that lives in IndexedDB, and expires after a fixed time.
// It only spares retyping on reload; locking or logging out forgets it immediately.
import { fromB64, toB64 } from './crypto.js';

const LS_KEY = 'tdrive.remember';
const DB = 'tdrive-keys';
const STORE = 'k';
const KEY_ID = 'remember';
export const REMEMBER_MS = 60 * 60 * 1000;

const openDb = () =>
  new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

async function getKey(create) {
  const db = await openDb();
  try {
    const existing = await new Promise((resolve, reject) => {
      const q = db.transaction(STORE).objectStore(STORE).get(KEY_ID);
      q.onsuccess = () => resolve(q.result || null);
      q.onerror = () => reject(q.error);
    });
    if (existing || !create) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(key, KEY_ID);
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
    return key;
  } finally {
    db.close();
  }
}

/** Remember `passphrase` for `ttl` ms. Returns false if the browser cannot store it. */
export async function rememberPassphrase(passphrase, ttl = REMEMBER_MS) {
  try {
    const key = await getKey(true);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(passphrase)));
    localStorage.setItem(LS_KEY, JSON.stringify({ iv: toB64(iv), ct: toB64(ct), exp: Date.now() + ttl }));
    return true;
  } catch {
    return false;
  }
}

/** The remembered passphrase, or null when none / expired / unreadable. */
export async function recallPassphrase() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!raw) return null;
    if (!(raw.exp > Date.now())) {
      await forgetPassphrase();
      return null;
    }
    const key = await getKey(false);
    if (!key) {
      await forgetPassphrase();
      return null;
    }
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(raw.iv) }, key, fromB64(raw.ct));
    return new TextDecoder().decode(plain);
  } catch {
    await forgetPassphrase();
    return null;
  }
}

export async function forgetPassphrase() {
  try {
    localStorage.removeItem(LS_KEY);
    await new Promise((resolve) => {
      const r = indexedDB.deleteDatabase(DB);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
  } catch {
    /* nothing to forget */
  }
}
