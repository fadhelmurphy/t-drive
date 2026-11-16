// Device backup: mirror a folder of this device into "Backup Perangkat" in the drive.
// One way only (device -> T-Drive): nothing is ever deleted from the drive by a scan.
// Needs the File System Access API (desktop Chrome/Edge). Elsewhere a manual "pick files" mode
// uses the same de-duplication.
import { ROOT } from './drive-index.js';

export const BACKUP_FOLDER = 'Backup Dari Perangkat';
const LS_KEY = 'tdrive.backup';
const SKIP = /^(\.|thumbs\.db$|desktop\.ini$|~\$)/i;
const SKIP_EXT = /\.(tmp|crdownload|part|download)$/i;
const SKIP_DIRS = /^(node_modules|__pycache__|\$recycle\.bin|system volume information)$/i;
const tick = () => new Promise((r) => setTimeout(r));

/** A readable default for "which device is this" (browsers cannot tell the real computer name). */
export function guessDeviceName() {
  const ua = globalThis.navigator?.userAgent || '';
  if (/iPhone|iPad/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'PC Windows';
  if (/Macintosh|Mac OS/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'PC Linux';
  return 'Perangkat';
}

/** Run fn over items with at most n in flight. */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

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
  get: (key = 'dir') => kv('readonly', (s) => s.get(key)),
  set: (h, key = 'dir') => kv('readwrite', (s) => s.put(h, key)),
  del: (key = 'dir') => kv('readwrite', (s) => s.delete(key)),
};

/**
 * User exclusion rules, one per line. `/regex/` is tested on the path relative to the watched folder;
 * anything else is a glob: `node_modules` (any folder or file with that name, at any depth),
 * `src/cache` (from the root), `*.log`, `**\/tmp`. Lines starting with # are comments.
 */
export function makeExcluder(text = '') {
  const tests = [];
  const errors = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      if (line.length > 2 && line.startsWith('/') && line.endsWith('/')) {
        const re = new RegExp(line.slice(1, -1), 'i');
        tests.push((path) => re.test(path));
        continue;
      }
      const p = line.replace(/^\.?\//, '').replace(/\/+$/, '');
      const g = p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '.*');
      const re = new RegExp(p.includes('/') ? `^${g}($|/)` : `(^|/)${g}($|/)`, 'i');
      tests.push((path) => re.test(path));
    } catch {
      errors.push(line);
    }
  }
  return { errors, skip: tests.length ? (path) => tests.some((t) => t(path)) : null };
}

