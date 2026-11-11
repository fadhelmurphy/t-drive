import { h, icon } from './dom.js';

function modal({ title, body, actions, onClose, wide }) {
  const prevFocus = document.activeElement;
  const backdrop = h('div', { class: 'modal-backdrop' });
  const box = h(
    'div',
    { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('h2', { class: 'modal-title' }, title),
    body,
    actions ? h('div', { class: 'modal-actions' }, actions) : null,
  );
  backdrop.append(box);
  const close = (v) => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    prevFocus?.focus?.();
    onClose?.(v);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(null);
    }
    if (e.key === 'Tab') {
      const f = [...box.querySelectorAll('button,input,select,a[href],[tabindex]:not([tabindex="-1"])')].filter(
        (x) => !x.disabled,
      );
      if (!f.length) return;
      const [first, last] = [f[0], f[f.length - 1]];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close(null);
  });
  document.body.append(backdrop);
  return { box, close };
}

export function promptDialog({ title, label, value = '', okText = 'OK', selectStem = false }) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', type: 'text', value, 'aria-label': label, autocomplete: 'off' });
    const form = h('form', { class: 'modal-body' }, h('label', { class: 'field-label' }, label), input);
    let m;
    const cancel = h('button', { type: 'button', class: 'btn btn-text', onclick: () => m.close(null) }, 'Batal');
    const ok = h('button', { type: 'submit', class: 'btn btn-primary' }, okText);
    form.append(h('div', { class: 'modal-actions' }, cancel, ok));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (v) m.close(v);
    });
    m = modal({ title, body: form, onClose: resolve });
    input.focus();
    const dot = value.lastIndexOf('.');
    if (selectStem && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });
}

export function confirmDialog({ title, message, okText = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let m;
    const ok = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => m.close(true) }, okText);
    m = modal({
      title,
      body: h('p', { class: 'modal-body modal-text' }, message),
      actions: [h('button', { class: 'btn btn-text', onclick: () => m.close(false) }, 'Batal'), ok],
      onClose: (v) => resolve(!!v),
    });
    ok.focus();
  });
}

export function customDialog(opts) {
  return modal(opts);
}

let toastHost;
export function toast(message, { action, onAction, error = false, timeout = 5000 } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h(
    'div',
    { class: `toast${error ? ' toast-error' : ''}` },
    h('span', null, message),
    action
      ? h(
          'button',
          {
            class: 'toast-action',
            onclick: () => {
              el.remove();
              onAction?.();
            },
          },
          action,
        )
      : null,
    h('button', { class: 'icon-btn toast-close', 'aria-label': 'Tutup notifikasi', onclick: () => el.remove() }, icon('close', 16)),
  );
  toastHost.append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

export function errorText(e) {
  const m = e?.errorMessage || e?.message || String(e);
  const map = {
    PHONE_NUMBER_INVALID: 'Nomor telepon tidak valid. Gunakan format internasional, mis. +62812…',
    PHONE_CODE_INVALID: 'Kode salah. Coba lagi.',
    PHONE_CODE_EXPIRED: 'Kode sudah kedaluwarsa. Minta kode baru.',
    PASSWORD_HASH_INVALID: 'Kata sandi 2FA salah.',
    API_ID_INVALID: 'API ID / API hash tidak valid.',
    PHONE_NUMBER_BANNED: 'Nomor ini diblokir Telegram.',
    AUTH_KEY_UNREGISTERED: 'Sesi Telegram berakhir. Silakan masuk lagi.',
  };
  for (const [k, v] of Object.entries(map)) if (m.includes(k)) return v;
  return m;
}
