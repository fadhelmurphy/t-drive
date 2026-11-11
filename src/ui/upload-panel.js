import { h, icon, badge } from './dom.js';
import { formatBytes } from '../core/util.js';
import { confirmDialog } from './dialogs.js';

export class UploadPanel {
  constructor(uploader) {
    this.uploader = uploader;
    this.collapsed = false;
    this.el = h('section', { class: 'upload-panel', 'aria-label': 'Unggahan', hidden: true });
    this.frame = 0;
    uploader.addEventListener('change', () => {
      if (!this.frame) this.frame = requestAnimationFrame(() => ((this.frame = 0), this.render()));
    });
  }

  render() {
    const tasks = this.uploader.tasks;
    if (!tasks.length) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    const active = tasks.filter((t) => t.status === 'queued' || t.status === 'uploading').length;
    const failed = tasks.filter((t) => t.status === 'error').length;
    const title = active
      ? `Mengunggah ${active} item`
      : failed
        ? `${failed} unggahan gagal`
        : `${tasks.filter((t) => t.status === 'done').length} unggahan selesai`;

    const head = h(
      'div',
      { class: 'up-head' },
      h('span', { class: 'up-title' }, title),
      h(
        'button',
        {
          class: 'icon-btn',
          'aria-label': this.collapsed ? 'Tampilkan daftar unggahan' : 'Sembunyikan daftar unggahan',
          'aria-expanded': String(!this.collapsed),
          onclick: () => {
            this.collapsed = !this.collapsed;
            this.render();
          },
        },
        icon(this.collapsed ? 'left' : 'chevron', 18),
      ),
      h(
        'button',
        {
          class: 'icon-btn',
          'aria-label': 'Tutup panel unggahan',
          onclick: async () => {
            if (active) {
              const ok = await confirmDialog({
                title: 'Batalkan semua unggahan?',
                message: `${active} unggahan belum selesai akan dibatalkan.`,
                okText: 'Batalkan unggahan',
                danger: true,
              });
              if (!ok) return;
              for (const t of tasks) this.uploader.cancel(t.id);
            }
            this.uploader.clearFinished();
          },
        },
        icon('close', 18),
      ),
    );

    const list = this.collapsed
      ? null
      : h(
          'ul',
          { class: 'up-list' },
          tasks.map((t) => {
            const pct = t.size ? Math.floor((t.loaded / t.size) * 100) : t.status === 'done' ? 100 : 0;
            const status =
              t.status === 'done'
                ? 'Selesai'
                : t.status === 'error'
                  ? `Gagal: ${t.error}`
                  : t.status === 'canceled'
                    ? 'Dibatalkan'
                    : t.status === 'queued'
                      ? 'Antre'
                      : t.note || `${formatBytes(t.loaded)} dari ${formatBytes(t.size)} · ${pct}%`;
            let action = null;
            if (t.status === 'queued' || t.status === 'uploading') {
              action = h('button', { class: 'icon-btn', 'aria-label': `Batalkan ${t.name}`, onclick: () => this.uploader.cancel(t.id) }, icon('close', 16));
            } else if (t.status === 'error' || t.status === 'canceled') {
              action = h('button', { class: 'icon-btn', 'aria-label': `Ulangi ${t.name}`, onclick: () => this.uploader.retry(t.id) }, icon('retry', 16));
            } else {
              action = h('span', { class: 'up-check', 'aria-hidden': 'true' }, icon('check', 18));
            }
            return h(
              'li',
              { class: `up-row up-${t.status}` },
              badge({ type: 'file', name: t.name, mime: t.file.type }),
              h(
                'div',
                { class: 'up-info' },
                h('span', { class: 'up-name', title: t.name }, t.name),
                t.status === 'uploading'
                  ? h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { class: 'progress-bar', style: { width: pct + '%' } }))
                  : null,
                h('span', { class: 'up-status' }, status),
              ),
              action,
            );
          }),
        );
    this.el.replaceChildren(head, list);
  }
}
