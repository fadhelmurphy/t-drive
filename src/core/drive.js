// Persistence of the encrypted drive index inside the Telegram storage channel.
// The index is sealed with the passphrase key and kept as the channel's pinned document.
import { DriveIndex, ROOT } from './drive-index.js';
import { deriveKey, randomBytes, readSealedSalt, seal, unseal } from './crypto.js';
import { CIPHER_BLOCK, LAYOUT, TG_BIG_FILE, TG_UPLOAD_PART } from './blocks.js';
import { withRetry } from './tg.js';
import { Mutex } from './util.js';

export const INDEX_NAME = 't-drive-index.bin';
export const IMPORT_FOLDER = 'Dari Telegram';

/** Photos have no file name in Telegram: "Foto 2026-11-11 20.16.jpg". */
function photoName(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `Foto ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.jpg`;
}

/** Names T-Drive itself gives to the blobs it uploads (the index and obfuscated encrypted parts). */
export const isOwnBlob = (name) => name === INDEX_NAME || /^[0-9a-z]{16}\.bin$/.test(name || '');

export class ConflictError extends Error {
  constructor() {
    super('Drive diubah dari perangkat lain. Muat ulang untuk melihat perubahan terbaru.');
    this.name = 'ConflictError';
  }
}

/** Download a whole (small) document into memory. */
export async function downloadDocument(tg, doc) {
  const chunks = [];
  let total = 0;
  for (let offset = 0; ; offset += CIPHER_BLOCK) {
    const c = await withRetry(() => tg.fetchWindow(doc, offset));
    chunks.push(c);
    total += c.length;
    if (c.length < CIPHER_BLOCK) break;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Upload an in-memory buffer as a document. Returns Api.Message. */
export async function uploadBuffer(tg, bytes, name, opts = {}) {
  const big = bytes.length > TG_BIG_FILE;
  const totalParts = Math.max(1, Math.ceil(bytes.length / TG_UPLOAD_PART));
  const fileId = tg.newFileId();
  for (let p = 0; p < totalParts; p++) {
    const piece = bytes.subarray(p * TG_UPLOAD_PART, (p + 1) * TG_UPLOAD_PART);
    await withRetry(() => tg.savePart({ fileId, part: p, totalParts, bytes: piece, big }), opts);
  }
  const randomId = tg.newFileId();
  return withRetry(() => tg.sendDocument({ fileId, totalParts, big, name, randomId }), opts);
}

/** Reject if `fn` takes longer than `ms` (a stalled socket must not freeze the UI forever). */
export function withTimeout(fn, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error(`TIMEOUT ${label}`), { errorMessage: `TIMEOUT ${label}` })), ms);
  });
  return Promise.race([fn(), timeout]).finally(() => clearTimeout(t));
}

