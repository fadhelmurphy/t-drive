// Session lifecycle: credentials -> Telegram login -> passphrase -> drive.
import { Tg } from './core/tg.js';
import { DriveStore } from './core/drive.js';
import { Reader } from './core/reader.js';
import { Uploader } from './core/uploader.js';
import { WrongPassphraseError, deriveKey, fromB64, randomBytes, seal, toB64, unseal } from './core/crypto.js';
import { installStreamBridge, registerStreamWorker } from './core/stream.js';
import { openShare, parseShareHash } from './core/share.js';
import { forgetPassphrase, recallPassphrase, rememberPassphrase } from './core/remember.js';
import { ShareView } from './ui/share-view.js';
import { askApiCredentials, pickApiCredentials, askPassphrase, runLogin, showLoading, showNotice } from './ui/auth.js';
import { confirmDialog, errorText } from './ui/dialogs.js';
import { h } from './ui/dom.js';
import { DriveView } from './ui/drive-view.js';

const LS = {
  api: 'tdrive.api',
  session: 'tdrive.session', // sealed with the passphrase
  salt: 'tdrive.salt',
  channel: 'tdrive.channel',
  prefs: 'tdrive.prefs',
  apis: 'tdrive.apis', // saved API ID profiles
};

const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    localStorage.setItem(k, JSON.stringify(v));
  },
  del(k) {
    localStorage.removeItem(k);
  },
};

function apiCredentials() {
  const envId = import.meta.env.VITE_TG_API_ID;
  const envHash = import.meta.env.VITE_TG_API_HASH;
  if (envId && envHash) return { apiId: Number(envId), apiHash: envHash };
  return store.get(LS.api);
}

async function sealSession(passphrase, session, userId) {
  let salt = store.get(LS.salt);
  if (!salt) {
    salt = toB64(randomBytes(16));
    store.set(LS.salt, salt);
  }
  const s = fromB64(salt);
  const key = await deriveKey(passphrase, s);
  store.set(LS.session, toB64(await seal(key, s, { session, userId })));
}

async function unsealSession(passphrase) {
  const sealed = store.get(LS.session);
  const salt = store.get(LS.salt);
  if (!sealed || !salt) return null;
  const key = await deriveKey(passphrase, fromB64(salt));
  return unseal(key, fromB64(sealed));
}

function clearLocal({ keepApi = true } = {}) {
  store.del(LS.session);
  store.del(LS.salt);
  store.del(LS.channel);
  if (!keepApi) store.del(LS.api);
}

async function chooseCredentials(active) {
  let list = store.get(LS.apis) || [];
  if (active && !list.some((p) => p.apiId === active.apiId)) list = [...list, active];
  for (;;) {
    let creds;
    if (list.length) {
      const r = await pickApiCredentials(list);
      if (r.remove) {
        list = list.filter((p) => p.apiId !== r.remove);
        store.set(LS.apis, list);
        if (active?.apiId === r.remove) store.del(LS.api);
        continue;
      }
      creds = r.creds;
    }
    if (!creds) {
      creds = await askApiCredentials();
      list = [...list.filter((p) => p.apiId !== creds.apiId), creds];
      store.set(LS.apis, list);
    }
    store.set(LS.api, creds);
    return creds;
  }
}

/**
 * One tab per browser may hold the Telegram session. Two tabs on the same auth key make
 * Telegram kill it (AUTH_KEY_DUPLICATED), which looks like being logged out at random.
 */
async function claimTab(ctx) {
  if (!navigator.locks) return;
  const hold = (opts) =>
    new Promise((resolve) => {
      navigator.locks
        .request('tdrive-session', opts, (lock) => {
          if (!lock) return resolve(false);
          resolve(true);
          return new Promise(() => {}); // hold until this tab closes
        })
        .catch(() => {
          // Another tab took over: stop using the session here.
          ctx.tg?.disconnect();
          showNotice({ title: 'T-Drive dipakai di tab lain', text: 'Satu sesi hanya boleh aktif di satu tab supaya Telegram tidak memutus login.', button: 'Pakai di tab ini', onClick: () => location.reload() });
        });
    });
  if (await hold({ ifAvailable: true })) return;
  await new Promise((resolve) =>
    showNotice({
      title: 'T-Drive sudah terbuka di tab lain',
      text: 'Memakai sesi yang sama di dua tab membuat Telegram memutus login. Pakai tab ini saja?',
      button: 'Pakai di tab ini',
      onClick: async () => {
        await hold({ steal: true });
        resolve();
      },
    }),
  );
}

