// In-memory stand-in for Tg that enforces Telegram's upload/download rules.
import { CIPHER_BLOCK, TG_UPLOAD_PART, TG_BIG_FILE } from '../src/core/blocks.js';

export class FakeTg {
  /** `shared`: another FakeTg whose Telegram "server" state (messages, invites) this one joins. */
  constructor(shared) {
    this.uploads = new Map();
    this.messages = shared?.messages || new Map();
    this.server = shared?.server || { next: 1, invites: new Map(), pins: new Map(), chans: 0 };
    this.chanId = 'main';
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
  async sendDocument({ fileId, totalParts, big, name, mimeType = 'application/octet-stream', inline = false }) {
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
    const id = this.server.next++;
    const doc = { id, mimeType, inline, accessHash: 1, fileReference: 'ref', dcId: 2, size, data, attributes: [{ className: 'DocumentAttributeFilename', fileName: name }] };
    const msg = { id, chan: this.chanId, media: { document: doc } };
    this.messages.set(id, msg);
    this.uploads.delete(fileId);
    return msg;
  }
  async getMessages(ids) {
    return ids.map((i) => this.messages.get(i)).filter((m) => m && m.chan === this.chanId);
  }
  async listDocuments() {
    return [...this.messages.values()]
      .filter((m) => m.chan === this.chanId)
      .sort((a, b) => b.id - a.id)
      .map((m) => ({ id: m.id, name: m.media.document.attributes[0].fileName, size: m.media.document.size }));
  }
  async deleteMessages(ids) {
    for (const i of ids) this.messages.delete(i);
  }
  async pin(id) {
    this.server.pins.set(this.chanId, id);
  }
  async pinnedId() {
    return this.server.pins.get(this.chanId) || null;
  }
  forChannel(ch) {
    const t = Object.create(this);
    t.chanId = ch.id;
    return t;
  }
  async createShareChannel() {
    return { id: 'share' + ++this.server.chans, accessHash: '1' };
  }
  async exportInvite() {
    const h = 'inv' + Math.random().toString(36).slice(2, 10);
    this.server.invites.set(h, this.chanId);
    return h;
  }
  async joinInvite(hash) {
    const c = this.server.invites.get(hash);
    if (!c) throw new Error('Link berbagi tidak valid atau sudah dicabut');
    return { id: c, accessHash: '1' };
  }
  async deleteChannel() {
    for (const [h, c] of this.server.invites) if (c === this.chanId) this.server.invites.delete(h);
    for (const [id, m] of this.messages) if (m.chan === this.chanId) this.messages.delete(id);
    this.server.pins.delete(this.chanId);
  }
  async forwardTo(dest, ids) {
    const out = new Map();
    for (const old of ids) {
      const m = this.messages.get(old);
      if (!m || m.chan !== this.chanId) throw new Error('MESSAGE_ID_INVALID');
      const id = this.server.next++;
      this.messages.set(id, { id, chan: dest.chanId, media: { document: { ...m.media.document, id } } });
      out.set(old, id);
    }
    return out;
  }
  async fetchWindow(doc, offset) {
    if (offset % CIPHER_BLOCK) throw new Error('OFFSET_INVALID');
    if (!this.messages.has(doc.id)) throw new Error('FILE_ID_INVALID');
    this.fetches++;
    return doc.data.slice(offset, offset + CIPHER_BLOCK);
  }
}
