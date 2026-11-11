import { h, icon, badge } from './dom.js';
import { streamUrl } from '../core/stream.js';
import { formatBytes } from '../core/util.js';

const TEXT_LIMIT = 2 * 1024 * 1024;
const BLOB_LIMIT = 300 * 1024 * 1024; // fallback when no service worker

function kind(item) {
  const m = item.mime || '';
  if (/^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/.test(m)) return 'image';
  if (/^video\//.test(m)) return 'video';
  if (/^audio\//.test(m)) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (/^text\/|json|xml|javascript|csv|markdown/.test(m) || /\.(txt|md|log|csv|json|sql|py|js|ts|yml|yaml|ini|env)$/i.test(item.name)) return 'text';
  return 'none';
}

export class Preview {
  constructor({ reader, streamOk, onDownload }) {
    this.reader = reader;
    this.streamOk = streamOk;
    this.onDownload = onDownload;
    this.el = null;
    this.objectUrl = null;
    this.ctrl = null;
  }

  open(items, index) {
    this.items = items.filter((i) => i.type === 'file');
    this.i = Math.max(0, this.items.indexOf(items[index]));
    if (!this.el) {
      this.el = h('div', { class: 'preview', role: 'dialog', 'aria-modal': 'true', tabindex: '-1' });
      this.onKey = (e) => {
        if (e.key === 'Escape') this.close();
        else if (e.key === 'ArrowRight' && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) this.step(1);
        else if (e.key === 'ArrowLeft' && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) this.step(-1);
      };
      document.addEventListener('keydown', this.onKey, true);
      document.body.append(this.el);
    }
    this.render();
    this.el.focus();
  }

  step(d) {
    const n = this.i + d;
    if (n < 0 || n >= this.items.length) return;
    this.i = n;
    this.render();
  }

  cleanup() {
    this.ctrl?.abort();
    this.ctrl = new AbortController();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  close() {
    this.cleanup();
    document.removeEventListener('keydown', this.onKey, true);
    this.el?.remove();
    this.el = null;
  }

  async src(item) {
    if (this.streamOk) return streamUrl(item);
    if (item.size > BLOB_LIMIT) throw new Error('File terlalu besar untuk dipratinjau tanpa service worker.');
    const data = await this.reader.readAll(item, this.ctrl.signal);
    this.objectUrl = URL.createObjectURL(new Blob([data], { type: item.mime }));
    return this.objectUrl;
  }

  render() {
    this.cleanup();
    const item = this.items[this.i];
    const stage = h('div', { class: 'preview-stage' }, h('span', { class: 'spinner' }));
    const signal = this.ctrl.signal;
    this.el.setAttribute('aria-label', `Pratinjau ${item.name}`);
    this.el.replaceChildren(
      ...[
      h(
        'header',
        { class: 'preview-bar' },
        h('button', { class: 'icon-btn icon-btn-light', 'aria-label': 'Tutup pratinjau', onclick: () => this.close() }, icon('close')),
        badge(item),
        h('span', { class: 'preview-name', title: item.name }, item.name),
        h('span', { class: 'preview-size' }, formatBytes(item.size)),
        h('button', { class: 'icon-btn icon-btn-light', 'aria-label': 'Unduh', onclick: () => this.onDownload([item]) }, icon('download')),
      ),
      this.i > 0 ? h('button', { class: 'preview-nav prev', 'aria-label': 'Sebelumnya', onclick: () => this.step(-1) }, icon('left', 28)) : null,
      stage,
      this.i < this.items.length - 1 ? h('button', { class: 'preview-nav next', 'aria-label': 'Berikutnya', onclick: () => this.step(1) }, icon('right', 28)) : null,
      ].filter(Boolean),
    );

    const show = (node) => !signal.aborted && stage.replaceChildren(node);
    const fail = (e) =>
      show(h('div', { class: 'preview-msg' }, h('p', null, 'Pratinjau gagal dimuat.'), h('p', { class: 'muted' }, e?.message || String(e))));

    const k = kind(item);
    (async () => {
      if (k === 'none') {
        show(
          h(
            'div',
            { class: 'preview-msg' },
            badge(item),
            h('p', null, 'Pratinjau tidak tersedia untuk jenis file ini.'),
            h('button', { class: 'btn btn-primary', onclick: () => this.onDownload([item]) }, icon('download', 18), ' Unduh'),
          ),
        );
        return;
      }
      if (k === 'text') {
        const parts = [];
        let len = 0;
        if (item.size) {
          for await (const c of this.reader.range(item, 0, Math.min(item.size, TEXT_LIMIT) - 1, signal)) {
            parts.push(c.slice());
            len += c.length;
          }
        }
        const buf = new Uint8Array(len);
        let o = 0;
        for (const p of parts) buf.set(p, o), (o += p.length);
        const text = new TextDecoder().decode(buf);
        show(h('pre', { class: 'preview-text' }, text + (item.size > TEXT_LIMIT ? '\n\n… (dipotong, unduh untuk melihat semuanya)' : '')));
        return;
      }
      const src = await this.src(item);
      if (k === 'image') {
        const img = h('img', { class: 'preview-media', alt: item.name, src });
        img.addEventListener('error', () => fail(new Error('Gambar tidak bisa ditampilkan')));
        show(img);
      } else if (k === 'video') {
        const v = h('video', { class: 'preview-media', controls: true, autoplay: true, playsinline: true, src });
        v.addEventListener('error', () => fail(new Error('Format video tidak didukung browser ini')));
        show(v);
      } else if (k === 'audio') {
        show(h('div', { class: 'preview-msg' }, badge(item), h('audio', { controls: true, autoplay: true, src })));
      } else if (k === 'pdf') {
        show(h('iframe', { class: 'preview-frame', title: item.name, src }));
      }
    })().catch((e) => {
      if (!signal.aborted) fail(e);
    });
  }
}