export async function start() {
  const streaming = registerStreamWorker();
  const ctx = { tg: null, drive: null, passphrase: null, userId: null };
  await claimTab(ctx);

  let creds = apiCredentials();
  // With a sealed session the active API ID must stay the same one; otherwise let the user pick.
  if (!creds || (!store.get(LS.session) && !import.meta.env.VITE_TG_API_ID)) {
    creds = await chooseCredentials(creds);
  }

  const shareLink = parseShareHash(location.hash);

  // 1) Returning user: unlock the locally sealed session with the passphrase.
  if (store.get(LS.session)) {
    let error = '';
    let remembered = await recallPassphrase();
    for (;;) {
      let pass;
      let remember = true;
      const fromMemory = !!remembered;
      if (fromMemory) {
        pass = remembered;
        remembered = null;
      } else {
        const r = await askPassphrase('unlock', error);
        if (r.logout || r.forgot) {
          if (r.forgot) {
            const ok = await confirmDialog({
              title: 'Lupa passphrase?',
              message:
                'Passphrase tidak bisa dipulihkan: kunci file terenkripsi ada di dalam indeks yang dikunci olehnya. Kamu akan keluar dari perangkat ini, lalu bisa masuk lagi dan membuat passphrase baru (drive baru yang kosong). File mode terbuka tetap bisa diimpor lagi dari Telegram.',
              okText: 'Keluar dan reset',
              danger: true,
            });
            if (!ok) continue;
          }
          clearLocal();
          await forgetPassphrase();
          location.reload();
          return;
        }
        pass = r.pass;
        remember = r.remember;
      }
      showLoading('Membuka kunci…');
      try {
        const s = await unsealSession(pass);
        ctx.passphrase = pass;
        ctx.userId = s.userId;
        ctx.tg = new Tg(creds.apiId, creds.apiHash, s.session);
        if (!fromMemory) {
          if (remember) await rememberPassphrase(pass);
          else await forgetPassphrase();
        }
        break;
      } catch (e) {
        if (fromMemory) await forgetPassphrase();
        error = e instanceof WrongPassphraseError ? 'Passphrase salah.' : errorText(e);
      }
    }
    showLoading('Menghubungkan ke Telegram…');
    try {
      await ctx.tg.connect();
      if (!(await ctx.tg.isAuthorized())) throw new Error('AUTH_KEY_UNREGISTERED');
    } catch (e) {
      if (/AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED/.test(e?.errorMessage || e?.message || '')) {
        await ctx.tg.disconnect();
        clearLocal();
        ctx.tg = null;
      } else {
        throw e;
      }
    }
  }

  // 2) New login.
  if (!ctx.tg) {
    showLoading('Menghubungkan ke Telegram…');
    ctx.tg = new Tg(creds.apiId, creds.apiHash, '');
    try {
      await ctx.tg.connect();
      await runLogin(ctx.tg);
    } catch (e) {
      if (/API_ID/.test(e?.errorMessage || e?.message || '')) {
        store.del(LS.api);
        await ctx.tg.disconnect();
        location.reload();
        return;
      }
      throw e;
    }
  }

  // Opened someone's share link without an unlocked drive: view it with the in-memory session.
  if (shareLink && !ctx.passphrase) {
    await mountShare(ctx, shareLink, streaming);
    return;
  }

  showLoading('Menyiapkan penyimpanan…');
  const me = await ctx.tg.me();
  ctx.userId = me.id.toString();
  const cachedChannel = store.get(LS.channel);
  let channel = await ctx.tg.ensureChannel(cachedChannel?.userId === ctx.userId ? cachedChannel : null, { create: false });
  if (!channel) {
    // Never create a second storage channel silently: a missed lookup would orphan the real drive.
    const ok = await confirmDialog({
      title: 'Drive lama tidak ditemukan',
      message:
        'Channel “T-Drive Storage” tidak ada di akun Telegram ini. Kalau kamu sudah pernah memakai T-Drive, pastikan masuk dengan akun yang sama. Buat drive baru?',
      okText: 'Buat drive baru',
    });
    if (!ok) {
      await logout(ctx);
      return;
    }
    channel = await ctx.tg.ensureChannel(null);
  }
  store.set(LS.channel, { ...channel, userId: ctx.userId });

  // 3) Open or create the drive.
  ctx.drive = new DriveStore(ctx.tg);
  const exists = await ctx.drive.exists();
  let error = '';
  for (;;) {
    let pass = ctx.passphrase;
    let typed = null;
    let reset = false;
    if (!pass) {
      let r = await askPassphrase(exists ? 'open' : 'create', error);
      if (r.logout) {
        await logout(ctx);
        return;
      }
      if (r.forgot) {
        const ok = await confirmDialog({
          title: 'Reset drive?',
          message:
            'Drive lama diganti drive kosong dengan passphrase baru. File terenkripsi lama tidak bisa dibuka lagi (kuncinya hilang bersama passphrase). File mode terbuka bisa diimpor lagi, dan sisa file lama bisa dibersihkan lewat menu akun.',
          okText: 'Reset drive',
          danger: true,
        });
        if (!ok) continue;
        r = await askPassphrase('create');
        if (r.logout) {
          await logout(ctx);
          return;
        }
        reset = true;
      }
      pass = r.pass;
      typed = r;
    }
    showLoading(exists && !reset ? 'Membuka drive…' : 'Membuat drive…');
    try {
      if (reset) await ctx.drive.reset(pass);
      else if (exists) await ctx.drive.open(pass);
      else await ctx.drive.create(pass);
      if (ctx.passphrase !== pass || !store.get(LS.session)) {
        await sealSession(pass, ctx.tg.session(), ctx.userId);
      }
      ctx.passphrase = pass;
      if (typed) {
        if (typed.remember) await rememberPassphrase(pass);
        else await forgetPassphrase();
      }
      break;
    } catch (e) {
      // Passphrase may have been changed on another device: ask for the drive one.
      ctx.passphrase = null;
      await forgetPassphrase();
      error = e instanceof WrongPassphraseError ? 'Passphrase drive salah.' : errorText(e);
    }
  }

  if (shareLink) {
    await mountShare(ctx, shareLink, streaming);
    return;
  }

  const reader = new Reader(ctx.tg);
  const uploader = new Uploader(ctx.tg, ctx.drive);
  uploader.restore({ reader }).catch((e) => console.warn('Unggahan tertunda tidak bisa dipulihkan', e));
  installStreamBridge((id) => ctx.drive.index.get(id), reader);
  const streamOk = await streaming;

  const view = new DriveView({
    root: document.getElementById('app'),
    drive: ctx.drive,
    reader,
    uploader,
    tg: ctx.tg,
    me,
    streamOk,
    prefs: { get: () => store.get(LS.prefs) || {}, set: (p) => store.set(LS.prefs, p) },
    onChangePassphrase: (cur, next) => changePassphrase(ctx, cur, next),
    onLock: () => lock(ctx, uploader),
    onLogout: () => logout(ctx, uploader),
  });
  view.mount();

  window.addEventListener('beforeunload', (e) => {
    if (uploader.active || ctx.drive.dirty || ctx.drive.saving) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

async function mountShare(ctx, link, streaming) {
  showLoading('Membuka link berbagi…');
  const home = () => {
    history.replaceState(null, '', location.pathname + location.search);
    location.reload();
  };
  let opened;
  try {
    opened = await openShare({ tg: ctx.tg, ...link });
  } catch (e) {
    const root = document.getElementById('app');
    root.replaceChildren(
      h('main', { class: 'auth' }, h('div', { class: 'auth-card' }, h('h1', { class: 'auth-title' }, 'Link tidak bisa dibuka'), h('p', { class: 'auth-sub' }, errorText(e)), h('button', { class: 'btn btn-primary btn-block', onclick: home }, 'Buka T-Drive'))),
    );
    return;
  }
  const reader = new Reader(opened.shareTg);
  installStreamBridge((id) => opened.manifest.items[id], reader);
  const streamOk = await streaming;
  new ShareView({
    root: document.getElementById('app'),
    manifest: opened.manifest,
    reader,
    streamOk,
    shareTg: opened.shareTg,
    myTg: ctx.tg,
    drive: ctx.drive,
    onHome: home,
  }).mount();
}

/** Change the passphrase of an unlocked drive. Throws WrongPassphraseError for a wrong current one. */
async function changePassphrase(ctx, current, next) {
  await unsealSession(current);
  await ctx.drive.rekey(next);
  await sealSession(next, ctx.tg.session(), ctx.userId);
  const hadRemembered = !!(await recallPassphrase());
  ctx.passphrase = next;
  if (hadRemembered) await rememberPassphrase(next);
}

async function lock(ctx, uploader) {
  if (uploader?.active) return false;
  await ctx.drive.flush().catch(() => {});
  await forgetPassphrase();
  ctx.drive.lock();
  await ctx.tg.disconnect();
  location.reload();
  return true;
}

async function logout(ctx, uploader) {
  if (uploader?.active) return false;
  await ctx.drive?.flush().catch(() => {});
  await forgetPassphrase();
  try {
    await ctx.tg.logout();
  } catch {
    /* still clear locally */
  }
  clearLocal();
  location.reload();
  return true;
}
