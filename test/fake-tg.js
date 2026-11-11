// In-memory stand-in for Tg that enforces Telegram's upload/download rules.
import { CIPHER_BLOCK, TG_UPLOAD_PART, TG_BIG_FILE } from '../src/core/blocks.js';

export class FakeTg {
  constructor() {
    this.uploads = new Map();
    this.messages = new Map();
    this.nextMsg = 1;
    this.pinned = null;
    this.fetches = 0;
    this.failNextSaves = 0;
  }
  newFileId() {
    return Symbol('file');
  }
  async savePart({ fileId, part, totalParts, bytes, big }) {
    if (this.failNextSaves > 0) {
      this.failNextSaves--;
      const e = new Error('RPC_CALL_FAIL');
      e.errorMessage = 'RPC_CALL_FAIL';
      throw e;
    }
    if (bytes.length > TG_UPLOAD_PART) throw new Error('FILE_PART_TOO_BIG');
    if (!this.uploads.has(fileId)) this.uploads.set(fileId, { parts: new Map(), big, totalParts });
    const u = this.uploads.get(fileId);
    if (big && totalParts !== u.totalParts) throw new Error('FILE_PART_COUNT_MISMATCH');
    u.parts.set(part, bytes.slice());
  }
  async sendDocument({ fileId, totalParts, big, name }) {
    const u = this.uploads.get(fileId);
    if (!u) throw new Error('FILE_PARTS_INVALID');
    const chunks = [];
    for (let i = 0; i < totalParts; i++) {
      const c = u.parts.get(i);
      if (!c) throw new Error('FILE_PART_' + i + '_MISSING');
      if (i < totalParts - 1 && c.length !== TG_UPLOAD_PART) throw new Error('FILE_PART_SIZE_INVALID ' + i);
      chunks.push(c);
    }
    const size = chunks.reduce((s, c) => s + c.length, 0);
    if (!big && size > TG_BIG_FILE) throw new Error('FILE_PARTS_INVALID (needs big)');
    if (size > 2000 * 1024 * 1024) throw new Error('FILE_TOO_BIG');
    const data = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) {
      data.set(c, o);
      o += c.length;
    }
    const id = this.nextMsg++;
    const doc = { id, accessHash: 1, fileReference: 'ref', dcId: 2, size, data, attributes: [{ className: 'DocumentAttributeFilename', fileName: name }] };
    const msg = { id, media: { document: doc } };
    this.messages.set(id, msg);
    this.uploads.delete(fileId);
    return msg;
  }
  async getMessages(ids) {
    return ids.map((i) => this.messages.get(i)).filter(Boolean);
  }
  async deleteMessages(ids) {
    for (const i of ids) this.messages.delete(i);
  }
  async pin(id) {
    this.pinned = id;
  }
  async pinnedId() {
    return this.pinned;
  }
  async fetchWindow(doc, offset) {
    if (offset % CIPHER_BLOCK) throw new Error('OFFSET_INVALID');
    if (!this.messages.has(doc.id)) throw new Error('FILE_ID_INVALID');
    this.fetches++;
    return doc.data.slice(offset, offset + CIPHER_BLOCK);
  }
}
