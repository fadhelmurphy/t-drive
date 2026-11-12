// Upload queue: reads files block by block, encrypts, and streams them to
// Telegram as one or more documents ("parts"). Memory use stays at roughly
// WORKERS x 2 MiB regardless of file size.
import {
  CIPHER_BLOCK,
  OPEN_BLOCK,
  PLAIN_BLOCK,
  TG_BIG_FILE,
  TG_UPLOAD_PART,
  partBlocks,
  partCipherSize,
  partCount,
  plainBlockLength,
} from './blocks.js';
import { encryptBlock, fromB64, importFileKey, randomBytes, seal, toB64, unseal } from './crypto.js';
import { withRetry } from './tg.js';
import { uid } from './util.js';

const WORKERS = 4;
const PENDING_KEY = 'tdrive.pending';
const same = (t, file) => t.size === file.size && (t.lastModified || 0) === (file.lastModified || 0);

export class Uploader extends EventTarget {
  constructor(tg, drive, { storage = globalThis.localStorage || null } = {}) {
    super();
    this.tg = tg;
    this.drive = drive;
    this.storage = storage;
    this.tasks = [];
    this.running = false;
    this.persisting = Promise.resolve();
    // keep the parts of unfinished uploads safe from the orphan cleaner
    if (drive) drive.extraKnown = () => this.pendingIds();
  }

  /** Telegram message ids already sent for unfinished uploads. */
  pendingIds() {
    return this.tasks.filter((t) => !['done', 'canceled'].includes(t.status)).flatMap((t) => t.sent || []);
  }

  /** Unfinished uploads that survived a reload: wait for the user to pick the same file again. */
  async restore() {
    let list = [];
    try {
      const raw = this.storage?.getItem(PENDING_KEY);
      if (raw) list = (await unseal(this.drive.key, fromB64(raw))) || [];
    } catch {
      return; // other account/passphrase, or damaged: ignore
    }
    for (const r of list) {
      if (this.tasks.some((t) => t.id === r.id)) continue;
      const t = {
        id: r.id,
        file: null,
        parent: this.drive.index.get(r.parent) ? r.parent : 'root',
        name: r.name,
        open: !!r.open,
        replaceId: r.replaceId || null,
        size: r.size,
        lastModified: r.lastModified,
        rawKey: r.key ? fromB64(r.key) : null,
        nonce: r.nonce ? fromB64(r.nonce) : null,
        sent: r.sent,
        cur: r.cur ? { p: r.cur.p, fileId: BigInt(r.cur.fileId), blocks: r.cur.blocks } : null,
        resumable: true,
        loaded: 0,
        status: 'paused',
        note: '',
        error: null,
        ctrl: new AbortController(),
      };
      await this.verifySent(t);
      if (t.cur && t.cur.p !== t.sent.length) t.cur = null; // the part in flight must follow the finished ones
      if (!t.sent.length && !t.cur?.blocks.length) continue;
      this.setLoaded(t);
      this.tasks.push(t);
    }
    this.persist();
    this.emit();
  }

  /** Keep only the leading parts that still exist in the channel. */
  async verifySent(t) {
    if (!t.sent?.length) return (t.sent = []);
    const live = new Set((await withRetry(() => this.tg.getMessages(t.sent))).map((m) => m.id));
    const n = t.sent.findIndex((id) => !live.has(id));
    if (n >= 0) {
      const lost = t.sent.slice(n).filter((id) => live.has(id));
      if (lost.length) this.tg.deleteMessages(lost).catch(() => {});
      t.sent = t.sent.slice(0, n);
    }
    return t.sent;
  }

  /** Bytes of the file already covered by the sent parts. */
  setLoaded(t) {
    const bs = t.open ? OPEN_BLOCK : PLAIN_BLOCK;
    let n = 0;
    for (let p = 0; p < t.sent.length; p++) {
      const { first, last } = partBlocks(t.size, p, bs);
      n += Math.min(t.size, (last + 1) * bs) - first * bs;
    }
    if (t.cur?.p === t.sent.length) for (const i of t.cur.blocks) n += plainBlockLength(t.size, i, bs);
    t.loaded = n;
  }

