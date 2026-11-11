// Thin wrapper around GramJS (MTProto over WebSocket) with only what T-Drive needs.
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { generateRandomLong } from 'telegram/Helpers.js';
import bigInt from 'big-integer';
import { CIPHER_BLOCK } from './blocks.js';
import { sleep } from './util.js';

export const CHANNEL_TITLE = 'T-Drive Storage';
const CHANNEL_ABOUT = 'Penyimpanan terenkripsi untuk T-Drive. Jangan hapus atau ubah pesan di sini.';

const toBuf = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

export function isFloodWait(e) {
  return typeof e?.seconds === 'number' && /FLOOD/.test(e?.errorMessage || e?.message || '');
}

function isRetryable(e) {
  const msg = String(e?.errorMessage || e?.message || '');
  return /TIMEOUT|Not connected|disconnect|RPC_CALL_FAIL|INTERNAL|-503|WORKER_BUSY|network/i.test(msg);
}

/**
 * Run `fn` with retries for transient errors and long FLOOD_WAITs.
 * onWait(seconds) is called before sleeping for a flood wait.
 */
export async function withRetry(fn, { tries = 6, onWait, signal } = {}) {
  let attempt = 0;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (isFloodWait(e)) {
        onWait?.(e.seconds);
        await sleep((e.seconds + 1) * 1000, signal);
        continue; // flood waits do not count as failures
      }
      if (attempt >= tries || !isRetryable(e)) throw e;
      await sleep(Math.min(30000, 500 * 2 ** attempt), signal);
    }
  }
}

export class Tg {
  constructor(apiId, apiHash, session = '') {
    this.apiId = Number(apiId);
    this.apiHash = String(apiHash);
    this.client = new TelegramClient(new StringSession(session), Number(apiId), String(apiHash), {
      connectionRetries: 10,
      retryDelay: 1500,
      autoReconnect: true,
      useWSS: true,
      floodSleepThreshold: 60,
      deviceModel: 'T-Drive Web',
      systemVersion: navigator.platform || 'Web',
      appVersion: '1.0.0',
      langCode: 'id',
      systemLangCode: 'id',
    });
    this.client.setLogLevel('error');
    this.channel = null; // Api.InputChannel
    this.peer = null; // Api.InputPeerChannel
  }

  session() {
    return this.client.session.save();
  }

  async connect() {
    await this.client.connect();
  }

  async isAuthorized() {
    return this.client.checkAuthorization();
  }

  /** Interactive login. Callbacks return promises resolved by the UI. */
  async login({ phoneNumber, phoneCode, password, onError }) {
    await this.client.start({ phoneNumber, phoneCode, password, onError });
  }

  /** Login by scanning a QR code with the Telegram app. qrCode({ token, expires }) renders it. */
  async loginQr({ qrCode, password, onError }) {
    await this.client.signInUserWithQrCode({ apiId: this.apiId, apiHash: this.apiHash }, { qrCode, password, onError });
  }

  async me() {
    return this.client.getMe();
  }

  async logout() {
    try {
      await this.client.invoke(new Api.auth.LogOut());
    } finally {
      await this.disconnect();
    }
  }

  async disconnect() {
    try {
      await this.client.destroy();
    } catch {
      /* ignore */
    }
  }

  // ---------- Storage channel ----------

  useChannel({ id, accessHash }) {
    this.channel = new Api.InputChannel({ channelId: bigInt(id), accessHash: bigInt(accessHash) });
    this.peer = new Api.InputPeerChannel({ channelId: bigInt(id), accessHash: bigInt(accessHash) });
  }

  /** Find (or create) the private storage channel. `cached` = {id, accessHash}. */
  async ensureChannel(cached) {
    if (cached) {
      try {
        this.useChannel(cached);
        const res = await this.client.invoke(new Api.channels.GetChannels({ id: [this.channel] }));
        const ch = res.chats[0];
        if (ch instanceof Api.Channel && !ch.left) return cached;
      } catch {
        /* fall through and search */
      }
    }
    for await (const d of this.client.iterDialogs({})) {
      const e = d.entity;
      if (e instanceof Api.Channel && e.creator && e.title === CHANNEL_TITLE && !e.megagroup) {
        const found = { id: e.id.toString(), accessHash: e.accessHash.toString() };
        this.useChannel(found);
        return found;
      }
    }
    const res = await this.client.invoke(
      new Api.channels.CreateChannel({ title: CHANNEL_TITLE, about: CHANNEL_ABOUT, broadcast: true }),
    );
    const ch = res.chats.find((c) => c instanceof Api.Channel);
    const created = { id: ch.id.toString(), accessHash: ch.accessHash.toString() };
    this.useChannel(created);
    return created;
  }

