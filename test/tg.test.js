import { describe, it, expect } from 'vitest';
import { Api } from 'telegram';
import { Tg, withRetry, isFloodWait } from '../src/core/tg.js';

function stubTg() {
  const tg = new Tg(12345, '0123456789abcdef0123456789abcdef');
  const sent = [];
  tg.client.invoke = async (req) => {
    // TL serialization is checked by scripts/serialize-check.mjs (vitest realms break Buffer instanceof)
    sent.push(req);
    if (req instanceof Api.messages.SendMedia) {
      return { updates: [new Api.UpdateNewChannelMessage({ message: { id: 77, media: { document: { id: 1 } } }, pts: 1, ptsCount: 1 })] };
    }
    if (req instanceof Api.channels.GetFullChannel) return { fullChat: { pinnedMsgId: 9 } };
    if (req instanceof Api.channels.GetMessages) return { messages: [] };
    return true;
  };
  tg.useChannel({ id: '1234567890', accessHash: '-987654321' });
  return { tg, sent };
}

describe('Tg request construction', () => {
  it('serializes upload, send, pin, delete', async () => {
    const { tg, sent } = stubTg();
    const fileId = tg.newFileId();
    const bytes = new Uint8Array(524288);
    await tg.savePart({ fileId, part: 0, totalParts: 3, bytes, big: true });
    await tg.savePart({ fileId, part: 0, totalParts: 1, bytes: bytes.subarray(0, 1000), big: false });
    const msg = await tg.sendDocument({ fileId, totalParts: 3, big: true, name: 'x.bin' });
    expect(msg.id).toBe(77);
    await tg.sendDocument({ fileId, totalParts: 1, big: false, name: 'y.bin' });
    await tg.pin(77);
    expect(await tg.pinnedId()).toBe(9);
    await tg.getMessages([1, 2, 3]);
    await tg.deleteMessages([1, 2]);
    expect(sent.map((r) => r.className)).toEqual([
      'upload.SaveBigFilePart', 'upload.SaveFilePart', 'messages.SendMedia', 'messages.SendMedia',
      'messages.UpdatePinnedMessage', 'channels.GetFullChannel', 'channels.GetMessages', 'channels.DeleteMessages',
    ]);
  });

  it('builds GetFile with aligned offset and follows DC migration', async () => {
    const { tg } = stubTg();
    const senders = [];
    tg.client.getSender = async (dc) => (senders.push(dc), { dcId: dc });
    let first = true;
    tg.client.invokeWithSender = async (req) => {
      expect(req.limit).toBe(1048576);
      expect(req.offset.toJSNumber()).toBe(3 * 1048576);
      if (first) {
        first = false;
        const e = new Error('FILE_MIGRATE_4');
        e.newDc = 4;
        throw e;
      }
      return new Api.upload.File({ type: new Api.storage.FileUnknown(), mtime: 0, bytes: Buffer.from([1, 2, 3]) });
    };
    const doc = new Api.Document({ id: 5n, accessHash: 6n, fileReference: Buffer.from([1]), date: 0, mimeType: 'x', size: 10n, dcId: 2, attributes: [] });
    const out = await tg.fetchWindow(doc, 3 * 1048576);
    expect([...out]).toEqual([1, 2, 3]);
    expect(senders).toEqual([2, 4]);
  });

  it('retries transient errors and waits on flood', async () => {
    let n = 0;
    const waits = [];
    const r = await withRetry(async () => {
      n++;
      if (n === 1) throw Object.assign(new Error('x'), { errorMessage: 'FLOOD_WAIT_0', seconds: 0 });
      if (n === 2) throw Object.assign(new Error('RPC_CALL_FAIL'), { errorMessage: 'RPC_CALL_FAIL' });
      return 'ok';
    }, { onWait: (s) => waits.push(s) });
    expect(r).toBe('ok');
    expect(waits).toEqual([0]);
    expect(isFloodWait({ seconds: 3, errorMessage: 'FLOOD_WAIT_3' })).toBe(true);
    await expect(withRetry(async () => { throw new Error('PHONE_CODE_INVALID'); })).rejects.toThrow('PHONE_CODE_INVALID');
  }, 20000);
});
