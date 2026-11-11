import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FakeTg } from './fake-tg.js';
import { DriveStore, ConflictError } from '../src/core/drive.js';
import { Uploader } from '../src/core/uploader.js';
import { Reader } from '../src/core/reader.js';
import { LAYOUT, PLAIN_BLOCK } from '../src/core/blocks.js';
import { WrongPassphraseError, randomBytes } from '../src/core/crypto.js';
import { ROOT } from '../src/core/drive-index.js';

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
});
