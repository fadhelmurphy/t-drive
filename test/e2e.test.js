import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FakeTg } from './fake-tg.js';
import { DriveStore, ConflictError } from '../src/core/drive.js';
import { Uploader } from '../src/core/uploader.js';
import { Reader } from '../src/core/reader.js';
import { CIPHER_BLOCK, LAYOUT, PLAIN_BLOCK } from '../src/core/blocks.js';
import { WrongPassphraseError, randomBytes, toB64 } from '../src/core/crypto.js';
import { ROOT } from '../src/core/drive-index.js';
import { copyToDrive, createShare, manifestChildren, openShare, parseShareHash, revokeShare, shareLink } from '../src/core/share.js';

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
    up.add([{ file: new File([randomBytes(PLAIN_BLOCK * 4)], 'besar.bin'), parent: ROOT }]);
    const t = up.tasks[2];
    await new Promise((r) => setTimeout(r, 5));
    up.cancel(t.id);
    await waitIdle(up);
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
});
