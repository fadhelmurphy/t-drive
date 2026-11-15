// Device backup: mirror a folder of this device into "Backup Perangkat" in the drive.
// One way only (device -> T-Drive): nothing is ever deleted from the drive by a scan.
// Needs the File System Access API (desktop Chrome/Edge). Elsewhere a manual "pick files" mode
// uses the same de-duplication.
import { ROOT } from './drive-index.js';

export const BACKUP_FOLDER = 'Backup Perangkat';
const LS_KEY = 'tdrive.backup';
const SKIP = /^(\.|thumbs\.db$|desktop\.ini$|~\$)/i;
const SKIP_EXT = /\.(tmp|crdownload|part|download)$/i;

export const supportsFolderWatch = () => typeof globalThis.showDirectoryPicker === 'function' && !!globalThis.indexedDB;

// ---- tiny IndexedDB store for the directory handle (handles are structured-cloneable)
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('tdrive-backup', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kv(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}
const handleStore = {
  get: () => kv('readonly', (s) => s.get('dir')),
  set: (h) => kv('readwrite', (s) => s.put(h, 'dir')),
  del: () => kv('readwrite', (s) => s.delete('dir')),
};

/** Recursively list files: [{ path: 'a/b/c.jpg', file }] (hidden/temporary files skipped). */
export async function walk(dir, prefix = '', out = []) {
  for await (const h of dir.values()) {
    if (SKIP.test(h.name) || SKIP_EXT.test(h.name)) continue;
    if (h.kind === 'directory') await walk(h, prefix + h.name + '/', out);
    else if (h.kind === 'file') out.push({ path: prefix + h.name, handle: h });
  }
  return out;
}

const sameStamp = (it, file) => it.size === file.size && Math.abs((it.modified || 0) - (file.lastModified || 0)) < 2000;

export class BackupManager extends EventTarget {
  /**
   * @param {{drive, uploader, storage?: Storage, store?: object, picker?: Function}} o
   * `store` and `picker` exist so tests can run without a browser.
   */
  constructor({ drive, uploader, storage = globalThis.localStorage, store = null, picker = null }) {
    super();
    this.drive = drive;
    this.uploader = uploader;
    this.storage = storage;
    this.store = store || (globalThis.indexedDB ? handleStore : null);
    this.picker = picker || (() => globalThis.showDirectoryPicker({ id: 'tdrive-backup', mode: 'read' }));
    this.cfg = { enabled: false, name: '', open: false, intervalMin: 15, last: 0, ...this.load() };
    this.handle = null;
    this.status = { state: 'off', found: 0, queued: 0, skipped: 0, error: '' };
    this.timer = null;
    this.scanning = false;
    this.pending = false;
    // a scan that had to wait for running uploads starts once they finish
    this.uploader.addEventListener?.('change', () => {
      if (this.pending && !this.uploader.active) {
        this.pending = false;
        this.scan();
      }
    });
    this.onVisible = () => globalThis.document?.visibilityState === 'visible' && this.cfg.enabled && this.scan();
  }

  load() {
    try {
      return JSON.parse(this.storage?.getItem(LS_KEY)) || {};
    } catch {
      return {};
    }
  }
  save() {
    try {
      this.storage?.setItem(LS_KEY, JSON.stringify(this.cfg));
    } catch {}
    this.emit();
  }
  emit() {
    this.dispatchEvent(new Event('change'));
  }
  set(state, extra = {}) {
    this.status = { ...this.status, state, error: '', ...extra };
    this.emit();
  }

  /** Called once after the drive is open: continue a backup enabled in an earlier session. */
  async init() {
    if (!this.cfg.enabled) return this.set('off');
    try {
      this.handle = (await this.store?.get()) || null;
    } catch {
      this.handle = null;
    }
    if (!this.handle) {
      this.cfg.enabled = false;
      this.save();
      return this.set('off');
    }
    await this.resume();
  }

  /** Permission for a stored handle must be re-granted by a click after a reload (browser rule). */
  async resume({ ask = false } = {}) {
    if (!this.handle) return;
    let perm = await this.handle.queryPermission?.({ mode: 'read' });
    if (perm !== 'granted' && ask) perm = await this.handle.requestPermission?.({ mode: 'read' });
    if (perm && perm !== 'granted') return this.set('needs-permission');
    this.startTimer();
    return this.scan();
  }

  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => globalThis.document?.visibilityState !== 'hidden' && this.scan(), Math.max(1, this.cfg.intervalMin) * 60000);
    globalThis.document?.addEventListener('visibilitychange', this.onVisible);
  }
  stopTimer() {
    clearInterval(this.timer);
    this.timer = null;
    globalThis.document?.removeEventListener('visibilitychange', this.onVisible);
  }
  destroy() {
    this.stopTimer();
  }

  /** Turn on: ask for the folder (must run from a click), then start scanning. */
  async enable() {
    const handle = await this.picker();
    this.handle = handle;
    await this.store?.set(handle);
    Object.assign(this.cfg, { enabled: true, name: handle.name });
    this.save();
    this.startTimer();
    return this.scan();
  }

  async disable() {
    this.stopTimer();
    this.cfg.enabled = false;
    this.handle = null;
    await this.store?.del().catch(() => {});
    this.save();
    this.set('off');
  }

  setOptions({ open, intervalMin }) {
    if (open !== undefined) this.cfg.open = !!open;
    if (intervalMin) {
      this.cfg.intervalMin = intervalMin;
      if (this.cfg.enabled && this.timer) this.startTimer();
    }
    this.save();
  }

  /** The drive folder holding this device folder's copy (undefined until the first upload). */
  backupFolderId(name = this.cfg.name) {
    const ix = this.drive.index;
    const top = ix.children(ROOT).find((i) => i.type === 'folder' && i.name === BACKUP_FOLDER);
    return top && ix.children(top.id).find((i) => i.type === 'folder' && i.name === name)?.id;
  }

  /** Scan the watched folder and queue what is new or changed. */
  async scan() {
    if (this.scanning || !this.handle) return;
    if (this.uploader.active) return void (this.pending = true);
    this.scanning = true;
    this.set('scanning');
    try {
      const found = await walk(this.handle);
      const entries = [];
      for (const f of found) {
        try {
          entries.push({ path: f.path, file: await f.handle.getFile() });
        } catch {} // vanished or locked while scanning
      }
      const r = this.queue(entries, this.cfg.name);
      this.cfg.last = Date.now();
      this.save();
      this.set('idle', { found: entries.length, queued: r.queued, skipped: r.skipped });
      if (r.queued) this.dispatchEvent(new CustomEvent('queued', { detail: r }));
      return r;
    } catch (e) {
      const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
      this.set(denied ? 'needs-permission' : 'error', { error: e?.message || String(e) });
    } finally {
      this.scanning = false;
    }
  }

  /** Manual mode: back up files the user picked (works on any browser, e.g. photos on a phone). */
  backupFiles(files, name = 'Unggahan manual') {
    const entries = [...files].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
    return this.queue(entries, name);
  }

  /** De-duplicate against the drive (same path, size and modified time) and enqueue uploads. */
  queue(entries, deviceName) {
    const ix = this.drive.index;
    const open = !!this.cfg.open;
    const busy = new Set(
      this.uploader.tasks.filter((t) => !['done', 'canceled'].includes(t.status)).map((t) => `${t.name}|${t.size}|${t.lastModified || 0}`),
    );
    const find = (parent, name) => ix.children(parent).find((i) => i.type === 'file' && i.name === name);
    // existing folder for a path, or null (nothing is created while only checking)
    const folderOf = (dirs) => {
      let cur = ROOT;
      for (const d of [BACKUP_FOLDER, deviceName, ...dirs]) {
        cur = ix.children(cur).find((i) => i.type === 'folder' && i.name.toLocaleLowerCase() === d.toLocaleLowerCase())?.id;
        if (!cur) return null;
      }
      return cur;
    };

    const fresh = [];
    const changed = [];
    let skipped = 0;
    for (const { path, file } of entries) {
      if (busy.has(`${file.name}|${file.size}|${file.lastModified || 0}`)) {
        skipped++;
        continue;
      }
      const dirs = path.split('/').slice(0, -1).filter(Boolean);
      const folder = folderOf(dirs);
      const existing = folder && find(folder, file.name);
      if (existing && sameStamp(existing, file)) skipped++;
      else if (existing) changed.push({ file, dirs, id: existing.id });
      else fresh.push({ file, dirs });
    }
    if (!fresh.length && !changed.length) return { queued: 0, skipped, changed: 0 };

    const jobs = this.drive.mutate((x) => {
      const out = [];
      for (const { file, dirs } of fresh) {
        let cur = x.ensureFolder(BACKUP_FOLDER, ROOT).id;
        for (const d of [deviceName, ...dirs]) cur = x.ensureFolder(d, cur).id;
        out.push({ file, parent: cur });
      }
      return out;
    });
    if (jobs.length) this.uploader.add(jobs, { open });
    for (const c of changed) this.uploader.add([{ file: c.file, parent: ROOT }], { open, replaceId: c.id });
    return { queued: fresh.length + changed.length, skipped, changed: changed.length };
  }
}
