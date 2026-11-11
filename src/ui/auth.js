import { h, icon } from './dom.js';
import { errorText } from './dialogs.js';

const root = () => document.getElementById('app');

export function logo(size = 36) {
  return h('span', { class: 'logo', style: { width: size + 'px', height: size + 'px' } }, icon('cloud', size * 0.62, { fill: 'currentColor', strokeWidth: '0' }));
}

function screen(title, subtitle, ...content) {
  const r = root();
  r.replaceChildren(
    h(
      'main',
      { class: 'auth' },
      h(
        'div',
        { class: 'auth-card' },
        h('div', { class: 'auth-brand' }, logo(40), h('span', { class: 'brand-name' }, 'T-Drive')),
        h('h1', { class: 'auth-title' }, title),
        subtitle ? h('p', { class: 'auth-sub' }, subtitle) : null,
        ...content,
      ),
    ),
  );
}

export function showLoading(text = 'Memuat…') {
  root().replaceChildren(
    h('main', { class: 'auth' }, h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner' }), h('span', null, text))),
  );
}

function field(label, attrs) {
  const id = 'f-' + Math.random().toString(36).slice(2);
  const input = h('input', { class: 'input', id, ...attrs });
  return { input, el: h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, label), input) };
}

/** Generic one-or-more field form that resolves with the values. */
function formScreen({ title, subtitle, fields, submit, error, extra, validate }) {
  return new Promise((resolve) => {
    const fs = fields.map((f) => field(f.label, f.attrs));
    const err = h('p', { class: 'form-error', role: 'alert' }, error || '');
    const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, submit);
    const form = h('form', { class: 'auth-form', novalidate: true }, fs.map((f) => f.el), err, btn, extra?.(resolve) || null);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const values = fs.map((f) => (f.input.type === 'password' ? f.input.value : f.input.value.trim()));
      const problem = validate?.(values);
      if (problem) {
        err.textContent = problem;
        return;
      }
      btn.disabled = true;
      btn.replaceChildren(h('span', { class: 'spinner spinner-sm' }), ' Memproses…');
      resolve(values);
    });
    screen(title, subtitle, form);
    fs[0]?.input.focus();
  });
}

export async function askApiCredentials(error) {
  const [apiId, apiHash] = await formScreen({
    title: 'Hubungkan ke Telegram',
    subtitle: 'Masukkan API ID dan API hash milikmu dari my.telegram.org › API development tools. Disimpan hanya di browser ini.',
    fields: [
      { label: 'API ID', attrs: { inputmode: 'numeric', autocomplete: 'off', placeholder: '1234567' } },
      { label: 'API hash', attrs: { autocomplete: 'off', placeholder: '0123456789abcdef0123456789abcdef', spellcheck: false } },
    ],
    submit: 'Lanjut',
    error,
    validate: ([id, hash]) =>
      !/^\d{3,12}$/.test(id) ? 'API ID harus berupa angka.' : !/^[a-f0-9]{32}$/i.test(hash) ? 'API hash harus 32 karakter heksadesimal.' : null,
  });
  return { apiId: Number(apiId), apiHash };
}

/** Wire GramJS's interactive login to our forms. */
export async function runLogin(tg) {
  let lastError = '';
  let codeViaApp = false;
  await tg.login({
    phoneNumber: async () => {
      const [phone] = await formScreen({
        title: 'Masuk dengan Telegram',
        subtitle: 'Kami akan mengirim kode ke aplikasi Telegram-mu.',
        fields: [{ label: 'Nomor telepon', attrs: { type: 'tel', autocomplete: 'tel', placeholder: '+62812xxxxxxx' } }],
        submit: 'Kirim kode',
        error: lastError,
        validate: ([p]) => (!/^\+?\d{7,15}$/.test(p.replace(/[\s-]/g, '')) ? 'Masukkan nomor dengan kode negara, mis. +62812…' : null),
      });
      lastError = '';
      return phone.replace(/[\s-]/g, '');
    },
    phoneCode: async (isApp) => {
      codeViaApp = isApp ?? codeViaApp;
      const [code] = await formScreen({
        title: 'Masukkan kode',
        subtitle: codeViaApp ? 'Kode dikirim ke aplikasi Telegram di perangkatmu yang lain.' : 'Kode dikirim lewat SMS.',
        fields: [{ label: 'Kode login', attrs: { inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '12345' } }],
        submit: 'Verifikasi',
        error: lastError,
        validate: ([c]) => (!/^\d{4,8}$/.test(c) ? 'Kode berupa 4–8 angka.' : null),
      });
      lastError = '';
      return code;
    },
    password: async (hint) => {
      const [pw] = await formScreen({
        title: 'Verifikasi dua langkah',
        subtitle: hint ? `Petunjuk: ${hint}` : 'Akunmu dilindungi kata sandi tambahan.',
        fields: [{ label: 'Kata sandi Telegram', attrs: { type: 'password', autocomplete: 'current-password' } }],
        submit: 'Masuk',
        error: lastError,
      });
      lastError = '';
      return pw;
    },
    onError: async (e) => {
      lastError = errorText(e);
      const fatal = /API_ID|BANNED|AUTH_RESTART|PHONE_NUMBER_FLOOD/.test(e?.errorMessage || e?.message || '');
      if (/FLOOD/.test(e?.errorMessage || '')) lastError = `Terlalu banyak percobaan. Tunggu ${e.seconds || 'beberapa'} detik.`;
      return fatal;
    },
  });
}

/**
 * mode: 'create' (new drive), 'unlock' (returning user), 'open' (existing drive, new device)
 * Resolves with the passphrase, or { logout: true }.
 */
export function askPassphrase(mode, error) {
  const create = mode === 'create';
  const fields = [{ label: 'Passphrase', attrs: { type: 'password', autocomplete: create ? 'new-password' : 'current-password' } }];
  if (create) fields.push({ label: 'Ulangi passphrase', attrs: { type: 'password', autocomplete: 'new-password' } });
  const titles = {
    create: ['Buat passphrase', 'Passphrase mengenkripsi semua file dan daftar isinya di browser sebelum dikirim ke Telegram. Tidak bisa dipulihkan jika lupa — simpan di password manager.'],
    unlock: ['Buka T-Drive', 'Masukkan passphrase untuk membuka drive di perangkat ini.'],
    open: ['Drive ditemukan', 'Masukkan passphrase drive yang kamu buat sebelumnya.'],
  };
  return formScreen({
    title: titles[mode][0],
    subtitle: titles[mode][1],
    fields,
    submit: create ? 'Buat drive' : 'Buka',
    error,
    validate: ([a, b]) => {
      if (!a) return 'Passphrase wajib diisi.';
      if (create && a.length < 10) return 'Gunakan minimal 10 karakter.';
      if (create && a !== b) return 'Passphrase tidak sama.';
      return null;
    },
    extra:
      mode === 'create'
        ? null
        : (resolve) =>
            h('button', { type: 'button', class: 'btn btn-text btn-block', onclick: () => resolve({ logout: true }) }, 'Keluar dari akun Telegram'),
  }).then((v) => (Array.isArray(v) ? v[0] : v));
}
