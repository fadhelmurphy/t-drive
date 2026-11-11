// Recipient side of a share link: browse, preview, download, or copy into your own drive.
import { h, icon, badge, folderIcon } from './dom.js';
import { logo } from './auth.js';
import { Preview } from './preview.js';
import { toast, errorText } from './dialogs.js';
import { streamUrl } from '../core/stream.js';
import { ROOT } from '../core/drive-index.js';
import { copyToDrive, manifestChildren } from '../core/share.js';
import { formatBytes } from '../core/util.js';

const BLOB_DOWNLOAD_LIMIT = 1024 * 1024 * 1024;

export class ShareView {
  constructor(o) {
    Object.assign(this, o); // root, manifest, reader, streamOk, shareTg, myTg, drive (nullable), onHome
    this.folder = ROOT;
    this.selection = new Set();
    this.preview = new Preview({ reader: this.reader, streamOk: this.streamOk, onDownload: (items) => this.download(items) });
  }

  mount() {
    this.render();
  }

  crumbs() {
    const out = [];
    let cur = this.folder;
    while (cur !== ROOT) {
      const it = this.manifest.items[cur];
      if (!it) break;
      out.unshift(it);
      cur = it.parent;
    }
    return out;
  }

  render() {
    const items = manifestChildren(this.manifest, this.folder).sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name, 'id', { numeric: true }) : a.type === 'folder' ? -1 : 1,
    );
    this.visible = items;
    const crumbs = this.crumbs();
    const chosen = [...this.selection].map((id) => this.manifest.items[id]).filter(Boolean);
    const target = chosen.length ? chosen : items;

    const crumbEls = [
      h('button', { class: `crumb${crumbs.length ? '' : ' current'}`, onclick: () => this.go(ROOT) }, this.manifest.name || 'Dibagikan'),
      ...crumbs.map((c, i) => [
        h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, icon('chevron', 18)),
        h('button', { class: `crumb${i === crumbs.length - 1 ? ' current' : ''}`, onclick: () => this.go(c.id) }, c.name),
      ]),
    ];

    const bar = h(
      'div',
      { class: 'share-bar' },
      h('button', { class: 'btn btn-outline', onclick: () => this.download(this.filesIn(target)) }, icon('download', 18), chosen.length ? ' Unduh terpilih' : ' Unduh semua di sini'),
      this.drive
        ? h('button', { class: 'btn btn-primary', onclick: () => this.save(target) }, icon('drive', 18), chosen.length ? ' Simpan terpilih ke Drive saya' : ' Simpan semua ke Drive saya')
        : null,
    );

    const list = items.length
      ? h(
          'div',
          { class: 'share-items', role: 'list' },
          items.map((it) => {
            const check = h('input', {
              type: 'checkbox',
              'aria-label': `Pilih ${it.name}`,
              checked: this.selection.has(it.id),
              onchange: (e) => {
                e.target.checked ? this.selection.add(it.id) : this.selection.delete(it.id);
                this.render();
              },
            });
            const open = () => (it.type === 'folder' ? this.go(it.id) : this.preview.open(items.filter((x) => x.type === 'file'), items.filter((x) => x.type === 'file').indexOf(it)));
            return h(
              'div',
              { class: 'share-item', role: 'listitem' },
              check,
              h('button', { class: 'link', onclick: open }, it.type === 'folder' ? h('span', { class: 'folder-ic' }, folderIcon(20)) : badge(it), h('span', { class: 'item-name', title: it.name }, it.name)),
              h('span', { class: 'muted' }, it.type === 'file' ? formatBytes(it.size) : '—'),
              it.type === 'file' ? h('button', { class: 'icon-btn', 'aria-label': `Unduh ${it.name}`, onclick: () => this.download([it]) }, icon('download', 18)) : null,
            );
          }),
        )
      : h('p', { class: 'share-note' }, 'Folder ini kosong.');

    this.root.replaceChildren(
      h(
        'main',
        { class: 'share-page' },
        h(
          'div',
          { class: 'share-top' },
          logo(32),
          h('h1', null, `Dibagikan: ${this.manifest.name}`),
          h('button', { class: 'btn btn-text', onclick: () => this.onHome() }, this.drive ? 'Buka Drive saya' : 'Buka T-Drive'),
        ),
        h('div', { class: 'crumbs' }, crumbEls),
        bar,
        list,
        h(
          'p',
          { class: 'share-note' },
          icon('lock', 14),
          this.drive
            ? ' File tetap terenkripsi; “Simpan” menyalin tanpa mengunggah ulang.'
            : ' Ingin menyimpan ke drive sendiri? Buka T-Drive, masuk, lalu buka link ini lagi.',
        ),
      ),
    );
  }

  go(folder) {
    this.folder = folder;
    this.selection.clear();
    this.render();
  }

  filesIn(items) {
    const out = [];
    const walk = (it) => (it.type === 'file' ? out.push(it) : manifestChildren(this.manifest, it.id).forEach(walk));
    items.forEach(walk);
    return out;
  }

  async save(items) {
    const t = toast('Menyalin ke drive-mu…', { timeout: 0 });
    try {
      const n = await copyToDrive({ shareTg: this.shareTg, myTg: this.myTg, drive: this.drive, manifest: this.manifest, ids: items.map((i) => i.id), onStep: (x) => (t.firstChild.textContent = x) });
      t.remove();
      toast(`${n} file disimpan di Drive Saya.`);
    } catch (e) {
      t.remove();
      toast('Gagal menyimpan: ' + errorText(e), { error: true });
    }
  }

  async download(files) {
    if (!files.length) return toast('Tidak ada file untuk diunduh.');
    for (const f of files) {
      if (this.streamOk) {
        const a = h('a', { href: streamUrl(f, { download: true }), download: f.name, hidden: true });
        document.body.append(a);
        a.click();
        a.remove();
        if (files.length > 1) await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      if (f.size > BLOB_DOWNLOAD_LIMIT) {
        toast(`“${f.name}” terlalu besar untuk diunduh tanpa service worker.`, { error: true });
        continue;
      }
      const t = toast(`Menyiapkan “${f.name}”…`, { timeout: 0 });
      try {
        const data = await this.reader.readAll(f);
        const url = URL.createObjectURL(new Blob([data], { type: f.mime }));
        const a = h('a', { href: url, download: f.name, hidden: true });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (e) {
        toast('Gagal mengunduh: ' + errorText(e), { error: true });
      } finally {
        t.remove();
      }
    }
  }
}