/** Recursively list files: [{ path: 'a/b/c.jpg', handle }] (hidden, temporary and dependency folders skipped). */
export async function walk(dir, prefix = '', out = [], onCount = () => {}, errors = [], skip = null) {
  // a folder renamed or deleted while scanning (NotFoundError) is skipped and counted, not fatal
  const root = !prefix;
  try {
    for await (const h of dir.values()) {
      if (SKIP.test(h.name) || SKIP_EXT.test(h.name)) continue;
      if (skip?.(prefix + h.name)) continue; // user exclusion (a skipped folder is not entered at all)
      if (h.kind === 'directory') {
        if (!SKIP_DIRS.test(h.name)) await walk(h, prefix + h.name + '/', out, onCount, errors, skip);
      } else if (h.kind === 'file') {
        out.push({ path: prefix + h.name, handle: h });
        if (out.length % 200 === 0) {
          onCount(out.length);
          await tick(); // keep the page responsive on huge folders
        }
      }
    }
  } catch (e) {
    if (root || e?.name !== 'NotFoundError') throw e;
    errors.push(prefix);
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
    this.cfg = { enabled: false, name: '', folders: [], device: '', open: false, mirrorDelete: false, intervalMin: 15, exclude: '', last: 0, ...this.load() };
    if (!this.cfg.device) this.cfg.device = guessDeviceName();
    // single-folder setups saved by earlier versions become a one-entry list
    if (!this.cfg.folders?.length) this.cfg.folders = this.cfg.name ? [{ key: 'dir', name: this.cfg.name }] : [];
    this.handles = new Map(); // folder key -> FileSystemDirectoryHandle
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

  /** The first watched folder (kept for callers that only know one). */
  get handle() {
    const f = this.cfg.folders[0];
    return (f && this.handles.get(f.key)) || null;
  }
  set handle(h) {
    if (!h) return this.handles.clear();
    const f = this.cfg.folders[0];
    this.handles.set(f ? f.key : 'dir', h);
  }

  /** Called once after the drive is open: continue a backup enabled in an earlier session. */
  async init() {
    if (!this.cfg.enabled) return this.set('off');
    const kept = [];
    for (const f of this.cfg.folders) {
      let h = null;
      try {
        h = (await this.store?.get(f.key)) || null;
      } catch {}
      if (h) {
        this.handles.set(f.key, h);
        kept.push(f);
      }
    }
    this.cfg.folders = kept;
    if (!kept.length) {
      this.cfg.enabled = false;
      this.save();
      return this.set('off');
    }
    this.save();
    await this.resume();
  }

  /** Permission for a stored handle must be re-granted by a click after a reload (browser rule). */
  async resume({ ask = false } = {}) {
    if (!this.handles.size) return;
    let ok = true;
    for (const h of this.handles.values()) {
      let perm = await h.queryPermission?.({ mode: 'read' });
      if (perm !== 'granted' && ask) perm = await h.requestPermission?.({ mode: 'read' });
      if (perm && perm !== 'granted') ok = false;
    }
    if (!ok) return this.set('needs-permission');
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

  /** Watch one more folder: ask for it (must run from a click), then scan. The first call also turns the backup on. */
  async addFolder() {
    const handle = await this.picker();
    for (const h of this.handles.values()) {
      if (h === handle || (await h.isSameEntry?.(handle).catch(() => false))) throw new Error('Folder ini sudah dipantau.');
    }
    const taken = new Set(this.cfg.folders.map((f) => f.name.toLowerCase()));
    let name = handle.name;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${handle.name} (${n})`; // two folders with the same name
    const key = this.cfg.folders.length ? 'f' + Date.now().toString(36) : 'dir';
    this.handles.set(key, handle);
    await this.store?.set(handle, key);
    this.cfg.folders.push({ key, name });
    Object.assign(this.cfg, { enabled: true, name: this.cfg.folders[0].name });
    this.save();
    this.startTimer();
    return this.scan();
  }
  enable() {
    return this.addFolder();
  }

  /** Stop watching one folder; what is already in the drive stays. */
  async removeFolder(key) {
    this.cfg.folders = this.cfg.folders.filter((f) => f.key !== key);
    this.handles.delete(key);
    await this.store?.del(key).catch(() => {});
    if (!this.cfg.folders.length) return this.disable();
    this.cfg.name = this.cfg.folders[0].name;
    this.save();
    this.emit();
  }

  async disable() {
    this.stopTimer();
    this.cfg.enabled = false;
    for (const f of this.cfg.folders) await this.store?.del(f.key).catch(() => {});
    this.cfg.folders = [];
    this.cfg.name = '';
    this.handles.clear();
    this.save();
    this.set('off');
  }

  setOptions({ open, intervalMin, device, mirrorDelete, exclude }) {
    if (exclude !== undefined) this.cfg.exclude = String(exclude);
    if (open !== undefined) this.cfg.open = !!open;
    if (mirrorDelete !== undefined) {
      this.cfg.mirrorDelete = !!mirrorDelete;
      if (!mirrorDelete) this.status = { ...this.status, held: null };
    }
    if (device !== undefined) this.cfg.device = String(device).trim().replace(/[\\/]+/g, '-') || guessDeviceName();
    if (intervalMin) {
      this.cfg.intervalMin = intervalMin;
      if (this.cfg.enabled && this.timer) this.startTimer();
    }
    this.save();
  }

  /** The drive folder holding the copy of the watched folder (undefined until the first upload). */
  backupFolderId(name = this.cfg.folders[0]?.name ?? this.cfg.name) {
    const ix = this.drive.index;
    let cur = ROOT;
    for (const n of [BACKUP_FOLDER, this.cfg.device, name]) {
      cur = ix.children(cur).find((i) => i.type === 'folder' && i.name === n)?.id;
      if (!cur) return undefined;
    }
    return cur;
  }

  /** Scan the watched folders and queue what is new or changed. */
  async scan() {
    if (this.scanning || !this.handles.size) return;
    if (this.uploader.active) return void (this.pending = true);
    this.scanning = true;
    const multi = this.cfg.folders.length > 1;
    const ex = makeExcluder(this.cfg.exclude);
    const total = { found: 0, queued: 0, skipped: 0, changed: 0, trashed: 0 };
    const held = [];
    const problems = [];
    let denied = false;
    try {
      for (const f of this.cfg.folders) {
        const handle = this.handles.get(f.key);
        if (!handle) continue;
        const label = multi ? `${f.name}: ` : '';
        try {
          this.set('scanning', { stage: label + 'Membaca folder', found: total.found });
          const walkErrors = [];
          const found = await walk(handle, '', [], (n) => this.set('scanning', { stage: label + 'Membaca folder', found: total.found + n }), walkErrors, ex.skip);
          this.set('scanning', { stage: label + 'Membaca info file', found: total.found + found.length });
          const entries = [];
          let n = 0;
          let failed = walkErrors.length; // an incomplete listing must never trigger mirror-delete
          await pool(found, 16, async (x) => {
            try {
              entries.push({ path: x.path, file: await x.handle.getFile() });
            } catch {
              failed++; // vanished or locked while scanning
            }
            if (++n % 200 === 0) this.set('scanning', { stage: label + 'Membaca info file', found: total.found + found.length, done: n });
          });
          this.set('scanning', { stage: label + 'Membandingkan dengan drive', found: total.found + entries.length });
          await tick();
          const r = this.queue(entries, [this.cfg.device, f.name]);
          // optional: files that vanished from the device go to the Trash (never deleted for good)
          const m = this.cfg.mirrorDelete ? this.mirror(entries, failed, f.name, ex.skip) : { trashed: 0, held: null };
          total.found += entries.length;
          total.queued += r.queued;
          total.skipped += r.skipped;
          total.changed += r.changed;
          total.trashed += m.trashed;
          if (m.held) held.push(m.held);
        } catch (e) {
          if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') denied = true;
          else if (e?.name === 'NotFoundError') problems.push(`Folder “${f.name}” tidak ditemukan (dihapus, dipindah atau diganti nama). Hapus dari daftar atau pilih lagi.`);
          else problems.push(`“${f.name}”: ${e?.message || e}`);
        }
      }
      if (denied) return this.set('needs-permission');
      if (problems.length === this.cfg.folders.length) return this.set('error', { error: problems.join(' ') });
      this.cfg.last = Date.now();
      this.save();
      const mergedHeld = held.length ? { ids: held.flatMap((x) => x.ids), total: held.reduce((a, x) => a + x.total, 0), empty: held.every((x) => x.empty) } : null;
      this.set('idle', { found: total.found, queued: total.queued, skipped: total.skipped, trashed: total.trashed, held: mergedHeld, warn: problems.join(' ') });
      if (total.queued || total.trashed) this.dispatchEvent(new CustomEvent('queued', { detail: { queued: total.queued, skipped: total.skipped, changed: total.changed, trashed: total.trashed } }));
      return { queued: total.queued, skipped: total.skipped, changed: total.changed, trashed: total.trashed, held: mergedHeld };
    } catch (e) {
      this.set('error', { error: e?.message || String(e) });
    } finally {
      this.scanning = false;
    }
  }

  /** Backed-up files (in this device folder's copy) that no longer exist on the device. */
  staleFiles(entries, name, skip = null) {
    const base = this.backupFolderId(name);
    if (!base) return { stale: [], total: 0 };
    const ix = this.drive.index;
    const seen = new Set(entries.map((e) => e.path.toLowerCase())); // case-insensitive: never trash over a case change
    const files = [];
    const walkDrive = (folder, prefix) => {
      for (const it of ix.children(folder)) {
        if (it.type === 'folder') walkDrive(it.id, prefix + it.name.toLowerCase() + '/');
        else files.push({ id: it.id, path: prefix + it.name.toLowerCase() });
      }
    };
    walkDrive(base, '');
    // excluded paths are left alone: adding a rule later must not send the old copy to the Trash
    return { stale: files.filter((f) => !seen.has(f.path) && !skip?.(f.path)).map((f) => f.id), total: files.length };
  }

  /** Move vanished files to the Trash, with guards against wiping the backup by mistake. */
  mirror(entries, failed, name, skip = null) {
    if (failed) return { trashed: 0, held: null }; // an incomplete scan proves nothing is gone
    const { stale, total } = this.staleFiles(entries, name, skip);
    if (!stale.length) return { trashed: 0, held: null };
    // empty folder (wrong pick, drive unplugged) or a mass vanish: ask before trashing anything
    if (!entries.length || (stale.length > 20 && stale.length > total / 2)) return { trashed: 0, held: { ids: stale, total, empty: !entries.length } };
    this.drive.mutate((x) => x.trashItems(stale));
    return { trashed: stale.length, held: null };
  }

  /** The user confirmed a held mass-trash. */
  confirmHeld() {
    const held = this.status.held;
    if (!held) return;
    const ids = held.ids.filter((id) => this.drive.index.get(id));
    this.drive.mutate((x) => x.trashItems(ids));
    this.set('idle', { trashed: ids.length, held: null });
  }

  /** Manual mode: back up files the user picked (works on any browser, e.g. photos on a phone). */
  backupFiles(files, name = 'Unggahan manual') {
    const entries = [...files].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
    return this.queue(entries, [this.cfg.device, name]);
  }

  /**
   * De-duplicate against the drive (same path, size and modified time) and enqueue uploads.
   * `roots` is the chain below "Backup Dari Perangkat", e.g. [device name, folder name].
   */
  queue(entries, roots) {
    const ix = this.drive.index;
    const open = !!this.cfg.open;
    const busy = new Set(
      this.uploader.tasks.filter((t) => !['done', 'canceled', 'paused'].includes(t.status)).map((t) => `${t.name}|${t.size}|${t.lastModified || 0}`),
    );
    // one pass over the index; looking children up per file would be quadratic on big folders
    const byParent = new Map();
    for (const it of Object.values(ix.items)) {
      if (it.trashed) continue;
      let m = byParent.get(it.parent);
      if (!m) byParent.set(it.parent, (m = new Map()));
      m.set(it.type === 'folder' ? 'd:' + it.name.toLocaleLowerCase() : 'f:' + it.name, it);
    }
    const sub = (parent, name) => byParent.get(parent)?.get('d:' + name.toLocaleLowerCase())?.id;
    const folderCache = new Map();
    const folderOf = (dirs) => {
      const key = dirs.join('/');
      if (folderCache.has(key)) return folderCache.get(key);
      let cur = ROOT;
      for (const d of [BACKUP_FOLDER, ...roots, ...dirs]) {
        cur = cur && sub(cur, d);
        if (!cur) break;
      }
      folderCache.set(key, cur || null);
      return cur || null;
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
      const existing = folder && byParent.get(folder)?.get('f:' + file.name);
      if (existing && sameStamp(existing, file)) skipped++;
      else if (existing) changed.push({ file, id: existing.id });
      else fresh.push({ file, dirs });
    }
    if (!fresh.length && !changed.length) return { queued: 0, skipped, changed: 0 };

    const jobs = fresh.length
      ? this.drive.mutate((x) => {
          const made = new Map(); // folder path -> id, so each folder is resolved once
          const out = [];
          for (const { file, dirs } of fresh) {
            const key = dirs.join('/');
            if (!made.has(key)) {
              let cur = ROOT;
              for (const d of [BACKUP_FOLDER, ...roots, ...dirs]) cur = x.ensureFolder(d, cur).id;
              made.set(key, cur);
            }
            out.push({ file, parent: made.get(key) });
          }
          return out;
        })
      : [];
    if (jobs.length) this.uploader.add(jobs, { open, backup: true }); // a paused upload of the same file continues here
    for (const c of changed) this.uploader.add([{ file: c.file, parent: ROOT }], { open, replaceId: c.id, backup: true });
    return { queued: fresh.length + changed.length, skipped, changed: changed.length };
  }
}
