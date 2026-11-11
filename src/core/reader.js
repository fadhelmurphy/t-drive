// Random-access reads of encrypted files: fetch 1 MiB cipher windows from
// Telegram, decrypt them, and serve arbitrary plaintext byte ranges.
import { TAG_SIZE, blockCount, blockSizeOf, locateBlock, plainBlockLength, rangeToBlocks } from './blocks.js';
import { decryptBlock, fromB64, importFileKey } from './crypto.js';
import { withRetry } from './tg.js';
import { Lru } from './util.js';

const READ_AHEAD = 2;

export class Reader {
  constructor(tg) {
    this.tg = tg;
    this.docs = new Map(); // msgId -> Api.Document
    this.keys = new Map(); // itemId -> CryptoKey
    this.cache = new Lru(16); // "item:block" -> Uint8Array (~16 MiB)
    this.inflight = new Map();
  }

  clear() {
    this.docs.clear();
    this.keys.clear();
    this.cache.clear();
    this.inflight.clear();
  }

  async doc(msgId, refresh = false) {
    if (!refresh && this.docs.has(msgId)) return this.docs.get(msgId);
    const [m] = await withRetry(() => this.tg.getMessages([msgId]));
    const d = m?.media?.document || m?.media?.photo;
    if (!d) throw new Error('Potongan file hilang dari Telegram (pesan ' + msgId + ')');
    this.docs.set(msgId, d);
    return d;
  }

  async key(item) {
    if (!this.keys.has(item.id)) this.keys.set(item.id, await importFileKey(fromB64(item.key)));
    return this.keys.get(item.id);
  }

  block(item, i) {
    const k = `${item.id}:${i}`;
    const hit = this.cache.get(k);
    if (hit) return Promise.resolve(hit);
    if (this.inflight.has(k)) return this.inflight.get(k);
    const p = this._load(item, i)
      .then((plain) => {
        this.cache.set(k, plain);
        return plain;
      })
      .finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  async _load(item, i) {
    const { part, offset } = locateBlock(i);
    const msgId = item.parts[part];
    const bs = blockSizeOf(item);
    const expected = plainBlockLength(item.size, i, bs) + (item.open ? 0 : TAG_SIZE);
    let doc = await this.doc(msgId);
    let cipher;
    try {
      cipher = await withRetry(() => this.tg.fetchWindow(doc, offset, item.thumb));
    } catch (e) {
      if (!/FILE_REFERENCE/.test(e?.errorMessage || e?.message || '')) throw e;
      doc = await this.doc(msgId, true);
      cipher = await withRetry(() => this.tg.fetchWindow(doc, offset, item.thumb));
    }
    if (cipher.length < expected) throw new Error('Data dari Telegram terpotong');
    if (item.open) return cipher.slice(0, expected);
    try {
      return await decryptBlock(await this.key(item), fromB64(item.nonce), i, cipher.subarray(0, expected));
    } catch {
      throw new Error('Gagal mendekripsi data (file rusak atau kunci salah)');
    }
  }

  /** Async iterator over plaintext bytes [start, end] (inclusive). */
  async *range(item, start, end, signal) {
    const bs = blockSizeOf(item);
    const n = blockCount(item.size, bs);
    for (const { block, from, to } of rangeToBlocks(item.size, start, end, bs)) {
      signal?.throwIfAborted();
      const current = this.block(item, block);
      for (let a = 1; a <= READ_AHEAD && block + a < n; a++) {
        this.block(item, block + a).catch(() => {});
      }
      const plain = await current;
      yield plain.subarray(from, to + 1);
    }
  }

  async readAll(item, signal) {
    const out = new Uint8Array(item.size);
    let o = 0;
    if (item.size === 0) return out;
    for await (const c of this.range(item, 0, item.size - 1, signal)) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}
