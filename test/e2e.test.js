import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FakeTg } from './fake-tg.js';
import { DriveStore, ConflictError } from '../src/core/drive.js';
import { Uploader } from '../src/core/uploader.js';
import { Reader } from '../src/core/reader.js';
import { CIPHER_BLOCK, LAYOUT, PLAIN_BLOCK } from '../src/core/blocks.js';
import { WrongPassphraseError, randomBytes, toB64 } from '../src/core/crypto.js';
import { ROOT } from '../src/core/drive-index.js';
import { parseAllowed, copyToDrive, createShare, manifestChildren, openShare, parseShareHash, revokeShare, shareLink } from '../src/core/share.js';

// Speed: tiny PBKDF2 isn't configurable via the store, so this suite takes a few seconds.
const prev = LAYOUT.blocksPerPart;
beforeAll(() => (LAYOUT.blocksPerPart = 3));
afterAll(() => (LAYOUT.blocksPerPart = prev));

function waitIdle(up) {
  return new Promise((res) => {
    const check = () => (!up.active && !up.running ? res() : setTimeout(check, 10));
    check();
  });
}

describe('end to end with fake Telegram', () => {
  it('uploads multi-part file, reads any range, persists index', async () => {
    const tg = new FakeTg();
    const store = new DriveStore(tg);
    expect(await store.exists()).toBe(false);
    await store.create('passphrase-uji');
    const folder = store.mutate((ix) => ix.createFolder('Video'));
    await store.flush();

    const size = PLAIN_BLOCK * 7 + 12345; // 8 blocks -> 3 parts with 3 blocks/part
    const data = randomBytes(size);
    tg.failNextSaves = 2; // transient errors must be retried
    const up = new Uploader(tg, store);
    up.add([{ file: new File([data], 'film.mp4', { type: 'video/mp4' }), parent: folder.id }]);
    await waitIdle(up);
    expect(up.tasks[0].status).toBe('done');
    await store.flush();

    const item = store.index.children(folder.id)[0];
    expect(item.parts.length).toBe(3);
    expect(item.size).toBe(size);

    const reader = new Reader(tg);
    expect(await reader.readAll(item)).toEqual(data);
    const pieces = [];
    const s = PLAIN_BLOCK * 3 - 10, e = PLAIN_BLOCK * 3 + 20; // crosses a part boundary
    for await (const c of reader.range(item, s, e)) pieces.push(...c);
    expect(Uint8Array.from(pieces)).toEqual(data.slice(s, e + 1));

    // A second device opens the same drive.
    const other = new DriveStore(tg);
    expect(await other.exists()).toBe(true);
    await expect(other.open('salah')).rejects.toBeInstanceOf(WrongPassphraseError);
    await other.open('passphrase-uji');
    expect(other.index.get(item.id).name).toBe('film.mp4');

    // Other device saves; first device detects conflict instead of overwriting.
    other.mutate((ix) => ix.createFolder('Dari HP'));
    await other.flush();
    expect(await store.isStale()).toBe(true);
    store.mutate((ix) => ix.createFolder('Bentrok'));
    await expect(store.flush()).rejects.toBeInstanceOf(ConflictError);
    await store.reload();
    expect(store.index.children(ROOT).some((x) => x.name === 'Dari HP')).toBe(true);

    // Only one index message remains (old ones are deleted).
    const indexMsgs = [...tg.messages.values()].filter((m) => m.media.document.attributes[0].fileName === 't-drive-index.bin');
    expect(indexMsgs.length).toBe(1);

    // Delete forever removes the Telegram messages.
    store.mutate((ix) => ix.trashItems([item.id]));
    const ids = store.mutate((ix) => ix.emptyTrash());
    await tg.deleteMessages(ids);
    for (const id of item.parts) expect(tg.messages.has(id)).toBe(false);
  }, 60000);

  it('handles empty and small files; cancel cleans up', async () => {
    const tg = new FakeTg();
    const store = new DriveStore(tg);
    await store.create('pw-pw-pw-pw');
    const up = new Uploader(tg, store);
    up.add([
      { file: new File([], 'kosong.txt'), parent: ROOT },
      { file: new File(['halo'], 'halo.txt'), parent: ROOT },
    ]);
    await waitIdle(up);
    const [a, b] = store.index.children(ROOT).sort((x, y) => x.name.localeCompare(y.name));
    expect(b.size).toBe(0);
    expect(b.parts).toEqual([]);
    const reader = new Reader(tg);
    expect(new TextDecoder().decode(await reader.readAll(a))).toBe('halo');
    expect((await reader.readAll(b)).length).toBe(0);

    const before = tg.messages.size;
    // cancel deterministically on the first piece instead of racing a timer
    const origSave = tg.savePart.bind(tg);
    let t;
    tg.savePart = async (a) => {
      up.cancel(t.id);
      return origSave(a);
    };
    up.add([{ file: new File([randomBytes(PLAIN_BLOCK * 4)], 'besar.bin'), parent: ROOT }]);
    t = up.tasks[2];
    await waitIdle(up);
    tg.savePart = origSave;
    expect(t.status).toBe('canceled');
    await new Promise((r) => setTimeout(r, 20));
    expect(tg.messages.size).toBe(before);
  }, 60000);

  it('open mode: stores plain bytes with real name/mime, reads back any range', async () => {
    const tg = new FakeTg();
    const store = new DriveStore(tg);
    await store.create('passphrase-uji');
    const size = CIPHER_BLOCK * 4 + 777; // 5 blocks -> 2 parts at 3 blocks/part
    const data = randomBytes(size);
    const up = new Uploader(tg, store);
    up.add([{ file: new File([data], 'liburan.mp4', { type: 'video/mp4' }), parent: ROOT }], { open: true });
    up.add([{ file: new File([data.slice(0, 5000)], 'foto.jpg', { type: 'image/jpeg' }), parent: ROOT }], { open: true });
    await waitIdle(up);
    expect(up.tasks.map((t) => t.status)).toEqual(['done', 'done']);

    const [big, small] = store.index.children(ROOT).sort((a, b) => b.size - a.size);
    expect(big.open).toBe(true);
    expect(big.key).toBeUndefined();
    expect(big.parts.length).toBe(2);

    const docs = big.parts.map((id) => tg.messages.get(id).media.document);
    expect(docs[0].attributes[0].fileName).toBe('liburan.mp4.part1');
    expect(docs[0].mimeType).toBe('video/mp4');
    // Telegram holds the raw bytes: first part is byte-identical to the file prefix.
    expect(docs[0].data).toEqual(data.slice(0, docs[0].data.length));
    const sdoc = tg.messages.get(small.parts[0]).media.document;
    expect(sdoc.attributes[0].fileName).toBe('foto.jpg');
    expect(sdoc.inline).toBe(true);

    const reader = new Reader(tg);
    expect(await reader.readAll(big)).toEqual(data);
    const s = CIPHER_BLOCK * 3 - 5, e = CIPHER_BLOCK * 3 + 9; // across the part boundary
    const pieces = [];
    for await (const c of reader.range(big, s, e)) pieces.push(...c);
    expect(Uint8Array.from(pieces)).toEqual(data.slice(s, e + 1));
  }, 60000);

  it('converts a file between open and encrypted, keeping id and content', async () => {
    const tg = new FakeTg();
    const store = new DriveStore(tg);
    await store.create('passphrase-uji');
    const data = randomBytes(PLAIN_BLOCK * 4 + 321);
    const up = new Uploader(tg, store);
    up.add([{ file: new File([data], 'dok.pdf', { type: 'application/pdf' }), parent: ROOT }]);
    await waitIdle(up);
    const item = store.index.children(ROOT)[0];
    const id = item.id;
    const oldParts = [...item.parts];
    const reader = new Reader(tg);

    up.convert([item], true, reader); // encrypted -> open
    await waitIdle(up);
    const o = store.index.get(id);
    expect(o.open).toBe(true);
    expect(o.key).toBeUndefined();
    expect(o.parts).not.toEqual(oldParts);
    await new Promise((r) => setTimeout(r, 20));
    for (const m of oldParts) expect(tg.messages.has(m)).toBe(false);
    expect(tg.messages.get(o.parts[0]).media.document.attributes[0].fileName).toMatch(/^dok\.pdf/);
    expect(await new Reader(tg).readAll(o)).toEqual(data);

    up.convert([o], false, new Reader(tg)); // open -> encrypted
    await waitIdle(up);
    const c = store.index.get(id);
    expect(c.open).toBeUndefined();
    expect(c.key).toBeTruthy();
    expect(tg.messages.get(c.parts[0]).media.document.attributes[0].fileName).toMatch(/\.bin$/);
    expect(await new Reader(tg).readAll(c)).toEqual(data);
    expect(store.index.children(ROOT).length).toBe(1);
  }, 60000);

  it('shares a folder by link: recipient reads, copies to own drive; revoke kills it', async () => {
    const owner = new FakeTg();
    const drive = new DriveStore(owner);
    await drive.create('pw-owner');
    const folder = drive.mutate((ix) => ix.createFolder('Liburan'));
    const sub = drive.mutate((ix) => ix.createFolder('Hari 1', folder.id));
    const d1 = randomBytes(PLAIN_BLOCK * 3 + 99);
    const d2 = randomBytes(CIPHER_BLOCK + 5);
    const up = new Uploader(owner, drive);
    up.add([{ file: new File([d1], 'a.mp4', { type: 'video/mp4' }), parent: folder.id }]);
    up.add([{ file: new File([d2], 'b.jpg', { type: 'image/jpeg' }), parent: sub.id }], { open: true });
    await waitIdle(up);

    const share = await createShare({ tg: owner, drive, ids: [folder.id], name: 'Liburan' });
    expect(share.count).toBe(2);
    expect(drive.index.shares().map((x) => x.id)).toEqual([share.id]);
    const link = shareLink(share, 'https://x.test/t-drive/');
    const parsed = parseShareHash('#' + link.split('#')[1]);
    expect(parsed).toEqual({ invite: share.invite, key: share.key });

    // Recipient: another Telegram account on the same "server".
    const guest = new FakeTg(owner);
    guest.chanId = 'guest-main'; // the guest's own storage channel
    const { shareTg, manifest } = await openShare({ tg: guest, ...parsed });
    const top = manifestChildren(manifest, ROOT);
    expect(top.map((i) => i.name)).toEqual(['Liburan']);
    const files = Object.values(manifest.items).filter((i) => i.type === 'file');
    const reader = new Reader(shareTg);
    const a = files.find((f) => f.name === 'a.mp4');
    const b = files.find((f) => f.name === 'b.jpg');
    expect(await reader.readAll(a)).toEqual(d1);
    expect(await reader.readAll(b)).toEqual(d2);
    // Shared parts are copies: deleting the owner's originals does not break the share.
    await owner.deleteMessages(drive.index.get(files.find((f) => f.name === 'a.mp4').id).parts);
    expect(await new Reader(shareTg).readAll(a)).toEqual(d1);

    // Guest saves it into their own drive.
    const mine = new DriveStore(guest);
    await mine.create('pw-guest');
    await copyToDrive({ shareTg, myTg: guest, drive: mine, manifest, ids: top.map((i) => i.id) });
    const copied = mine.index.children(ROOT)[0];
    expect(copied.name).toBe('Liburan');
    const mf = mine.index.children(copied.id).find((i) => i.type === 'file');
    expect(await new Reader(guest).readAll(mf)).toEqual(d1);
    const sf = mine.index.children(mine.index.children(copied.id).find((i) => i.type === 'folder').id)[0];
    expect(sf.open).toBe(true);
    expect(await new Reader(guest).readAll(sf)).toEqual(d2);

    // Wrong key and revoked link both fail.
    await expect(openShare({ tg: guest, invite: parsed.invite, key: toB64(randomBytes(32)) })).rejects.toThrow(/Kunci/);
    await revokeShare({ tg: owner, drive, share });
    expect(drive.index.shares()).toEqual([]);
    await expect(openShare({ tg: guest, ...parsed })).rejects.toThrow(/dicabut|tidak valid/);
  }, 90000);

  it('finds leftover Telegram documents the index does not know, keeps real files', async () => {
    const tg = new FakeTg();
    const store = new DriveStore(tg);
    await store.create('pw');
    const up = new Uploader(tg, store);
    up.add([{ file: new File([randomBytes(2000)], 'a.txt'), parent: ROOT }]);
    up.add([{ file: new File([randomBytes(3000)], 'b.txt'), parent: ROOT }], { open: true });
    await waitIdle(up);
    expect(await store.findOrphans()).toEqual([]);
    // Simulate a duplicate send that the index never recorded.
    const { uploadBuffer } = await import('../src/core/drive.js');
    const stray = await uploadBuffer(tg, randomBytes(500), 'abcdefghij012345.bin');
    const orphans = await store.findOrphans();
    expect(orphans.map((o) => o.id)).toEqual([stray.id]);
    await tg.deleteMessages(orphans.map((o) => o.id));
    expect(await store.findOrphans()).toEqual([]);
    const reader = new Reader(tg);
    for (const it of store.index.liveFiles()) expect((await reader.readAll(it)).length).toBe(it.size);
  }, 60000);

  it('imports files posted from the Telegram app as open files, once', async () => {
    const tg = new FakeTg();
    const store = new DriveStore(tg);
    await store.create('pw');
    const content = randomBytes(CIPHER_BLOCK + 500);
    // What the Telegram app does: plain upload + send with the real file name.
    const fileId = tg.newFileId();
    for (let p = 0, o = 0; o < content.length; p++, o += 512 * 1024) {
      await tg.savePart({ fileId, part: p, totalParts: Math.ceil(content.length / (512 * 1024)), bytes: content.subarray(o, o + 512 * 1024), big: false });
    }
    const posted = await tg.sendDocument({ fileId, totalParts: Math.ceil(content.length / (512 * 1024)), big: false, name: 'dari-hp.mp4', mimeType: 'video/mp4' });

    expect(await store.importFromTelegram({ busy: () => true })).toMatchObject({ busy: true, added: 0 }); // uploads in flight
    expect(await store.importFromTelegram()).toEqual({ added: 1, skipped: 0 });
    const folder = store.index.children(ROOT).find((i) => i.name === 'Dari Telegram');
    const f = store.index.children(folder.id)[0];
    expect(f).toMatchObject({ name: 'dari-hp.mp4', open: true, size: content.length, mime: 'video/mp4', parts: [posted.id] });
    expect(await new Reader(tg).readAll(f)).toEqual(content);

    await store.flush();
    expect(await store.importFromTelegram()).toEqual({ added: 0, skipped: 0 }); // already indexed
    expect(await store.findOrphans()).toEqual([]); // and never offered for cleanup
    // Our own uploads are never re-imported.
    const up = new Uploader(tg, store);
    up.add([{ file: new File([randomBytes(1000)], 'x.bin'), parent: ROOT }]);
    await waitIdle(up);
    await store.flush();
    expect(await store.importFromTelegram()).toEqual({ added: 0, skipped: 0 });
  }, 60000);

  it('finds the drive index even when the pin is lost, instead of starting a new drive', async () => {
    const tg = new FakeTg();
    const store = new DriveStore(tg);
    await store.create('pw');
    store.mutate((ix) => ix.createFolder('Penting'));
    await store.flush();
    tg.server.pins.delete(tg.chanId); // pin vanished
    expect(await tg.pinnedId()).toBeNull();
    const again = new DriveStore(tg);
    expect(await again.exists()).toBe(true);
    await again.open('pw');
    expect(again.index.children(ROOT).map((i) => i.name)).toEqual(['Penting']);
    expect(await tg.pinnedId()).toBe(again.indexMsgId); // re-pinned
  }, 60000);

  it('changes the passphrase (files keep working) and resets a forgotten drive', async () => {
    const tg = new FakeTg();
    const store = new DriveStore(tg);
    await store.create('lama-lama-lama');
    const data = randomBytes(5000);
    const up = new Uploader(tg, store);
    up.add([{ file: new File([data], 'rahasia.bin'), parent: ROOT }]);
    await waitIdle(up);
    await store.flush();

    await store.rekey('baru-baru-baru');
    const other = new DriveStore(tg);
    await expect(other.open('lama-lama-lama')).rejects.toBeInstanceOf(WrongPassphraseError);
    await other.open('baru-baru-baru');
    const it = other.index.children(ROOT)[0];
    expect(await new Reader(tg).readAll(it)).toEqual(data); // file keys unchanged

    // Forgot everything: reset gives an empty drive and removes the old index.
    const lost = new DriveStore(tg);
    await lost.exists();
    await lost.reset('segar-segar-segar');
    expect(lost.index.children(ROOT)).toEqual([]);
    const again = new DriveStore(tg);
    await again.open('segar-segar-segar');
    expect(again.index.children(ROOT)).toEqual([]);
    expect((await tg.listDocuments()).filter((d) => d.name === 't-drive-index.bin').length).toBe(1);
  }, 90000);

  it('imports a photo sent from the Telegram app, reads and shares it', async () => {
    const tg = new FakeTg();
    const store = new DriveStore(tg);
    await store.create('pw');
    const img = randomBytes(CIPHER_BLOCK + 321);
    const id = tg.server.next++;
    tg.messages.set(id, { id, chan: tg.chanId, media: { photo: { id, thumbOnly: true, data: img } } });

    expect(await store.importFromTelegram()).toEqual({ added: 1, skipped: 0 });
    const folder = store.index.children(ROOT).find((i) => i.name === 'Dari Telegram');
    const f = store.index.children(folder.id)[0];
    expect(f).toMatchObject({ open: true, thumb: 'y', size: img.length, mime: 'image/jpeg', parts: [id] });
    expect(f.name).toMatch(/^Foto \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.jpg$/);
    expect(await new Reader(tg).readAll(f)).toEqual(img);
    await store.flush();
    expect(await store.importFromTelegram()).toEqual({ added: 0, skipped: 0 });

    // Photos can be shared and copied like any file.
    const share = await createShare({ tg, drive: store, ids: [f.id], name: 'foto' });
    const guest = new FakeTg(tg);
    guest.chanId = 'guest-main';
    const { shareTg, manifest } = await openShare({ tg: guest, invite: share.invite, key: share.key });
    const sf = Object.values(manifest.items).find((i) => i.type === 'file');
    expect(sf.thumb).toBe('y');
    expect(await new Reader(shareTg).readAll(sf)).toEqual(img);

    // Converting to encrypted re-uploads it as a normal document.
    const up = new Uploader(tg, store);
    up.convert([store.index.get(f.id)], false, new Reader(tg));
    await waitIdle(up);
    const c = store.index.get(f.id);
    expect(c.thumb).toBeUndefined();
    expect(c.open).toBeUndefined();
    expect(await new Reader(tg).readAll(c)).toEqual(img);
  }, 90000);

  it('a failing pin never blocks saving; the newest index wins and the pin heals later', async () => {
    const tg = new FakeTg();
    const store = new DriveStore(tg);
    await store.create('pw');
    await new Promise((r) => setTimeout(r, 20));
    tg.failPin = true;
    store.mutate((ix) => ix.createFolder('Setelah pin gagal'));
    await store.flush(); // must not throw or hang
    store.mutate((ix) => ix.createFolder('Lagi'));
    await store.flush(); // second save: no false conflict although the pin is stale
    await new Promise((r) => setTimeout(r, 30));

    const other = new DriveStore(tg);
    expect(await other.exists()).toBe(true);
    await other.open('pw');
    expect(other.index.children(ROOT).map((i) => i.name).sort()).toEqual(['Lagi', 'Setelah pin gagal']);
    expect(await store.isStale()).toBe(false);
    tg.failPin = false;
    store.mutate((ix) => ix.createFolder('Pin pulih'));
    await store.flush();
    await new Promise((r) => setTimeout(r, 30));
    expect(await tg.pinnedId()).toBe(store.indexMsgId);
    expect((await tg.listDocuments()).filter((d) => d.name === 't-drive-index.bin').length).toBe(1);
  }, 60000);

  it('share options: view-only flag travels in the manifest; allow-list admits only listed accounts', async () => {
    const owner = new FakeTg();
    const drive = new DriveStore(owner);
    await drive.create('pw');
    const bytes = new Uint8Array(1000).fill(3);
    const up = new Uploader(owner, drive);
    up.add([{ file: new File([bytes], 'a.bin'), parent: ROOT }]);
    await waitIdle(up);
    const file = drive.index.children(ROOT).find((i) => i.type === 'file');

    expect(parseAllowed(' @Ani, t.me/Budi;12345 ani')).toEqual(['ani', 'budi', '12345']);

    const share = await createShare({ tg: owner, drive, ids: [file.id], name: 'a', readonly: true, allowed: ['ani', '777'] });
    expect(share.readonly).toBe(true);
    const parsed = parseShareHash(new URL(shareLink(share, 'https://x/')).hash);

    const stranger = new FakeTg({ messages: owner.messages, server: owner.server });
    stranger.chanId = 'stranger-main';
    stranger.user = { id: 5n, username: 'zed' };
    await expect(openShare({ tg: stranger, ...parsed })).rejects.toThrow(/khusus akun/);

    const byName = new FakeTg({ messages: owner.messages, server: owner.server });
    byName.chanId = 'n-main';
    byName.user = { id: 6n, username: 'Ani' };
    const a = await openShare({ tg: byName, ...parsed });
    expect(a.manifest.readonly).toBe(true);

    const byId = new FakeTg({ messages: owner.messages, server: owner.server });
    byId.chanId = 'i-main';
    byId.user = { id: 777n, username: null };
    await openShare({ tg: byId, ...parsed });

    const open = await createShare({ tg: owner, drive, ids: [file.id], name: 'b' });
    expect(open.readonly).toBeUndefined();
    const p2 = parseShareHash(new URL(shareLink(open, 'https://x/')).hash);
    const any = await openShare({ tg: stranger, ...p2 });
    expect(any.manifest.readonly).toBeUndefined();
  }, 60000);

  it('upload resumes after a failure and after a reload, reusing finished parts', async () => {
    const tg = new FakeTg();
    const store = new DriveStore(tg);
    await store.create('pw');
    const data = randomBytes(PLAIN_BLOCK * 5 + 123);
    const file = new File([data], 'big.bin', { lastModified: 1234 });
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };

    // two parts; the second fails
    const saved = LAYOUT.blocksPerPart;
    LAYOUT.blocksPerPart = 3;
    try {
      // part 2 fails: part 1 is kept
      let calls = 0;
      const orig = tg.sendDocument.bind(tg);
      tg.sendDocument = async (a) => {
        if (++calls === 2) throw new Error('BOOM');
        return orig(a);
      };
      const up2 = new Uploader(tg, store, { storage });
      up2.add([{ file, parent: ROOT }]);
      await waitIdle(up2);
      const t = up2.tasks[0];
      expect(t.status).toBe('error');
      expect(t.sent.length).toBe(1);
      expect(t.loaded).toBeGreaterThan(0);
      expect(store.referencedMessageIds().has(t.sent[0])).toBe(true); // protected from the orphan cleaner

      await up2.persisting;
      // "reload": a new uploader restores it as paused
      const up3 = new Uploader(tg, store, { storage });
      await up3.restore();
      expect(up3.tasks.length).toBe(1);
      expect(up3.tasks[0].status).toBe('paused');
      expect(up3.tasks[0].sent.length).toBe(1);
      expect(() => up3.resume(up3.tasks[0].id, new File([data], 'big.bin', { lastModified: 999 }))).toThrow(/berbeda/);

      tg.sendDocument = orig;
      up3.add([{ file, parent: ROOT }]); // picking the same file again continues it
      await waitIdle(up3);
      expect(up3.tasks[0].status).toBe('done');
      const f = store.index.children(ROOT).find((i) => i.name === 'big.bin');
      expect(f.parts.length).toBe(2);
      expect(f.parts[0]).toBe(t.sent[0]); // first part was reused, not re-sent
      const back = [];
      for await (const c of new Reader(tg).range(f, 0, f.size - 1)) back.push(c);
      const all = new Uint8Array(f.size);
      let o = 0;
      for (const c of back) (all.set(c, o), (o += c.length));
      expect(all).toEqual(data);
      expect(mem.has('tdrive.pending')).toBe(false);
    } finally {
      LAYOUT.blocksPerPart = saved;
    }
  }, 60000);

  it('a single-part upload resumes mid-part after a reload by reusing the Telegram file id', async () => {
    const tg = new FakeTg();
    const store = new DriveStore(tg);
    await store.create('pw');
    const data = randomBytes(PLAIN_BLOCK * 2 + 77); // 3 blocks = one part
    const file = new File([data], 'one.bin', { lastModified: 55 });
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };

    const up = new Uploader(tg, store, { storage });
    const origSave = tg.savePart.bind(tg);
    let saved = 0;
    tg.savePart = async (a) => {
      if (a.part >= 4) throw new Error('DEAD'); // the last block never makes it
      saved++;
      return origSave(a);
    };
    const origRetry = up.tg; // keep reference
    up.add([{ file, parent: ROOT }]);
    await waitIdle(up);
    expect(up.tasks[0].status).toBe('error');
    expect(up.tasks[0].sent.length).toBe(0);
    expect(up.tasks[0].cur.blocks.length).toBeGreaterThan(0);
    await up.persist();

    const up2 = new Uploader(tg, store, { storage });
    await up2.restore();
    expect(up2.tasks[0].status).toBe('paused');
    expect(up2.tasks[0].loaded).toBeGreaterThan(0);

    tg.savePart = origSave;
    let resent = 0;
    tg.savePart = async (a) => (resent++, origSave(a));
    up2.add([{ file, parent: ROOT }]);
    await waitIdle(up2);
    expect(up2.tasks[0].status).toBe('done');
    expect(resent).toBeLessThan(6); // 3 blocks x 2 pieces = 6 if everything were re-sent
    const f = store.index.children(ROOT).find((i) => i.name === 'one.bin');
    const out = new Uint8Array(f.size);
    let o = 0;
    for await (const c of new Reader(tg).range(f, 0, f.size - 1)) (out.set(c, o), (o += c.length));
    expect(out).toEqual(data);
    void origRetry;
  }, 120000);

  it('a conversion that dies mid-way continues by itself after a reload', async () => {
    const tg = new FakeTg();
    const store = new DriveStore(tg);
    await store.create('pw');
    const data = randomBytes(PLAIN_BLOCK * 3); // 3 blocks either way = one part
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
    const up = new Uploader(tg, store, { storage });
    up.add([{ file: new File([data], 'x.bin', { lastModified: 9 }), parent: ROOT }]);
    await waitIdle(up);
    const item = store.index.children(ROOT)[0];

    const origSave = tg.savePart.bind(tg);
    tg.savePart = async (a) => {
      if (a.part >= 4) throw new Error('DEAD');
      return origSave(a);
    };
    up.convert([item], true, new Reader(tg)); // encrypted -> open
    await waitIdle(up);
    expect(up.tasks.at(-1).status).toBe('error');
    await up.persisting;
    await up.persist();

    tg.savePart = origSave;
    const up2 = new Uploader(tg, store, { storage });
    await up2.restore({ reader: new Reader(tg) });
    await waitIdle(up2);
    const o = store.index.get(item.id);
    expect(o.open).toBe(true);
    expect(await new Reader(tg).readAll(o)).toEqual(data);
    expect(mem.has('tdrive.pending')).toBe(false);
  }, 60000);
});
