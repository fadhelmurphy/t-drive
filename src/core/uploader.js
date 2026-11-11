// Upload queue: reads files block by block, encrypts, and streams them to
// Telegram as one or more documents ("parts"). Memory use stays at roughly
// WORKERS x 2 MiB regardless of file size.
import {
  PLAIN_BLOCK,
  TG_BIG_FILE,
  TG_UPLOAD_PART,
  partBlocks,
  partCipherSize,
  partCount,
  plainBlockLength,
} from './blocks.js';
import { encryptBlock, importFileKey, randomBytes, toB64 } from './crypto.js';
import { withRetry } from './tg.js';
import { uid } from './util.js';

const WORKERS = 4;

export class Uploader extends EventTarget {
  constructor(tg, drive) {
    super();
    this.tg = tg;
    this.drive = drive;
    this.tasks = [];
    this.running = false;
  }

  get active() {
    return this.tasks.some((t) => t.status === 'queued' || t.status === 'uploading');
  }

  emit() {
    this.dispatchEvent(new Event('change'));
  }

  /** entries: [{ file: File, parent: folderId }] */
  add(entries) {
    for (const { file, parent } of entries) {
      this.tasks.push({
        id: uid(),
        file,
        parent,
        name: file.name,
        size: file.size,
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

  cancel(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || ['done', 'error', 'canceled'].includes(t.status)) return;
    t.ctrl.abort(new DOMException('Dibatalkan', 'AbortError'));
    if (t.status === 'queued') t.status = 'canceled';
    this.emit();
  }

  retry(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || !['error', 'canceled'].includes(t.status)) return;
    Object.assign(t, { status: 'queued', loaded: 0, error: null, note: '', ctrl: new AbortController() });
    this.emit();
    this.pump();
  }

  clearFinished() {
    this.tasks = this.tasks.filter((t) => t.status === 'queued' || t.status === 'uploading');
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
    const sent = [];
    try {
      const rawKey = randomBytes(32);
      const nonce = randomBytes(8);
      const key = await importFileKey(rawKey);
      const size = t.file.size;
      const nParts = partCount(size);

      for (let p = 0; p < nParts; p++) {
        sent.push(await this.uploadPart(t, key, nonce, p));
      }

      this.drive.mutate((ix) =>
        ix.addFile({
          name: t.name,
          parent: t.parent,
          size,
          mime: t.file.type || guessMime(t.name),
          key: toB64(rawKey),
          nonce: toB64(nonce),
          parts: sent,
          lastModified: t.file.lastModified,
        }),
      );
      t.loaded = size;
      t.status = 'done';
      t.note = '';
    } catch (e) {
      if (sent.length) this.tg.deleteMessages(sent).catch(() => {});
      if (t.ctrl.signal.aborted) {
        t.status = 'canceled';
      } else {
        t.status = 'error';
        t.error = e?.errorMessage || e?.message || String(e);
        console.error('upload failed', e);
      }
    }
    this.emit();
  }

  async uploadPart(t, key, nonce, p) {
    const size = t.file.size;
    const signal = t.ctrl.signal;
    const { first, last } = partBlocks(size, p);
    const cipherSize = partCipherSize(size, p);
    const totalParts = Math.ceil(cipherSize / TG_UPLOAD_PART);
    const big = cipherSize > TG_BIG_FILE;
    const fileId = this.tg.newFileId();
    const piecesPerBlock = Math.ceil((PLAIN_BLOCK + 16) / TG_UPLOAD_PART); // = 2
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
        const len = plainBlockLength(size, i);
        const plain = new Uint8Array(await t.file.slice(i * PLAIN_BLOCK, i * PLAIN_BLOCK + len).arrayBuffer());
        const cipher = await encryptBlock(key, nonce, i, plain);
        const base = (i - first) * piecesPerBlock;
        for (let j = 0; j * TG_UPLOAD_PART < cipher.length; j++) {
          const bytes = cipher.subarray(j * TG_UPLOAD_PART, (j + 1) * TG_UPLOAD_PART);
          await withRetry(() => this.tg.savePart({ fileId, part: base + j, totalParts, bytes, big }), { onWait, signal });
        }
        t.loaded += len;
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
    // Obfuscated name: nothing about the real file leaks into Telegram.
    const msg = await withRetry(() => this.tg.sendDocument({ fileId, totalParts, big, name: `${uid()}.bin` }), {
      onWait,
      signal,
    });
    return msg.id;
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
