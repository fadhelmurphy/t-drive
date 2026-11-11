// Pure, in-memory model of the drive's folder tree. No I/O here so it can be unit tested.
import { uid } from './util.js';

export const ROOT = 'root';

export class DriveIndex {
  constructor(data) {
    this.data = data && data.v === 1 ? data : { v: 1, items: {} };
  }

  get items() {
    return this.data.items;
  }

  get(id) {
    return this.items[id];
  }

  /** True when the item and all of its ancestors are not in the trash. */
  isLive(id) {
    let cur = this.get(id);
    while (cur) {
      if (cur.trashed) return false;
      if (cur.parent === ROOT) return true;
      cur = this.get(cur.parent);
    }
    return false;
  }

  children(parent) {
    return Object.values(this.items).filter((it) => it.parent === parent && !it.trashed);
  }

  liveFiles() {
    return Object.values(this.items).filter((it) => it.type === 'file' && this.isLive(it.id));
  }

  recent(limit = 100) {
    return this.liveFiles()
      .sort((a, b) => b.modified - a.modified)
      .slice(0, limit);
  }

  starred() {
    return Object.values(this.items).filter((it) => it.starred && this.isLive(it.id));
  }

  /** Top-level trashed items (their parent is not trashed itself). */
  trash() {
    return Object.values(this.items).filter((it) => it.trashed && !this.inTrash(it.parent));
  }

  inTrash(id) {
    let cur = this.get(id);
    while (cur) {
      if (cur.trashed) return true;
      cur = this.get(cur.parent);
    }
    return false;
  }

  search(q) {
    const needle = q.trim().toLocaleLowerCase();
    if (!needle) return [];
    return Object.values(this.items).filter((it) => it.name.toLocaleLowerCase().includes(needle) && this.isLive(it.id));
  }

  /** Breadcrumb from root to `id` (inclusive). */
  path(id) {
    const out = [];
    let cur = this.get(id);
    while (cur) {
      out.unshift(cur);
      cur = this.get(cur.parent);
    }
    return out;
  }

  descendants(id) {
    const out = [];
    const stack = [id];
    while (stack.length) {
      const p = stack.pop();
      for (const it of Object.values(this.items)) {
        if (it.parent === p) {
          out.push(it);
          if (it.type === 'folder') stack.push(it.id);
        }
      }
    }
    return out;
  }

  stats() {
    let size = 0;
    let count = 0;
    for (const f of this.liveFiles()) {
      size += f.size;
      count++;
    }
    return { size, count };
  }

  validName(name) {
    const n = String(name ?? '').trim();
    if (!n) throw new Error('Nama tidak boleh kosong');
    if (n.length > 255) throw new Error('Nama terlalu panjang');
    if (/[/\\]/.test(n)) throw new Error('Nama tidak boleh mengandung / atau \\');
    return n;
  }

  uniqueName(parent, name, excludeId) {
    const taken = new Set(
      this.children(parent)
        .filter((it) => it.id !== excludeId)
        .map((it) => it.name.toLocaleLowerCase()),
    );
    if (!taken.has(name.toLocaleLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const hasExt = dot > 0 && dot > name.length - 10;
    const stem = hasExt ? name.slice(0, dot) : name;
    const ext = hasExt ? name.slice(dot) : '';
    for (let i = 1; ; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
    }
  }

  assertFolder(parent) {
    if (parent === ROOT) return;
    const p = this.get(parent);
    if (!p || p.type !== 'folder' || !this.isLive(parent)) throw new Error('Folder tujuan tidak ditemukan');
  }

  createFolder(name, parent = ROOT) {
    this.assertFolder(parent);
    const now = Date.now();
    const item = {
      id: uid(),
      type: 'folder',
      name: this.uniqueName(parent, this.validName(name)),
      parent,
      created: now,
      modified: now,
      starred: false,
      trashed: false,
    };
    this.items[item.id] = item;
    return item;
  }

  /** Find a live child folder by name, or create it. */
  ensureFolder(name, parent) {
    const n = this.validName(name);
    const existing = this.children(parent).find(
      (it) => it.type === 'folder' && it.name.toLocaleLowerCase() === n.toLocaleLowerCase(),
    );
    return existing || this.createFolder(n, parent);
  }

  addFile({ name, parent = ROOT, size, mime, key, nonce, parts, lastModified, open = false }) {
    this.assertFolder(parent);
    const now = Date.now();
    const item = {
      id: uid(),
      type: 'file',
      name: this.uniqueName(parent, this.validName(name)),
      parent,
      size,
      mime: mime || 'application/octet-stream',
      ...(open ? { open: true } : { key, nonce }),
      parts,
      created: now,
      modified: lastModified || now,
      uploaded: now,
      starred: false,
      trashed: false,
    };
    this.items[item.id] = item;
    return item;
  }

  rename(id, name) {
    const it = this.get(id);
    if (!it) throw new Error('Item tidak ditemukan');
    it.name = this.uniqueName(it.parent, this.validName(name), id);
    it.modified = Date.now();
    return it;
  }

  move(ids, parent) {
    this.assertFolder(parent);
    for (const id of ids) {
      const it = this.get(id);
      if (!it || it.parent === parent) continue;
      if (id === parent || (it.type === 'folder' && this.path(parent).some((a) => a.id === id))) {
        throw new Error(`Tidak bisa memindahkan "${it.name}" ke dalam dirinya sendiri`);
      }
      it.parent = parent;
      it.name = this.uniqueName(parent, it.name, id);
    }
  }

  setStarred(ids, value) {
    for (const id of ids) if (this.get(id)) this.get(id).starred = !!value;
  }

  trashItems(ids) {
    const now = Date.now();
    for (const id of ids) {
      const it = this.get(id);
      if (it) {
        it.trashed = true;
        it.trashedAt = now;
      }
    }
  }

  restore(ids) {
    for (const id of ids) {
      const it = this.get(id);
      if (!it) continue;
      it.trashed = false;
      delete it.trashedAt;
      if (it.parent !== ROOT && !this.isLive(it.parent)) it.parent = ROOT;
      it.name = this.uniqueName(it.parent, it.name, id);
    }
  }

  /** Remove items (and descendants). Returns Telegram message ids to delete. */
  removeForever(ids) {
    const msgIds = [];
    const doomed = new Set();
    for (const id of ids) {
      if (!this.get(id)) continue;
      doomed.add(id);
      for (const d of this.descendants(id)) doomed.add(d.id);
    }
    for (const id of doomed) {
      const it = this.get(id);
      if (it?.parts) msgIds.push(...it.parts);
      delete this.items[id];
    }
    return msgIds;
  }

  emptyTrash() {
    return this.removeForever(Object.values(this.items).filter((it) => it.trashed).map((it) => it.id));
  }
}
