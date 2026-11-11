import { h, icon, folderIcon } from './dom.js';
import { customDialog } from './dialogs.js';
import { ROOT } from '../core/drive-index.js';

/** Pick a destination folder. Resolves with folder id or null. */
export function pickFolder(index, movingIds, startAt = ROOT) {
  return new Promise((resolve) => {
    const moving = new Set(movingIds);
    let current = startAt === ROOT || index.isLive(startAt) ? startAt : ROOT;
    const body = h('div', { class: 'modal-body picker' });
    const okBtn = h('button', { class: 'btn btn-primary', onclick: () => m.close(current) }, 'Pindahkan ke sini');
    const m = customDialog({
      title: 'Pindahkan ke…',
      body,
      actions: [h('button', { class: 'btn btn-text', onclick: () => m.close(null) }, 'Batal'), okBtn],
      onClose: resolve,
    });

    const render = () => {
      const crumbs = [{ id: ROOT, name: 'Drive Saya' }, ...index.path(current === ROOT ? null : current)];
      const folders = index
        .children(current)
        .filter((f) => f.type === 'folder')
        .sort((a, b) => a.name.localeCompare(b.name, 'id'));
      okBtn.disabled = movingIds.every((id) => index.get(id)?.parent === current);
      body.replaceChildren(
        h(
          'nav',
          { class: 'crumbs crumbs-sm', 'aria-label': 'Lokasi' },
          crumbs.map((c, i) => [
            i ? icon('chevron', 14) : null,
            h('button', { class: 'crumb', onclick: () => ((current = c.id), render()) }, c.name),
          ]),
        ),
        folders.length
          ? h(
              'ul',
              { class: 'picker-list' },
              folders.map((f) =>
                h(
                  'li',
                  null,
                  h(
                    'button',
                    {
                      class: 'picker-item',
                      disabled: moving.has(f.id),
                      onclick: () => {
                        current = f.id;
                        render();
                      },
                    },
                    h('span', { class: 'folder-ic' }, folderIcon(20)),
                    h('span', { class: 'grow' }, f.name),
                    icon('chevron', 16),
                  ),
                ),
              ),
            )
          : h('p', { class: 'muted picker-empty' }, 'Tidak ada subfolder.'),
      );
    };
    render();
  });
}
