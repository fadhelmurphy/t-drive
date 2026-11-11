/* T-Drive service worker: turns /stream/<id>/<name> requests into byte streams.
 * The page holds the Telegram connection and keys; this worker only relays
 * bytes over a MessageChannel, so nothing secret lives here. */
const PREFIX = new URL('./stream/', self.registration.scope).pathname;
const REPLY_TIMEOUT = 30000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;
  e.respondWith(handle(e, url));
});

async function pickClient(e) {
  if (e.clientId) {
    const c = await self.clients.get(e.clientId);
    if (c) return c;
  }
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all.find((c) => c.focused) || all.find((c) => c.visibilityState === 'visible') || all[0];
}

function channel(port) {
  const queue = [];
  const waiters = [];
  port.onmessage = (m) => {
    const w = waiters.shift();
    if (w) w(m.data);
    else queue.push(m.data);
  };
  return {
    next(timeout = REPLY_TIMEOUT) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve({ error: 'Aplikasi tidak merespons', status: 504 }), timeout);
        waiters.push((d) => {
          clearTimeout(t);
          resolve(d);
        });
      });
    },
  };
}

async function handle(e, url) {
  const id = decodeURIComponent(url.pathname.slice(PREFIX.length).split('/')[0] || '');
  const client = await pickClient(e);
  if (!client) return new Response('Buka aplikasi T-Drive di tab lain terlebih dahulu.', { status: 503 });

  const mc = new MessageChannel();
  const port = mc.port1;
  const rx = channel(port);
  client.postMessage(
    {
      type: 'tdrive-stream',
      id,
      range: e.request.headers.get('range'),
      download: url.searchParams.get('dl') === '1',
    },
    [mc.port2],
  );

  const head = await rx.next();
  if (head.error) {
    port.close();
    return new Response(head.error, { status: head.status || 500, headers: head.headers || {} });
  }
  if (e.request.method === 'HEAD' || head.empty) {
    port.postMessage({ op: 'cancel' });
    port.close();
    return new Response(null, { status: head.status, headers: head.headers });
  }

  const body = new ReadableStream(
    {
      async pull(ctrl) {
        port.postMessage({ op: 'next' });
        const m = await rx.next(120000);
        if (m.error) {
          ctrl.error(new Error(m.error));
          port.close();
        } else if (m.done) {
          ctrl.close();
          port.close();
        } else {
          ctrl.enqueue(new Uint8Array(m.chunk));
        }
      },
      cancel() {
        port.postMessage({ op: 'cancel' });
        port.close();
      },
    },
    { highWaterMark: 1 },
  );
  return new Response(body, { status: head.status, headers: head.headers });
}