export class DriveStore extends EventTarget {
  constructor(tg) {
    super();
    this.tg = tg;
    this.index = new DriveIndex();
    this.key = null;
    this.salt = null;
    this.indexMsgId = null;
    this.mutex = new Mutex();
    this.dirty = false;
    this.saving = false;
    this._timer = null;
    this._pendingSave = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * Locate the current index message: the newest index document in the channel. The pin is
   * only a hint, since pinning is best effort and may lag behind the upload.
   */
  async findIndexMessage() {
    let best = null;
    const pinned = await withRetry(() => withTimeout(() => this.tg.pinnedId(), 30000, 'pinnedId'));
    if (pinned) {
      const [m] = await this.tg.getMessages([pinned]);
      if (m && docName(m) === INDEX_NAME) best = m;
    }
    const docs = await withRetry(() => withTimeout(() => this.tg.listDocuments({ max: 300 }), 45000, 'listDocuments'));
    const d = docs.find((x) => x.name === INDEX_NAME);
    if (d && (!best || d.id > best.id)) {
      const [m] = await this.tg.getMessages([d.id]);
      if (m && docName(m) === INDEX_NAME) {
        best = m;
        this._pinWant = m.id; // repair a lost or lagging pin
        this._schedulePin();
      }
    }
    return best;
  }

  /** Id of the newest index message (max of the pin and the latest in recent history). */
  async latestIndexId() {
    const pinned = await withRetry(() => withTimeout(() => this.tg.pinnedId(), 30000, 'pinnedId'));
    const docs = await withRetry(() => withTimeout(() => this.tg.listDocuments({ max: 30 }), 45000, 'listDocuments'));
    const recent = docs.find((x) => x.name === INDEX_NAME)?.id || 0;
    return Math.max(pinned || 0, recent) || null;
  }

  _schedulePin() {
    if (this._pinning) return;
    this._pinning = (async () => {
      try {
        while (this._pinWant && this._pinWant !== this._pinned) {
          const id = this._pinWant;
          await withRetry(() => withTimeout(() => this.tg.pin(id), 30000, 'pin'));
          this._pinned = id;
        }
      } catch (e) {
        console.warn('Menyematkan indeks gagal (tidak fatal)', e);
      } finally {
        this._pinning = null;
      }
    })();
  }

  async exists() {
    this._indexMsg = await this.findIndexMessage();
    return !!this._indexMsg;
  }

  /** Open an existing drive with the passphrase. Throws WrongPassphraseError. */
  async open(passphrase) {
    const msg = this._indexMsg || (await this.findIndexMessage());
    if (!msg) throw new Error('Index drive tidak ditemukan');
    const blob = await downloadDocument(this.tg, msg.media.document);
    const salt = readSealedSalt(blob);
    const key = await deriveKey(passphrase, salt);
    const data = await unseal(key, blob);
    this.key = key;
    this.salt = salt;
    this.index = new DriveIndex(data);
    this.indexMsgId = msg.id;
    this.emit('change');
  }

  /** Create a brand new, empty drive protected by `passphrase`. */
  async create(passphrase) {
    this.salt = randomBytes(16);
    this.key = await deriveKey(passphrase, this.salt);
    this.index = new DriveIndex();
    this.indexMsgId = null;
    await this.saveNow();
    this.emit('change');
  }

  /** Change the passphrase: re-seal the index with a fresh salt. File keys are untouched. */
  async rekey(passphrase) {
    const prev = { salt: this.salt, key: this.key };
    this.salt = randomBytes(16);
    this.key = await deriveKey(passphrase, this.salt);
    try {
      await this.saveNow();
    } catch (e) {
      Object.assign(this, prev);
      throw e;
    }
  }

  /** Forgotten passphrase: replace the index with an empty drive. Encrypted files become unreadable. */
  async reset(passphrase) {
    const old = this._indexMsg || (await this.findIndexMessage());
    await this.create(passphrase);
    if (old && old.id !== this.indexMsgId) this.tg.deleteMessages([old.id]).catch(() => {});
  }

  /** Reload the index from Telegram (e.g. after another device changed it). */
  async reload() {
    await this.mutex.run(async () => {
      const msg = await this.findIndexMessage();
      if (!msg || msg.id === this.indexMsgId) return;
      const blob = await downloadDocument(this.tg, msg.media.document);
      this.index = new DriveIndex(await unseal(this.key, blob));
      this.indexMsgId = msg.id;
      this.dirty = false;
    });
    this.emit('change');
  }

  /** True if another device saved a newer index than the one we hold. */
  async isStale() {
    if (this.dirty || this.saving) return false;
    const latest = await this.latestIndexId();
    return !!latest && latest !== this.indexMsgId;
  }

  /** Apply a mutation, notify the UI, and persist (debounced). */
  mutate(fn) {
    const result = fn(this.index);
    this.dirty = true;
    this.emit('change');
    this.scheduleSave();
    return result;
  }

  scheduleSave(delay = 700) {
    clearTimeout(this._timer);
    if (!this._pendingSave) {
      this._pendingSave = {};
      this._pendingSave.promise = new Promise((resolve, reject) => {
        this._pendingSave.resolve = resolve;
        this._pendingSave.reject = reject;
      });
      this._pendingSave.promise.catch(() => {});
    }
    const pending = this._pendingSave;
    this._timer = setTimeout(() => {
      this._pendingSave = null;
      this.saveNow().then(pending.resolve, pending.reject);
    }, delay);
    return pending.promise;
  }

  async flush() {
    if (this._pendingSave) {
      clearTimeout(this._timer);
      const pending = this._pendingSave;
      this._pendingSave = null;
      await this.saveNow().then(pending.resolve, (e) => {
        pending.reject(e);
        throw e;
      });
    }
  }

  saveNow() {
    return this.mutex.run(async () => {
      this.saving = true;
      this.emit('saving');
      const step = (t) => {
        this.step = t;
        this.emit('step', t);
      };
      const onWait = (sec) => this.emit('wait', sec);
      const slow = setTimeout(() => this.emit('slow', this.step), 12000);
      try {
        if (this.indexMsgId) {
          step('memeriksa perubahan dari perangkat lain');
          const latest = await this.latestIndexId();
          if (latest && latest !== this.indexMsgId) throw new ConflictError();
        }
        this.dirty = false;
        step('mengunggah indeks');
        const blob = await seal(this.key, this.salt, this.index.data);
        const msg = await withTimeout(() => uploadBuffer(this.tg, blob, INDEX_NAME, { onWait }), 90000, 'upload indeks');
        // The new index is the truth as soon as it exists; pinning and cleaning up come after.
        const old = this.indexMsgId;
        this.indexMsgId = msg.id;
        this._pinWant = msg.id;
        this._schedulePin();
        if (old) this.tg.deleteMessages([old]).catch(() => {});
        this.emit('saved');
      } catch (e) {
        this.dirty = true;
        this.emit('save-error', e);
        throw e;
      } finally {
        clearTimeout(slow);
        this.step = '';
        this.saving = false;
      }
    });
  }

  /** Telegram message ids the index knows about (file parts + the index itself). */
  referencedMessageIds() {
    const ids = new Set(this.indexMsgId ? [this.indexMsgId] : []);
    for (const it of Object.values(this.index.items)) for (const p of it.parts || []) ids.add(p);
    for (const id of this.extraKnown?.() || []) ids.add(id); // parts of unfinished uploads
    return ids;
  }

  /** Documents in the channel that nothing in the index points to (leftovers of failed or duplicated sends). */
  async findOrphans() {
    await this.flush();
    if (this.dirty || this.saving) throw new Error('Tunggu penyimpanan selesai dulu.');
    const known = this.referencedMessageIds();
    const pinned = await withRetry(() => this.tg.pinnedId());
    if (pinned) known.add(pinned);
    const all = await this.tg.listDocuments();
    return all.filter((d) => !known.has(d.id) && isOwnBlob(d.name));
  }

  /**
   * Files posted straight into the storage channel from a Telegram app show up as
   * documents with real names. Add them to the drive as "open" files.
   * `busy()` lets the caller veto while uploads are in flight (their messages are not indexed yet).
   */
  async importFromTelegram({ max, busy = () => false } = {}) {
    if (busy() || this.dirty || this.saving || !this.key) return { added: 0, skipped: 0, busy: true };
    const docs = await this.tg.listDocuments({ max });
    if (busy() || this.dirty || this.saving) return { added: 0, skipped: 0, busy: true };
    const known = this.referencedMessageIds();
    const pinned = await withRetry(() => this.tg.pinnedId());
    if (busy() || this.dirty || this.saving) return { added: 0, skipped: 0, busy: true };
    if (pinned) known.add(pinned);
    const fresh = docs.filter((d) => !known.has(d.id) && !isOwnBlob(d.name));
    const maxSize = LAYOUT.blocksPerPart * CIPHER_BLOCK; // one message = one part
    const ok = fresh.filter((d) => d.size > 0 && d.size <= maxSize);
    if (ok.length) {
      this.mutate((ix) => {
        const folder = ix.ensureFolder(IMPORT_FOLDER, ROOT);
        for (const d of ok) {
          ix.addFile({ name: d.name || photoName(d.date), parent: folder.id, size: d.size, mime: d.mime, open: true, thumb: d.thumb, parts: [d.id], lastModified: d.date || undefined });
        }
      });
    }
    return { added: ok.length, skipped: fresh.length - ok.length };
  }

  lock() {
    this.key = null;
    this.index = new DriveIndex();
  }
}

export function docName(msg) {
  const attrs = msg?.media?.document?.attributes || [];
  const a = attrs.find((x) => x.className === 'DocumentAttributeFilename');
  return a?.fileName || null;
}
