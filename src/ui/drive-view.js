import { h, icon, badge, folderIcon } from './dom.js';
import { confirmDialog, promptDialog, toast, errorText } from './dialogs.js';
import { logo } from './auth.js';
import { UploadPanel } from './upload-panel.js';
import { Preview } from './preview.js';
import { pickFolder } from './move-dialog.js';
import { ROOT } from '../core/drive-index.js';
import { ConflictError } from '../core/drive.js';
import { streamUrl } from '../core/stream.js';
import { formatBytes, formatDate } from '../core/util.js';

const SECTIONS = [
  { id: 'drive', label: 'Drive Saya', icon: 'drive' },
  { id: 'recent', label: 'Terbaru', icon: 'clock' },
  { id: 'starred', label: 'Berbintang', icon: 'star' },
  { id: 'trash', label: 'Sampah', icon: 'trash' },
];
const SORTS = {
  'name-asc': ['Nama (A–Z)', (a, b) => a.name.localeCompare(b.name, 'id', { numeric: true })],
  'name-desc': ['Nama (Z–A)', (a, b) => b.name.localeCompare(a.name, 'id', { numeric: true })],
  'modified-desc': ['Terbaru diubah', (a, b) => b.modified - a.modified],
  'modified-asc': ['Terlama diubah', (a, b) => a.modified - b.modified],
  'size-desc': ['Ukuran terbesar', (a, b) => (b.size || 0) - (a.size || 0)],
  'size-asc': ['Ukuran terkecil', (a, b) => (a.size || 0) - (b.size || 0)],
};
const THUMB_TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/;
const THUMB_MAX = 25 * 1024 * 1024;
const BLOB_DOWNLOAD_LIMIT = 1024 * 1024 * 1024;

export class DriveView {
  constructor(o) {
    Object.assign(this, o);
    const p = this.prefs.get();
    this.state = {
      section: 'drive',
      folder: ROOT,
      query: '',
      prevSection: 'drive',
      selection: new Set(),
      anchor: null,
      layout: p.layout || 'grid',
      sort: SORTS[p.sort] ? p.sort : 'name-asc',
    };
    this.thumbs = new Map(); // itemId -> objectURL | 'none' | Promise
    this.thumbQueue = [];
    this.thumbActive = 0;
    this.uploadPanel = new UploadPanel(this.uploader);
    this.preview = new Preview({ reader: this.reader, streamOk: this.streamOk, onDownload: (items) => this.download(items) });
    this.menu = null;
  }

  get index() {
    return this.drive.index;
  }

  // ---------------- Shell ----------------