  persist() {
    if (!this.storage || !this.drive?.key) return;
    const keep = this.tasks.filter((t) => t.resumable && (t.sent?.length || t.cur?.blocks.length) && !['done', 'canceled'].includes(t.status));
    const records = keep.map((t) => ({
      id: t.id,
      name: t.name,
      size: t.size,
      lastModified: t.lastModified || 0,
      parent: t.parent,
      open: !!t.open,
      replaceId: t.replaceId || null,
      key: t.rawKey ? toB64(t.rawKey) : null,
      nonce: t.nonce ? toB64(t.nonce) : null,
      sent: t.sent,
      cur: t.cur?.blocks.length ? { p: t.cur.p, fileId: String(t.cur.fileId), blocks: t.cur.blocks } : null,
    }));
    this.persisting = this.persisting
      .then(async () => {
        if (!records.length) return this.storage.removeItem(PENDING_KEY);
        this.storage.setItem(PENDING_KEY, toB64(await seal(this.drive.key, this.drive.salt, records)));
      })
      .catch(() => {});
    return this.persisting;
  }

  /** Block progress arrives constantly; write it out at most every couple of seconds. */
  persistSoon() {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      this.persist();
    }, 1500);
  }

  /** Continue a paused upload with the same file. Throws if the file differs. */
  resume(id, file) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || t.status !== 'paused') return;
    if (!same(t, file)) throw new Error('File ini berbeda dari yang diunggah sebelumnya (ukuran atau tanggal ubah tidak sama).');
    Object.assign(t, { file, status: 'queued', error: null, note: '', ctrl: new AbortController() });
    this.emit();
    this.pump();
  }

  /** Give up on a paused/failed upload and remove what it already sent. */
  discard(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || ['queued', 'uploading'].includes(t.status)) return;
    if (t.sent?.length) this.tg.deleteMessages(t.sent).catch(() => {});
    t.sent = [];
    t.cur = null;
    t.status = 'canceled';
    this.tasks = this.tasks.filter((x) => x !== t);
    this.persist();
    this.emit();
  }

  get active() {
    return this.tasks.some((t) => t.status === 'queued' || t.status === 'uploading');
  }

  emit() {
    this.dispatchEvent(new Event('change'));
  }

  /** entries: [{ file: File, parent: folderId }]. open: store unencrypted, visible in Telegram. */
  add(entries, { open = false, replaceId = null } = {}) {
    for (const { file, parent } of entries) {
      // the same file picked again continues its paused upload
      const paused = this.tasks.find((t) => t.status === 'paused' && t.name === file.name && t.open === open && same(t, file));
      if (paused) {
        this.resume(paused.id, file);
        continue;
      }
      this.tasks.push({
        id: uid(),
        file,
        parent,
        name: file.name,
        open,
        replaceId,
        size: file.size,
        lastModified: file.lastModified,
        resumable: !(file instanceof ReaderSource),
        sent: [],
        loaded: 0,
        status: 'queued',
        note: '',
        error: null,
        ctrl: new AbortController(),
      });
    }
    this.emit();
    this.pump();
  }

  /** Re-upload existing files in the other mode (open <-> encrypted), streaming through `reader`. */
  convert(items, toOpen, reader) {
    for (const item of items) {
      const file = new ReaderSource(reader, item);
      this.add([{ file, parent: item.parent }], { open: toOpen, replaceId: item.id });
    }
  }

  cancel(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || ['done', 'error', 'canceled'].includes(t.status)) return;
    t.ctrl.abort(new DOMException('Dibatalkan', 'AbortError'));
    if (t.status === 'queued') {
      t.status = 'canceled';
      if (t.sent?.length) this.tg.deleteMessages(t.sent).catch(() => {});
      t.sent = [];
      t.cur = null;
      this.persist();
    }
    this.emit();
  }

  retry(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || !['error', 'canceled'].includes(t.status)) return;
    Object.assign(t, { status: 'queued', error: null, note: '', ctrl: new AbortController() });
    this.emit();
    this.pump();
  }

  clearFinished() {
    for (const t of this.tasks) {
      // dropping a failed upload also drops the parts it kept for resuming; paused ones stay
      if (['error', 'canceled'].includes(t.status) && t.sent?.length) {
        this.tg.deleteMessages(t.sent).catch(() => {});
        t.sent = [];
      }
      if (['error', 'canceled'].includes(t.status)) t.cur = null;
    }
    this.tasks = this.tasks.filter((t) => ['queued', 'uploading', 'paused'].includes(t.status));
    this.persist();
    this.emit();
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const t = this.tasks.find((x) => x.status === 'queued');
        if (!t) break;
        await this.run(t);
      }
    } finally {
      this.running = false;
    }
  }

  async run(t) {
    t.status = 'uploading';
    this.emit();
    try {
      const open = !!t.open;
      const bs = open ? OPEN_BLOCK : PLAIN_BLOCK;
      if (!open && !t.rawKey) {
        t.rawKey = randomBytes(32);
        t.nonce = randomBytes(8);
      }
      const key = open ? null : await importFileKey(t.rawKey);
      const size = t.file.size;
      const nParts = partCount(size, bs);

      // resuming: keep only the leading parts that are still in the channel
      if (t.sent.length) await this.verifySent(t);
      this.setLoaded(t);
      this.emit();

      for (let p = t.sent.length; p < nParts; p++) {
        t.sent.push(await this.uploadPart(t, key, t.nonce, p));
        t.cur = null;
        this.setLoaded(t);
        this.persist();
        this.emit();
      }
      const sent = t.sent;

      if (t.replaceId) {
        const fields = open ? { open: true } : { key: toB64(t.rawKey), nonce: toB64(t.nonce) };
        const old = this.drive.mutate((ix) => ix.replaceStorage(t.replaceId, { ...fields, parts: sent }));
        this.tg.deleteMessages(old).catch(() => {});
      } else
        this.drive.mutate((ix) =>
          ix.addFile({
            name: t.name,
            parent: t.parent,
            size,
            mime: t.file.type || guessMime(t.name),
            ...(open ? { open: true } : { key: toB64(t.rawKey), nonce: toB64(t.nonce) }),
            parts: sent,
            lastModified: t.file.lastModified,
          }),
        );
      t.loaded = size;
      t.status = 'done';
      t.note = '';
      this.persist();
    } catch (e) {
      if (t.ctrl.signal.aborted) {
        // canceled: remove what was sent
        if (t.sent.length) this.tg.deleteMessages(t.sent).catch(() => {});
        t.sent = [];
        t.cur = null;
        t.status = 'canceled';
      } else {
        // failed: keep the finished parts so "Ulangi" continues instead of restarting
        if (!t.resumable) {
          if (t.sent.length) this.tg.deleteMessages(t.sent).catch(() => {});
          t.sent = [];
          t.cur = null;
        }
        t.status = 'error';
        t.error = e?.errorMessage || e?.message || String(e);
        console.error('upload failed', e);
      }
      this.persist();
    }
    this.emit();
  }

  /** Upload one part; a resumed in-flight part falls back to a fresh start if Telegram dropped its pieces. */
  async uploadPart(t, key, nonce, p) {
    const resumed = t.cur?.p === p && t.cur.blocks.length > 0;
    try {
      return await this.uploadPartOnce(t, key, nonce, p);
    } catch (e) {
      const msg = e?.errorMessage || e?.message || '';
      if (resumed && !t.ctrl.signal.aborted && /FILE_PART|FILE_PARTS_INVALID|FILE_ID/.test(msg)) {
        t.cur = null;
        return this.uploadPartOnce(t, key, nonce, p);
      }
      throw e;
    }
  }

  async uploadPartOnce(t, key, nonce, p) {
    const size = t.file.size;
    const signal = t.ctrl.signal;
    const open = !!t.open;
    const bs = open ? OPEN_BLOCK : PLAIN_BLOCK;
    const { first, last } = partBlocks(size, p, bs);
    const cipherSize = partCipherSize(size, p, bs);
    const totalParts = Math.ceil(cipherSize / TG_UPLOAD_PART);
    const big = cipherSize > TG_BIG_FILE;
    this.setLoaded(t); // progress of the part in flight restarts from the finished parts
    if (t.cur?.p !== p) t.cur = { p, fileId: this.tg.newFileId(), blocks: [] };
    const fileId = t.cur.fileId;
    const doneBlocks = new Set(t.cur.blocks);
    const piecesPerBlock = Math.ceil(CIPHER_BLOCK / TG_UPLOAD_PART); // = 2
    let next = first;
    let failed = false;
    const onWait = (s) => {
      t.note = `Menunggu FLOOD_WAIT ${s} dtk`;
      this.emit();
    };

    const worker = async () => {
      for (;;) {
        signal.throwIfAborted();
        if (failed) return;
        const i = next++;
        if (i > last) return;
        const len = plainBlockLength(size, i, bs);
        if (doneBlocks.has(i)) {
          t.loaded += len; // already on Telegram from an earlier attempt
          continue;
        }
        const plain = new Uint8Array(await t.file.slice(i * bs, i * bs + len).arrayBuffer());
        const cipher = open ? plain : await encryptBlock(key, nonce, i, plain);
        const base = (i - first) * piecesPerBlock;
        for (let j = 0; j * TG_UPLOAD_PART < cipher.length; j++) {
          const bytes = cipher.subarray(j * TG_UPLOAD_PART, (j + 1) * TG_UPLOAD_PART);
          await withRetry(() => this.tg.savePart({ fileId, part: base + j, totalParts, bytes, big }), { onWait, signal });
        }
        t.loaded += len;
        t.cur.blocks.push(i);
        if (t.resumable) this.persistSoon();
        if (t.note) t.note = '';
        this.emit();
      }
    };

    const guarded = () =>
      worker().catch((e) => {
        failed = true;
        throw e;
      });
    await Promise.all(Array.from({ length: Math.min(WORKERS, last - first + 1) }, guarded));
    signal.throwIfAborted();
    // Encrypted: obfuscated name, nothing about the file leaks. Open: real name and type.
    let doc;
    if (open) {
      const mime = t.file.type || guessMime(t.name);
      const n = partCount(size, bs);
      doc = {
        name: n > 1 ? `${t.name}.part${p + 1}` : t.name,
        mimeType: mime,
        inline: n === 1 && /^(image|video|audio)\//.test(mime),
      };
    } else doc = { name: `${uid()}.bin` };
    const randomId = this.tg.newFileId();
    const msg = await withRetry(() => this.tg.sendDocument({ fileId, totalParts, big, randomId, ...doc }), { onWait, signal });
    return msg.id;
  }
}

/** File-like view over a stored item: slice().arrayBuffer() reads (and decrypts) on demand. */
class ReaderSource {
  constructor(reader, item) {
    this.reader = reader;
    this.item = item;
    this.size = item.size;
    this.type = item.mime;
    this.name = item.name;
    this.lastModified = item.modified;
  }

  slice(a, b) {
    const { reader, item } = this;
    return {
      arrayBuffer: async () => {
        const out = new Uint8Array(b - a);
        let o = 0;
        if (b > a) for await (const c of reader.range(item, a, b - 1)) (out.set(c, o), (o += c.length));
        return out.buffer;
      },
    };
  }
}

const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  log: 'text/plain',
  sql: 'text/plain',
  zip: 'application/zip',
};

export function guessMime(name) {
  const ext = name.split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}