  // ---------- Upload ----------

  newFileId() {
    return generateRandomLong(true);
  }

  async savePart({ fileId, part, totalParts, bytes, big }) {
    const req = big
      ? new Api.upload.SaveBigFilePart({ fileId, filePart: part, fileTotalParts: totalParts, bytes: toBuf(bytes) })
      : new Api.upload.SaveFilePart({ fileId, filePart: part, bytes: toBuf(bytes) });
    const ok = await this.client.invoke(req);
    if (!ok) throw new Error('Telegram menolak potongan upload');
  }

  /** Send an uploaded file as a document to the storage channel. Returns Api.Message. */
  async sendDocument({ fileId, totalParts, big, name }) {
    const file = big
      ? new Api.InputFileBig({ id: fileId, parts: totalParts, name })
      : new Api.InputFile({ id: fileId, parts: totalParts, name, md5Checksum: '' });
    const updates = await this.client.invoke(
      new Api.messages.SendMedia({
        peer: this.peer,
        media: new Api.InputMediaUploadedDocument({
          file,
          mimeType: 'application/octet-stream',
          forceFile: true,
          attributes: [new Api.DocumentAttributeFilename({ fileName: name })],
        }),
        message: '',
        randomId: generateRandomLong(true),
        silent: true,
      }),
    );
    const list = updates.updates || [];
    const upd = list.find((u) => u instanceof Api.UpdateNewChannelMessage || u instanceof Api.UpdateNewMessage);
    if (!upd?.message?.media?.document) throw new Error('Respons Telegram tidak berisi dokumen');
    return upd.message;
  }

  // ---------- Messages ----------

  async getMessages(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const res = await this.client.invoke(
        new Api.channels.GetMessages({
          channel: this.channel,
          id: ids.slice(i, i + 100).map((id) => new Api.InputMessageID({ id })),
        }),
      );
      for (const m of res.messages) if (m instanceof Api.Message) out.push(m);
    }
    return out;
  }

  async deleteMessages(ids) {
    for (let i = 0; i < ids.length; i += 100) {
      await this.client.invoke(new Api.channels.DeleteMessages({ channel: this.channel, id: ids.slice(i, i + 100) }));
    }
  }

  async pin(id) {
    await this.client.invoke(new Api.messages.UpdatePinnedMessage({ peer: this.peer, id, silent: true }));
  }

  async pinnedId() {
    const full = await this.client.invoke(new Api.channels.GetFullChannel({ channel: this.channel }));
    return full.fullChat.pinnedMsgId || null;
  }

  // ---------- Download ----------

  /**
   * Fetch up to 1 MiB of a document at an offset aligned to 1 MiB.
   * Throws errors with errorMessage FILE_REFERENCE_EXPIRED etc. to the caller.
   */
  async fetchWindow(doc, offset) {
    const location = new Api.InputDocumentFileLocation({
      id: doc.id,
      accessHash: doc.accessHash,
      fileReference: doc.fileReference,
      thumbSize: '',
    });
    const req = new Api.upload.GetFile({ location, offset: bigInt(offset), limit: CIPHER_BLOCK, precise: false });
    let sender = await this.client.getSender(doc.dcId);
    for (let hop = 0; hop < 3; hop++) {
      try {
        const res = await this.client.invokeWithSender(req, sender);
        if (res instanceof Api.upload.FileCdnRedirect) throw new Error('CDN redirect tidak didukung');
        return new Uint8Array(res.bytes.buffer, res.bytes.byteOffset, res.bytes.byteLength);
      } catch (e) {
        if (e?.newDc) {
          sender = await this.client.getSender(e.newDc);
          continue;
        }
        throw e;
      }
    }
    throw new Error('Gagal menemukan DC file');
  }
}