  mount() {
    this.fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => this.pickFiles(e.target) });
    this.folderInput = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true, onchange: (e) => this.pickFiles(e.target) });
    this.search = h('input', {
      class: 'search-input',
      type: 'search',
      placeholder: 'Telusuri di Drive',
      'aria-label': 'Telusuri di Drive',
      oninput: () => this.onSearch(),
    });
    this.saveStatus = h('span', { class: 'save-status', role: 'status', 'aria-live': 'polite' });
    this.navEl = h('nav', { class: 'nav', 'aria-label': 'Navigasi utama' });
    this.mainEl = h('main', { class: 'main', tabindex: '-1' });
    this.shell = h(
      'div',
      { class: 'shell' },
      h(
        'header',
        { class: 'topbar' },
        h('button', { class: 'icon-btn nav-toggle', 'aria-label': 'Buka menu', onclick: () => this.shell.classList.toggle('nav-open') }, icon('menu')),
        h('div', { class: 'brand' }, logo(36), h('span', { class: 'brand-name' }, 'T-Drive')),
        h('label', { class: 'search' }, icon('search', 20), this.search),
        h('div', { class: 'top-right' }, this.saveStatus, this.accountButton()),
      ),
      h('div', { class: 'body' }, this.navEl, h('div', { class: 'nav-scrim', onclick: () => this.shell.classList.remove('nav-open') }), this.mainEl),
      this.uploadPanel.el,
      this.fileInput,
      this.folderInput,
    );
    this.root.replaceChildren(this.shell);

    this.drive.addEventListener('change', () => this.render());
    this.drive.addEventListener('saving', () => this.setSave('Menyimpan…'));
    this.drive.addEventListener('saved', () => this.setSave('Tersimpan di Telegram'));
    this.drive.addEventListener('save-error', (e) => this.onSaveError(e.detail));
    this.uploader.addEventListener('change', () => {
      if (!this.statsFrame) this.statsFrame = requestAnimationFrame(() => ((this.statsFrame = 0), this.renderNav()));
    });
    this.bindDrop();
    this.bindKeys();
    window.addEventListener('focus', () => this.checkStale());
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.checkStale());
    window.addEventListener('popstate', (e) => this.restoreHistory(e.state));
    history.replaceState(this.historyState(), '');

    if (!this.streamOk) {
      toast('Streaming tidak tersedia di browser ini (service worker nonaktif). Pratinjau & unduhan memakai memori, maks. 1 GB.', { timeout: 10000 });
    }
    this.setSave('Tersimpan di Telegram');
    this.render();
  }

  accountButton() {
    const name = [this.me.firstName, this.me.lastName].filter(Boolean).join(' ') || this.me.username || 'Akun';
    const btn = h('button', { class: 'avatar', 'aria-label': `Akun: ${name}`, 'aria-haspopup': 'menu' }, (name[0] || '?').toUpperCase());
    btn.addEventListener('click', () => {
      const r = btn.getBoundingClientRect();
      this.openMenu(r.right - 240, r.bottom + 6, [
        { label: name, header: true },
        { label: this.me.phone ? '+' + this.me.phone : this.me.username ? '@' + this.me.username : '', header: true, muted: true },
        { label: 'Muat ulang drive', icon: 'refresh', run: () => this.reloadDrive() },
        { label: 'Kunci', icon: 'lock', run: () => this.guardActive(this.onLock) },
        { label: 'Keluar', icon: 'logout', run: () => this.confirmLogout() },
      ]);
    });
    return btn;
  }

  async guardActive(fn) {
    const ok = await fn();
    if (ok === false) toast('Tunggu sampai unggahan selesai atau batalkan dulu.');
  }

  async confirmLogout() {
    const ok = await confirmDialog({
      title: 'Keluar dari T-Drive?',
      message: 'Sesi Telegram di browser ini akan dihapus. File-mu tetap aman di channel Telegram dan bisa dibuka lagi dengan passphrase.',
      okText: 'Keluar',
      danger: true,
    });
    if (ok) this.guardActive(this.onLogout);
  }

  setSave(text, error = false) {
    this.saveStatus.textContent = text;
    this.saveStatus.classList.toggle('save-error', error);
  }

  onSaveError(e) {
    if (e instanceof ConflictError) {
      this.setSave('Ada perubahan dari perangkat lain', true);
      toast(e.message, { error: true, action: 'Muat ulang', onAction: () => this.reloadDrive(), timeout: 0 });
    } else {
      this.setSave('Gagal menyimpan', true);
      toast('Gagal menyimpan perubahan: ' + errorText(e), {
        error: true,
        action: 'Coba lagi',
        onAction: () => this.drive.saveNow().catch(() => {}),
        timeout: 0,
      });
    }
  }

  async reloadDrive() {
    try {
      await this.drive.reload();
      this.setSave('Tersimpan di Telegram');
      toast('Drive dimuat ulang.');
    } catch (e) {
      toast('Gagal memuat ulang: ' + errorText(e), { error: true });
    }
  }

  async checkStale() {
    try {
      if (await this.drive.isStale()) {
        await this.drive.reload();
        toast('Drive diperbarui dengan perubahan dari perangkat lain.');
      }
    } catch {
      /* offline; ignore */
    }
  }

  // ---------------- Navigation ----------------

  historyState() {
    return { section: this.state.section, folder: this.state.folder };
  }

  go(section, folder = ROOT, push = true) {
    Object.assign(this.state, { section, folder, query: section === 'search' ? this.state.query : '' });
    if (section !== 'search') this.search.value = '';
    this.state.selection.clear();
    this.shell.classList.remove('nav-open');
    if (push) history.pushState(this.historyState(), '');
    this.render();
    this.mainEl.focus({ preventScroll: true });
  }

  restoreHistory(s) {
    if (!s) return;
    const folder = s.folder === ROOT || this.index.isLive(s.folder) ? s.folder : ROOT;
    this.go(s.section === 'search' ? 'drive' : s.section, folder, false);
  }

  onSearch() {
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      const q = this.search.value.trim();
      if (q) {
        if (this.state.section !== 'search') this.state.prevSection = this.state.section;
        this.state.query = q;
        this.state.section = 'search';
        this.state.selection.clear();
        this.render();
      } else if (this.state.section === 'search') {
        this.go(this.state.prevSection || 'drive', this.state.folder, false);
      }
    }, 150);
  }

  currentItems() {
    const s = this.state;
    let list;
    if (s.section === 'drive') {
      if (s.folder !== ROOT && !this.index.isLive(s.folder)) s.folder = ROOT;
      list = this.index.children(s.folder);
    } else if (s.section === 'recent') return this.index.recent(200);
    else if (s.section === 'starred') list = this.index.starred();
    else if (s.section === 'trash') list = this.index.trash().sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));
    else list = this.index.search(s.query);
    if (s.section === 'trash') return list;
    const cmp = SORTS[s.sort][1];
    return list.sort((a, b) => (a.type === b.type ? cmp(a, b) : a.type === 'folder' ? -1 : 1));
  }

  // ---------------- Render ----------------

  render() {
    // drop selection of items that disappeared
    for (const id of this.state.selection) if (!this.index.get(id)) this.state.selection.delete(id);
    this.renderNav();
    this.renderMain();
  }

  renderNav() {
    const { size, count } = this.index.stats();
    const newBtn = h('button', { class: 'new-btn', 'aria-haspopup': 'menu' }, icon('plus', 24), 'Baru');
    newBtn.addEventListener('click', () => {
      const r = newBtn.getBoundingClientRect();
      this.openMenu(r.left, r.bottom + 4, [
        { label: 'Folder baru', icon: 'folderPlus', run: () => this.newFolder() },
        { sep: true },
        { label: 'Upload file', icon: 'upload', run: () => ((this.nextOpen = false), this.fileInput.click()) },
        { label: 'Upload folder', icon: 'uploadFolder', run: () => ((this.nextOpen = false), this.folderInput.click()) },
        { label: 'Upload file terbuka (terlihat di Telegram)', icon: 'upload', run: () => ((this.nextOpen = true), this.fileInput.click()) },
      ]);
    });
    this.navEl.replaceChildren(
      newBtn,
      h(
        'ul',
        { class: 'nav-list' },
        SECTIONS.map((s) => {
          const on = this.state.section === s.id;
          const btn = h(
            'button',
            { class: `nav-item${on ? ' active' : ''}`, 'aria-current': on ? 'page' : null, onclick: () => this.go(s.id) },
            icon(s.icon, 20),
            s.label,
          );
          if (s.id === 'drive') this.makeDropTarget(btn, ROOT);
          return h('li', null, btn);
        }),
      ),
      h(
        'div',
        { class: 'storage' },
        h('span', { class: 'storage-title' }, 'Penyimpanan'),
        h('span', { class: 'muted' }, `${formatBytes(size)} dipakai · ${count.toLocaleString('id-ID')} file`),
        h('span', { class: 'muted' }, 'Kuota: tanpa batas (Telegram)'),
        h('span', { class: 'storage-note' }, icon('lock', 14), 'Dienkripsi di browser (AES-256-GCM)'),
      ),
    );
  }

  renderMain() {
    const s = this.state;
    const items = this.currentItems();
    this.visible = items;
    const sel = [...s.selection].map((id) => this.index.get(id)).filter(Boolean);

    const head = h('div', { class: 'main-head' }, this.titleEl(), sel.length ? this.selectionBar(sel) : this.viewTools());
    const folders = items.filter((i) => i.type === 'folder');
    const files = items.filter((i) => i.type === 'file');

    let content;
    if (!items.length) content = this.emptyState();
    else if (s.layout === 'list') content = this.listView(items);
    else {
      content = h(
        'div',
        null,
        folders.length ? [h('h2', { class: 'section-title' }, 'Folder'), h('div', { class: 'folder-grid', role: 'list' }, folders.map((f) => this.folderTile(f)))] : null,
        files.length ? [h('h2', { class: 'section-title' }, 'File'), h('div', { class: 'file-grid', role: 'list' }, files.map((f) => this.fileCard(f)))] : null,
      );
    }
    const area = h('div', { class: 'content' }, content);
    area.addEventListener('click', (e) => {
      if (e.target === area || e.target.classList.contains('section-title') || e.target.classList.contains('folder-grid') || e.target.classList.contains('file-grid')) {
        s.selection.clear();
        this.renderMain();
      }
    });
    area.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.item')) return;
      if (s.section !== 'drive') return;
      e.preventDefault();
      this.openMenu(e.clientX, e.clientY, [
        { label: 'Folder baru', icon: 'folderPlus', run: () => this.newFolder() },
        { label: 'Upload file', icon: 'upload', run: () => ((this.nextOpen = false), this.fileInput.click()) },
        { label: 'Upload folder', icon: 'uploadFolder', run: () => ((this.nextOpen = false), this.folderInput.click()) },
        { label: 'Upload file terbuka (terlihat di Telegram)', icon: 'upload', run: () => ((this.nextOpen = true), this.fileInput.click()) },
      ]);
    });
    const scroll = this.mainEl.querySelector('.content')?.scrollTop || 0;
    this.mainEl.replaceChildren(head, area, this.dropOverlay || (this.dropOverlay = this.makeDropOverlay()));
    area.scrollTop = scroll;
    this.observeThumbs(area);
  }

  titleEl() {
    const s = this.state;
    if (s.section === 'drive') {
      const crumbs = [{ id: ROOT, name: 'Drive Saya' }, ...(s.folder === ROOT ? [] : this.index.path(s.folder))];
      return h(
        'nav',
        { class: 'crumbs', 'aria-label': 'Lokasi folder' },
        crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          const b = h('button', { class: `crumb${last ? ' current' : ''}`, 'aria-current': last ? 'page' : null, onclick: () => !last && this.go('drive', c.id) }, c.name);
          if (!last) this.makeDropTarget(b, c.id);
          return [i ? h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, icon('chevron', 18)) : null, b];
        }),
      );
    }
    const title = s.section === 'search' ? `Hasil untuk “${s.query}”` : SECTIONS.find((x) => x.id === s.section).label;
    return h('h1', { class: 'page-title' }, title);
  }

  viewTools() {
    const s = this.state;
    const sortSel = h(
      'select',
      {
        class: 'select',
        'aria-label': 'Urutkan',
        onchange: (e) => {
          s.sort = e.target.value;
          this.savePrefs();
          this.renderMain();
        },
      },
      Object.entries(SORTS).map(([k, [label]]) => h('option', { value: k, selected: k === s.sort }, label)),
    );
    const seg = (layout, ic, label) =>
      h(
        'button',
        {
          class: `seg${s.layout === layout ? ' on' : ''}`,
          'aria-label': label,
          'aria-pressed': String(s.layout === layout),
          onclick: () => {
            s.layout = layout;
            this.savePrefs();
            this.renderMain();
          },
        },
        icon(ic, 18),
      );
    return h(
      'div',
      { class: 'tools' },
      s.section === 'trash' && this.index.trash().length
        ? h('button', { class: 'btn btn-outline', onclick: () => this.emptyTrash() }, 'Kosongkan sampah')
        : null,
      s.section !== 'trash' && s.section !== 'recent' ? sortSel : null,
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Tampilan' }, seg('list', 'list', 'Tampilan daftar'), seg('grid', 'grid', 'Tampilan petak')),
    );
  }

  savePrefs() {
    this.prefs.set({ layout: this.state.layout, sort: this.state.sort });
  }

  selectionBar(sel) {
    const actions = this.actionsFor(sel).filter((a) => !a.sep && !a.header);
    return h(
      'div',
      { class: 'selbar', role: 'toolbar', 'aria-label': 'Tindakan untuk item terpilih' },
      h('button', { class: 'icon-btn', 'aria-label': 'Batalkan pilihan', onclick: () => (this.state.selection.clear(), this.renderMain()) }, icon('close', 18)),
      h('span', { class: 'selcount' }, `${sel.length} dipilih`),
      actions.map((a) => h('button', { class: `icon-btn${a.danger ? ' danger' : ''}`, 'aria-label': a.label, title: a.label, onclick: () => a.run() }, icon(a.icon, 20))),
    );
  }

  emptyState() {
    const s = this.state;
    const msgs = {
      drive: ['Folder ini kosong', 'Tarik file ke sini atau gunakan tombol Baru.'],
      recent: ['Belum ada file', 'File yang kamu unggah akan muncul di sini.'],
      starred: ['Belum ada yang berbintang', 'Tandai file penting supaya mudah ditemukan.'],
      trash: ['Sampah kosong', 'Item yang dihapus akan muncul di sini.'],
      search: ['Tidak ada hasil', 'Coba kata kunci lain.'],
    };
    const [t, d] = msgs[s.section];
    return h('div', { class: 'empty' }, h('span', { class: 'empty-ic' }, icon(SECTIONS.find((x) => x.id === s.section)?.icon || 'search', 48, { strokeWidth: '1.5' })), h('p', { class: 'empty-title' }, t), h('p', { class: 'muted' }, d));
  }

  // ---------------- Items ----------------

  folderTile(f) {
    const el = h(
      'div',
      { class: 'item folder-tile', role: 'listitem' },
      h('span', { class: 'folder-ic' }, folderIcon(22)),
      h('span', { class: 'item-name', title: f.name }, f.name),
      f.starred ? h('span', { class: 'star-mark', 'aria-label': 'Berbintang' }, icon('star', 14, { fill: 'currentColor' })) : null,
      this.moreBtn(f),
    );
    this.wireItem(el, f);
    if (this.state.section !== 'trash') this.makeDropTarget(el, f.id);
    return el;
  }

  fileCard(f) {
    const thumb = h('div', { class: 'thumb', dataset: { thumb: f.id } }, h('span', { class: `thumb-label ${badge(f).className.split(' ')[1]}` }, badge(f).textContent));
    const cached = this.thumbs.get(f.id);
    if (typeof cached === 'string' && cached !== 'none') thumb.replaceChildren(h('img', { src: cached, alt: '', loading: 'lazy' }));
    const el = h(
      'div',
      { class: 'item file-card', role: 'listitem' },
      h('div', { class: 'card-head' }, badge(f), h('span', { class: 'item-name', title: f.name }, f.name), this.moreBtn(f)),
      thumb,
      h('div', { class: 'card-meta' }, f.starred ? icon('star', 12, { fill: 'currentColor' }) : null, `${formatBytes(f.size)} · ${formatDate(f.modified)}`),
    );
    this.wireItem(el, f);
    return el;
  }

  listView(items) {
    const trash = this.state.section === 'trash';
    const rows = items.map((it) => {
      const tr = h(
        'tr',
        { class: 'item row' },
        h(
          'td',
          { class: 'cell-name' },
          h('span', { class: 'name-wrap' }, it.type === 'folder' ? h('span', { class: 'folder-ic' }, folderIcon(20)) : badge(it), h('span', { class: 'item-name', title: it.name }, it.name), it.starred ? h('span', { class: 'star-mark' }, icon('star', 13, { fill: 'currentColor' })) : null),
        ),
        h('td', { class: 'muted' }, this.locationOf(it)),
        h('td', { class: 'muted' }, formatDate(trash ? it.trashedAt || it.modified : it.modified)),
        h('td', { class: 'muted' }, it.type === 'file' ? formatBytes(it.size) : '—'),
        h('td', { class: 'cell-more' }, this.moreBtn(it)),
      );
      this.wireItem(tr, it);
      if (it.type === 'folder' && !trash) this.makeDropTarget(tr, it.id);
      return tr;
    });
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Nama'), h('th', null, 'Lokasi'), h('th', null, trash ? 'Dihapus' : 'Diubah'), h('th', null, 'Ukuran'), h('th', null, h('span', { class: 'sr-only' }, 'Tindakan')))),
        h('tbody', null, rows),
      ),
    );
  }

  locationOf(it) {
    if (it.parent === ROOT) return 'Drive Saya';
    return this.index.get(it.parent)?.name || 'Drive Saya';
  }

  moreBtn(it) {
    const b = h('button', { class: 'icon-btn more-btn', 'aria-label': `Tindakan untuk ${it.name}`, 'aria-haspopup': 'menu' }, icon('more', 18));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.state.selection.has(it.id)) {
        this.state.selection = new Set([it.id]);
        this.renderMain();
      }
      const r = b.getBoundingClientRect();
      this.openMenu(r.right - 220, r.bottom + 4, this.actionsFor(this.selected()));
    });
    b.addEventListener('dblclick', (e) => e.stopPropagation());
    return b;
  }

  selected() {
    return [...this.state.selection].map((id) => this.index.get(id)).filter(Boolean);
  }

  wireItem(el, it) {
    const s = this.state;
    el.tabIndex = 0;
    el.dataset.id = it.id;
    el.setAttribute('aria-selected', String(s.selection.has(it.id)));
    if (s.selection.has(it.id)) el.classList.add('selected');
    el.addEventListener('click', (e) => {
      if (e.pointerType === 'touch' && !s.selection.size) return this.open(it);
      if (e.metaKey || e.ctrlKey) {
        s.selection.has(it.id) ? s.selection.delete(it.id) : s.selection.add(it.id);
        s.anchor = it.id;
      } else if (e.shiftKey && s.anchor) {
        const ids = this.visible.map((x) => x.id);
        const [a, b] = [ids.indexOf(s.anchor), ids.indexOf(it.id)].sort((x, y) => x - y);
        s.selection = new Set(ids.slice(a, b + 1));
      } else if (e.pointerType === 'touch') {
        s.selection.has(it.id) ? s.selection.delete(it.id) : s.selection.add(it.id);
      } else {
        s.selection = new Set([it.id]);
        s.anchor = it.id;
      }
      this.renderMain();
      this.mainEl.querySelector(`[data-id="${it.id}"]`)?.focus();
    });
    el.addEventListener('dblclick', () => this.open(it));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.open(it);
      else if (e.key === ' ') {
        e.preventDefault();
        s.selection.has(it.id) ? s.selection.delete(it.id) : s.selection.add(it.id);
        this.renderMain();
        this.mainEl.querySelector(`[data-id="${it.id}"]`)?.focus();
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!s.selection.has(it.id)) {
        s.selection = new Set([it.id]);
        this.renderMain();
      }
      this.openMenu(e.clientX, e.clientY, this.actionsFor(this.selected()));
    });
    // long-press on touch selects
    let pressTimer;
    el.addEventListener('touchstart', () => {
      pressTimer = setTimeout(() => {
        s.selection.add(it.id);
        this.renderMain();
      }, 500);
    }, { passive: true });
    el.addEventListener('touchend', () => clearTimeout(pressTimer));
    el.addEventListener('touchmove', () => clearTimeout(pressTimer), { passive: true });

    if (s.section !== 'trash') {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        const ids = s.selection.has(it.id) ? [...s.selection] : [it.id];
        e.dataTransfer.setData('application/x-tdrive-ids', JSON.stringify(ids));
        e.dataTransfer.effectAllowed = 'move';
      });
    }
  }

  makeDropTarget(el, folderId) {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-tdrive-ids')) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drop-hover');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-hover');
      const raw = e.dataTransfer.getData('application/x-tdrive-ids');
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      this.moveTo(JSON.parse(raw), folderId);
    });
  }

  actionsFor(items) {
    if (!items.length) return [];
    const one = items.length === 1 ? items[0] : null;
    const files = items.filter((i) => i.type === 'file');
    if (this.state.section === 'trash') {
      return [
        { label: 'Pulihkan', icon: 'restore', run: () => this.restore(items) },
        { label: 'Hapus selamanya', icon: 'trash', danger: true, run: () => this.deleteForever(items) },
      ];
    }
    const allStarred = items.every((i) => i.starred);
    const list = [];
    if (one) list.push({ label: one.type === 'folder' ? 'Buka' : 'Pratinjau', icon: one.type === 'folder' ? 'folder' : 'file', run: () => this.open(one) });
    if (files.length === items.length) list.push({ label: 'Unduh', icon: 'download', run: () => this.download(files) });
    if (one) list.push({ label: 'Ganti nama', icon: 'edit', run: () => this.rename(one) });
    if (files.length && files.length === items.length) {
      if (files.every((f) => f.open)) list.push({ label: 'Ubah ke tertutup (enkripsi)', icon: 'lock', run: () => this.convert(files, false) });
      else if (files.every((f) => !f.open)) list.push({ label: 'Ubah ke terbuka (terlihat di Telegram)', icon: 'upload', run: () => this.convert(files, true) });
    }
    list.push({ label: 'Pindahkan', icon: 'move', run: () => this.move(items) });
    list.push({ label: allStarred ? 'Hapus bintang' : 'Beri bintang', icon: 'star', run: () => this.star(items, !allStarred) });
    if (one && this.state.section !== 'drive') list.push({ label: 'Tampilkan lokasi', icon: 'drive', run: () => this.go('drive', one.parent) });
    list.push({ sep: true });
    list.push({ label: 'Pindahkan ke sampah', icon: 'trash', danger: true, run: () => this.trash(items) });
    return list;
  }

  // ---------------- Menu ----------------

  openMenu(x, y, entries) {
    this.closeMenu();
    const prevFocus = document.activeElement;
    const menu = h(
      'div',
      { class: 'menu', role: 'menu' },
      entries.map((en) =>
        en.sep
          ? h('div', { class: 'menu-sep', role: 'separator' })
          : en.header
            ? en.label
              ? h('div', { class: `menu-header${en.muted ? ' muted' : ''}` }, en.label)
              : null
            : h(
                'button',
                {
                  class: `menu-item${en.danger ? ' danger' : ''}`,
                  role: 'menuitem',
                  onclick: () => {
                    this.closeMenu();
                    en.run();
                  },
                },
                icon(en.icon, 18),
                en.label,
              ),
      ),
    );
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
    const items = [...menu.querySelectorAll('.menu-item')];
    items[0]?.focus();
    const onKey = (e) => {
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.closeMenu();
        prevFocus?.focus?.();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[(i + 1) % items.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i - 1 + items.length) % items.length]?.focus();
      } else if (e.key === 'Tab') this.closeMenu();
    };
    const onDown = (e) => !menu.contains(e.target) && this.closeMenu();
    setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('touchstart', onDown, true);
    });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', () => this.closeMenu(), { once: true });
    this.menu = {
      el: menu,
      off: () => {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('touchstart', onDown, true);
        document.removeEventListener('keydown', onKey, true);
      },
    };
  }

  closeMenu() {
    if (!this.menu) return;
    this.menu.off();
    this.menu.el.remove();
    this.menu = null;
  }

  // ---------------- Actions ----------------

  attempt(fn) {
    try {
      return fn();
    } catch (e) {
      toast(errorText(e), { error: true });
      return null;
    }
  }

  open(it) {
    if (it.type === 'folder') {
      if (this.state.section === 'trash') return toast('Pulihkan folder untuk membukanya.');
      this.go('drive', it.id);
    } else {
      this.preview.open(this.visible, this.visible.indexOf(it));
    }
  }

  async newFolder() {
    const parent = this.state.section === 'drive' ? this.state.folder : ROOT;
    const name = await promptDialog({ title: 'Folder baru', label: 'Nama folder', value: 'Folder tanpa nama', okText: 'Buat' });
    if (!name) return;
    const f = this.attempt(() => this.drive.mutate((ix) => ix.createFolder(name, parent)));
    if (f && this.state.section !== 'drive') this.go('drive', parent);
  }

  async convert(files, toOpen) {
    if (toOpen) {
      const ok = await confirmDialog({
        title: 'Ubah ke mode terbuka?',
        message: `${files.length} file akan diunggah ulang tanpa enkripsi dan bisa dibaca siapa pun yang punya akses ke channel.`,
        okText: 'Ubah ke terbuka',
      });
      if (!ok) return;
    }
    this.uploader.convert(files, toOpen, this.reader);
  }

  async rename(it) {
    const name = await promptDialog({ title: 'Ganti nama', label: 'Nama baru', value: it.name, okText: 'Simpan', selectStem: it.type === 'file' });
    if (!name || name === it.name) return;
    this.attempt(() => this.drive.mutate((ix) => ix.rename(it.id, name)));
  }

  async move(items) {
    const start = this.state.section === 'drive' ? this.state.folder : items[0].parent;
    const dest = await pickFolder(this.index, items.map((i) => i.id), start);
    if (dest == null) return;
    this.moveTo(items.map((i) => i.id), dest);
  }

  moveTo(ids, dest) {
    ids = ids.filter((id) => id !== dest && this.index.get(id)?.parent !== dest);
    if (!ids.length) return;
    const ok = this.attempt(() => {
      this.drive.mutate((ix) => ix.move(ids, dest));
      return true;
    });
    if (ok) {
      const name = dest === ROOT ? 'Drive Saya' : this.index.get(dest).name;
      toast(`${ids.length} item dipindahkan ke “${name}”.`);
    }
  }

  star(items, value) {
    this.drive.mutate((ix) => ix.setStarred(items.map((i) => i.id), value));
  }

  trash(items) {
    const ids = items.map((i) => i.id);
    this.drive.mutate((ix) => ix.trashItems(ids));
    this.state.selection.clear();
    this.renderMain();
    toast(`${ids.length} item dipindahkan ke sampah.`, { action: 'Urungkan', onAction: () => this.drive.mutate((ix) => ix.restore(ids)) });
  }

  restore(items) {
    this.drive.mutate((ix) => ix.restore(items.map((i) => i.id)));
    this.state.selection.clear();
    this.renderMain();
    toast(`${items.length} item dipulihkan.`);
  }

  async deleteForever(items) {
    const ok = await confirmDialog({
      title: 'Hapus selamanya?',
      message: `${items.length} item akan dihapus permanen dari Telegram dan tidak bisa dipulihkan.`,
      okText: 'Hapus selamanya',
      danger: true,
    });
    if (!ok) return;
    const ids = this.drive.mutate((ix) => ix.removeForever(items.map((i) => i.id)));
    await this.purge(ids);
  }

  async emptyTrash() {
    const ok = await confirmDialog({
      title: 'Kosongkan sampah?',
      message: 'Semua item di sampah akan dihapus permanen dari Telegram.',
      okText: 'Kosongkan sampah',
      danger: true,
    });
    if (!ok) return;
    const ids = this.drive.mutate((ix) => ix.emptyTrash());
    await this.purge(ids);
  }

  async purge(msgIds) {
    this.state.selection.clear();
    try {
      await this.drive.flush(); // index first, so it never points at deleted messages
      if (msgIds.length) await this.tg.deleteMessages(msgIds);
      toast('Dihapus permanen.');
    } catch (e) {
      toast('Gagal menghapus: ' + errorText(e), { error: true });
    }
  }

  async download(files) {
    if (this.streamOk) {
      for (const f of files) {
        const a = h('a', { href: streamUrl(f, { download: true }), download: f.name, hidden: true });
        document.body.append(a);
        a.click();
        a.remove();
        if (files.length > 1) await new Promise((r) => setTimeout(r, 400));
      }
      return;
    }
    for (const f of files) {
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

  // ---------------- Upload ----------------

  uploadTarget() {
    return this.state.section === 'drive' ? this.state.folder : ROOT;
  }

  pickFiles(input) {
    // The "terbuka" menu item sets nextOpen; a cancelled picker is reset on the next normal pick.
    const open = !!this.nextOpen;
    this.nextOpen = false;
    const files = [...input.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    input.value = '';
    this.enqueue(files, { open });
  }

  /** entries: [{ file, path }] where path may contain folders ("a/b/c.txt"). */
  enqueue(entries, { open = false } = {}) {
    if (!entries.length) return;
    const base = this.uploadTarget();
    const jobs = this.attempt(() =>
      this.drive.mutate((ix) => {
        const cache = new Map();
        return entries.map(({ file, path }) => {
          const dirs = path.split('/').slice(0, -1).filter(Boolean);
          let parent = base;
          let key = '';
          for (const d of dirs) {
            key += '/' + d;
            if (!cache.has(key)) cache.set(key, ix.ensureFolder(d, parent).id);
            parent = cache.get(key);
          }
          return { file, parent };
        });
      }),
    );
    if (jobs) this.uploader.add(jobs, { open });
  }

  makeDropOverlay() {
    return h('div', { class: 'drop-overlay', 'aria-hidden': 'true' }, h('div', { class: 'drop-box' }, icon('upload', 32), h('span', null, 'Lepaskan untuk mengunggah')));
  }

  bindDrop() {
    let depth = 0;
    const isFiles = (e) => e.dataTransfer?.types.includes('Files');
    this.mainEl.addEventListener('dragenter', (e) => {
      if (!isFiles(e) || this.state.section === 'trash') return;
      depth++;
      this.mainEl.classList.add('dragging');
    });
    this.mainEl.addEventListener('dragleave', (e) => {
      if (!isFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) this.mainEl.classList.remove('dragging');
    });
    this.mainEl.addEventListener('dragover', (e) => {
      if (isFiles(e) && this.state.section !== 'trash') e.preventDefault();
    });
    this.mainEl.addEventListener('drop', async (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth = 0;
      this.mainEl.classList.remove('dragging');
      const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
      const out = [];
      if (entries.length) {
        for (const en of entries) await walkEntry(en, '', out);
      } else {
        for (const f of e.dataTransfer.files) out.push({ file: f, path: f.name });
      }
      this.enqueue(out);
    });
    document.addEventListener('dragover', (e) => isFiles(e) && e.preventDefault());
    document.addEventListener('drop', (e) => isFiles(e) && e.preventDefault());
  }

  bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (document.querySelector('.modal-backdrop, .preview') || this.menu) return;
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
      const sel = this.selected();
      const trash = this.state.section === 'trash';
      if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && sel.length) {
        e.preventDefault();
        trash ? this.deleteForever(sel) : this.trash(sel);
      } else if (e.key === 'F2' && sel.length === 1 && !trash) {
        e.preventDefault();
        this.rename(sel[0]);
      } else if (e.key === 'Escape' && sel.length) {
        this.state.selection.clear();
        this.renderMain();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && this.visible?.length) {
        e.preventDefault();
        this.state.selection = new Set(this.visible.map((i) => i.id));
        this.renderMain();
      } else if (e.key === '/' ) {
        e.preventDefault();
        this.search.focus();
      }
    });
  }

  // ---------------- Thumbnails ----------------

  observeThumbs(area) {
    this.thumbObserver?.disconnect();
    this.thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          this.thumbObserver.unobserve(en.target);
          const it = this.index.get(en.target.dataset.thumb);
          if (it && THUMB_TYPES.test(it.mime) && it.size <= THUMB_MAX && !this.thumbs.has(it.id)) {
            this.thumbs.set(it.id, 'pending');
            this.thumbQueue.push(it);
            this.pumpThumbs();
          }
        }
      },
      { root: area, rootMargin: '200px' },
    );
    for (const t of area.querySelectorAll('[data-thumb]')) if (!this.thumbs.has(t.dataset.thumb)) this.thumbObserver.observe(t);
  }

  pumpThumbs() {
    while (this.thumbActive < 2 && this.thumbQueue.length) {
      const it = this.thumbQueue.shift();
      this.thumbActive++;
      makeThumb(this.reader, it)
        .then((url) => {
          this.thumbs.set(it.id, url);
          const slot = this.mainEl.querySelector(`[data-thumb="${CSS.escape(it.id)}"]`);
          slot?.replaceChildren(h('img', { src: url, alt: '' }));
        })
        .catch(() => this.thumbs.set(it.id, 'none'))
        .finally(() => {
          this.thumbActive--;
          this.pumpThumbs();
        });
    }
  }
}

async function makeThumb(reader, it) {
  const data = await reader.readAll(it);
  const bmp = await createImageBitmap(new Blob([data], { type: it.mime }));
  const scale = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.8));
  return URL.createObjectURL(blob);
}

async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: prefix + file.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walkEntry(e, prefix + entry.name + '/', out);
    }
  }
}
