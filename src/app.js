// Session lifecycle: credentials -> Telegram login -> passphrase -> drive.
import { Tg } from './core/tg.js';
import { DriveStore } from './core/drive.js';
import { Reader } from './core/reader.js';
import { Uploader } from './core/uploader.js';
import { WrongPassphraseError, deriveKey, fromB64, randomBytes, seal, toB64, unseal } from './core/crypto.js';
import { installStreamBridge, registerStreamWorker } from './core/stream.js';
import { askApiCredentials, askPassphrase, runLogin, showLoading } from './ui/auth.js';
import { errorText } from './ui/dialogs.js';
import { DriveView } from './ui/drive-view.js';

const LS = {
  api: 'tdrive.api',
  session: 'tdrive.session', // sealed with the passphrase
  salt: 'tdrive.salt',
  channel: 'tdrive.channel',
  prefs: 'tdrive.prefs',
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

export async function start() {
  const streaming = registerStreamWorker();

  let creds = apiCredentials();
  if (!creds) {
    creds = await askApiCredentials();
    store.set(LS.api, creds);
  }

  const ctx = { tg: null, drive: null, passphrase: null, userId: null };

  // 1) Returning user: unlock the locally sealed session with the passphrase.
  if (store.get(LS.session)) {
    let error = '';
    for (;;) {
      const pass = await askPassphrase('unlock', error);
      if (pass?.logout) {
        clearLocal();
        location.reload();
        return;
      }
      showLoading('Membuka kunci…');
      try {
        const s = await unsealSession(pass);
        ctx.passphrase = pass;
        ctx.userId = s.userId;
        ctx.tg = new Tg(creds.apiId, creds.apiHash, s.session);
        break;
      } catch (e) {
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

  showLoading('Menyiapkan penyimpanan…');
  const me = await ctx.tg.me();
  ctx.userId = me.id.toString();
  const cachedChannel = store.get(LS.channel);
  const channel = await ctx.tg.ensureChannel(cachedChannel?.userId === ctx.userId ? cachedChannel : null);
  store.set(LS.channel, { ...channel, userId: ctx.userId });

  // 3) Open or create the drive.
  ctx.drive = new DriveStore(ctx.tg);
  const exists = await ctx.drive.exists();
  let error = '';
  for (;;) {
    let pass = ctx.passphrase;
    if (!pass) {
      pass = await askPassphrase(exists ? 'open' : 'create', error);
      if (pass?.logout) {
        await logout(ctx);
        return;
      }
    }
    showLoading(exists ? 'Membuka drive…' : 'Membuat drive…');
    try {
      if (exists) await ctx.drive.open(pass);
      else await ctx.drive.create(pass);
      if (ctx.passphrase !== pass || !store.get(LS.session)) {
        await sealSession(pass, ctx.tg.session(), ctx.userId);
      }
      ctx.passphrase = pass;
      break;
    } catch (e) {
      // Passphrase may have been changed on another device: ask for the drive one.
      ctx.passphrase = null;
      error = e instanceof WrongPassphraseError ? 'Passphrase drive salah.' : errorText(e);
    }
  }

  const reader = new Reader(ctx.tg);
  const uploader = new Uploader(ctx.tg, ctx.drive);
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

async function lock(ctx, uploader) {
  if (uploader?.active) return false;
  await ctx.drive.flush().catch(() => {});
  ctx.drive.lock();
  await ctx.tg.disconnect();
  location.reload();
  return true;
}

async function logout(ctx, uploader) {
  if (uploader?.active) return false;
  await ctx.drive?.flush().catch(() => {});
  try {
    await ctx.tg.logout();
  } catch {
    /* still clear locally */
  }
  clearLocal();
  location.reload();
  return true;
}
