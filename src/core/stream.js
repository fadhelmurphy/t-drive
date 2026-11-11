// Page side of the streaming bridge (see public/sw.js).
import { parseRange } from './blocks.js';

const SANDBOX_CSP =
  "sandbox allow-downloads; default-src 'none'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'unsafe-inline'";

let base = new URL('./', document.baseURI);
let swReady = false;

export function streamUrl(item, { download = false } = {}) {
  const u = new URL(`stream/${encodeURIComponent(item.id)}/${encodeURIComponent(item.name)}`, base);
  if (download) u.searchParams.set('dl', '1');
  return u.href;
}

export function streamingAvailable() {
  return swReady && !!navigator.serviceWorker?.controller;
}

/** Register the worker and wait (briefly) until it controls this page. */
export async function registerStreamWorker() {
  if (!('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname });
    if (!navigator.serviceWorker.controller) {
      await Promise.race([
        new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    }
    swReady = !!navigator.serviceWorker.controller;
  } catch (e) {
    console.warn('Service worker tidak tersedia', e);
    swReady = false;
  }
  return swReady;
}

function contentDisposition(name, download) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Answer stream requests from the worker. getItem(id) -> drive item or null. */
export function installStreamBridge(getItem, reader) {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'tdrive-stream' || !e.ports[0]) return;
    serve(e.data, e.ports[0], getItem, reader).catch((err) => {
      try {
        e.ports[0].postMessage({ error: String(err?.message || err), status: 500 });
      } catch {
        /* port closed */
      }
    });
  });
}

async function serve({ id, range, download }, port, getItem, reader) {
  const item = getItem(id);
  if (!item || item.type !== 'file') {
    port.postMessage({ error: 'File tidak ditemukan atau drive terkunci', status: 404 });
    return;
  }
  const size = item.size;
  const r = parseRange(range, size);
  const mime = item.mime || 'application/octet-stream';
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': contentDisposition(item.name, download),
  };
  // Decrypted user content must never run script on our origin.
  if (mime !== 'application/pdf') headers['Content-Security-Policy'] = SANDBOX_CSP;

  if (r?.invalid) {
    port.postMessage({ error: 'Range tidak valid', status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return;
  }
  if (size === 0) {
    port.postMessage({ status: 200, headers: { ...headers, 'Content-Length': '0' }, empty: true });
    return;
  }
  const start = r ? r.start : 0;
  const end = r ? r.end : size - 1;
  headers['Content-Length'] = String(end - start + 1);
  if (r) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

  const ctrl = new AbortController();
  const it = reader.range(item, start, end, ctrl.signal);
  port.onmessage = async (m) => {
    if (m.data?.op === 'cancel') {
      ctrl.abort();
      it.return?.().catch(() => {});
      return;
    }
    if (m.data?.op !== 'next') return;
    try {
      const { value, done } = await it.next();
      if (done) port.postMessage({ done: true });
      else {
        const copy = value.slice(); // cached blocks must not be transferred away
        port.postMessage({ chunk: copy.buffer }, [copy.buffer]);
      }
    } catch (err) {
      if (!ctrl.signal.aborted) port.postMessage({ error: String(err?.message || err) });
    }
  };
  port.postMessage({ status: r ? 206 : 200, headers });
}
