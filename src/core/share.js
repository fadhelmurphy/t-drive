// Sharing: a share is a private Telegram channel holding forwarded copies of the file
// parts plus an encrypted manifest (pinned). The link carries the channel invite and the
// manifest key in the URL fragment, which never leaves the browser.
import { fromB64, importFileKey, randomBytes, seal, toB64, unseal } from './crypto.js';
import { downloadDocument, uploadBuffer } from './drive.js';
import { ROOT } from './drive-index.js';
import { withRetry } from './tg.js';
import { uid } from './util.js';

const MANIFEST_NAME = 'manifest.bin';
const b64url = (u8) => toB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

export function shareLink(share, base = location.href.split('#')[0]) {
  return `${base}#/s/${share.invite}.${b64url(fromB64(share.key))}`;
}

/** Parse "#/s/<invite>.<key>" -> { invite, key } or null. */
export function parseShareHash(hash) {
  const m = /^#\/s\/([\w-]+)\.([\w-]+)$/.exec(hash || '');
  return m ? { invite: m[1], key: toB64(unb64url(m[2])) } : null;
}

/** Collect the chosen items and all their live descendants (keeps tree shape). */
function collect(index, ids) {
  const items = {};
  const add = (id, parent) => {
    const it = index.get(id);
    if (!it || it.trashed) return;
    items[id] = { ...pick(it), parent };
    if (it.type === 'folder') for (const c of index.children(id)) add(c.id, id);
  };
  for (const id of ids) add(id, ROOT);
  return items;
}

function pick(it) {
  const o = { id: it.id, type: it.type, name: it.name };
  if (it.type === 'file') Object.assign(o, { size: it.size, mime: it.mime, modified: it.modified, parts: it.parts, ...(it.open ? { open: true } : { key: it.key, nonce: it.nonce }), ...(it.thumb ? { thumb: it.thumb } : {}) });
  return o;
}

/**
 * Create a share for index items. onStep(text) reports progress.
 * Returns the stored share record (already added to the index).
 */
/** Re-throw with the failing step, so Telegram's bare error codes are traceable. */
function stepError(step, e) {
  const msg = e?.errorMessage || e?.message || String(e);
  return Object.assign(new Error(`${step}: ${msg}`), { cause: e });
}

export async function createShare({ tg, drive, ids, name, onStep: report = () => {} }) {
  let step = 'Menyiapkan';
  const onStep = (t) => ((step = t), report(t));
  const items = collect(drive.index, ids);
  const files = Object.values(items).filter((i) => i.type === 'file');
  if (!files.length) throw new Error('Tidak ada file untuk dibagikan');
  const partIds = [...new Set(files.flatMap((f) => f.parts))];

  onStep('Membuat channel berbagi…');
  let ch;
  try {
    ch = await withRetry(() => tg.createShareChannel());
  } catch (e) {
    throw stepError(step, e);
  }
  const shareTg = tg.forChannel(ch);
  try {
    onStep(`Meneruskan ${partIds.length} potongan file…`);
    const map = await withRetry(() => tg.forwardTo(shareTg, partIds));
    for (const f of files) f.parts = f.parts.map((p) => map.get(p));

    onStep('Menyimpan manifes terenkripsi…');
    const rawKey = randomBytes(32);
    const key = await importFileKey(rawKey);
    const salt = randomBytes(16);
    const manifest = { v: 1, name, items };
    const blob = await seal(key, salt, manifest);
    const msg = await uploadBuffer(shareTg, blob, MANIFEST_NAME);
    await withRetry(() => shareTg.pin(msg.id));

    onStep('Membuat link…');
    const invite = await withRetry(() => shareTg.exportInvite());
    const share = { id: uid(), name, created: Date.now(), channel: ch, invite, key: toB64(rawKey), count: files.length };
    drive.mutate((ix) => ix.addShare(share));
    await drive.flush();
    return share;
  } catch (e) {
    shareTg.deleteChannel().catch(() => {});
    throw stepError(step, e);
  }
}

export async function revokeShare({ tg, drive, share }) {
  try {
    await withRetry(() => tg.forChannel(share.channel).deleteChannel());
  } catch (e) {
    // Already gone (deleted from Telegram) is fine; anything else must surface.
    if (!/CHANNEL_INVALID|CHANNEL_PRIVATE/.test(e?.errorMessage || e?.message || '')) throw e;
  }
  drive.mutate((ix) => ix.removeShare(share.id));
  await drive.flush();
}

/** Open a share link: join its channel, read and decrypt the manifest. */
export async function openShare({ tg, invite, key }) {
  let step = 'Bergabung ke channel berbagi';
  let ch, shareTg, m, blob;
  try {
    ch = await withRetry(() => tg.joinInvite(invite));
    shareTg = tg.forChannel(ch);
    step = 'Membaca manifes';
    const pinned = await withRetry(() => shareTg.pinnedId());
    if (!pinned) throw new Error('Manifes berbagi tidak ditemukan (share mungkin sudah dicabut)');
    [m] = await withRetry(() => shareTg.getMessages([pinned]));
    if (!m?.media?.document) throw new Error('Manifes berbagi tidak ditemukan');
    blob = await downloadDocument(shareTg, m.media.document);
  } catch (e) {
    throw stepError(step, e);
  }
  const k = await importFileKey(fromB64(key));
  let manifest;
  try {
    manifest = await unseal(k, blob);
  } catch {
    throw new Error('Kunci link salah atau link rusak');
  }
  return { shareTg, manifest };
}

/** Children of a folder in a manifest (ROOT for top level). */
export function manifestChildren(manifest, parent) {
  return Object.values(manifest.items).filter((i) => i.parent === parent);
}

/** Copy manifest items (files/folders) into the user's own drive. Returns copied file count. */
export async function copyToDrive({ shareTg, myTg, drive, manifest, ids, parent = ROOT, onStep = () => {} }) {
  const chosen = {};
  const add = (id) => {
    const it = manifest.items[id];
    if (!it || chosen[id]) return;
    chosen[id] = it;
    if (it.type === 'folder') for (const c of manifestChildren(manifest, id)) add(c.id);
  };
  ids.forEach(add);
  const files = Object.values(chosen).filter((i) => i.type === 'file');
  const partIds = [...new Set(files.flatMap((f) => f.parts))];
  onStep(`Menyalin ${partIds.length} potongan ke drive-mu…`);
  let map = new Map();
  try {
    if (partIds.length) map = await withRetry(() => shareTg.forwardTo(myTg, partIds));
  } catch (e) {
    throw stepError('Menyalin ke drive-mu', e);
  }

  drive.mutate((ix) => {
    const made = new Map([[ROOT, parent]]);
    const place = (it) => {
      if (made.has(it.id)) return made.get(it.id);
      const par = ids.includes(it.id) ? parent : place(manifest.items[it.parent]);
      if (it.type === 'folder') {
        const f = ix.createFolder(it.name, par);
        made.set(it.id, f.id);
        return f.id;
      }
      const f = ix.addFile({
        name: it.name,
        parent: par,
        size: it.size,
        mime: it.mime,
        key: it.key,
        nonce: it.nonce,
        open: !!it.open,
        thumb: it.thumb,
        parts: it.parts.map((p) => map.get(p)),
        lastModified: it.modified,
      });
      made.set(it.id, f.id);
      return f.id;
    };
    Object.values(chosen).forEach(place);
  });
  await drive.flush();
  return files.length;
}
