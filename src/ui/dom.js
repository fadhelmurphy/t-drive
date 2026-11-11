// Tiny DOM helpers. Text always goes through textContent, never innerHTML.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const SVG = 'http://www.w3.org/2000/svg';
const PATHS = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
  drive: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  close: 'M6 6l12 12M18 6 6 18',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 20h14',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  move: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM10 13h6m-2-2 2 2-2 2',
  restore: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4',
  more: 'M12 5h.01M12 12h.01M12 19h.01',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  folderPlus: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6',
  upload: 'M12 20V9m0 0-4 4m4-4 4 4M5 4h14',
  uploadFolder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 17v-6m0 0-3 3m3-3 3 3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  chevron: 'm9 6 6 6-6 6',
  left: 'm15 6-6 6 6 6',
  right: 'm9 6 6 6-6 6',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4',
  check: 'M5 12l5 5 9-9',
  retry: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  cloud: 'M7 18a5 5 0 0 1-.6-10 7 7 0 0 1 13.2 2.2A4 4 0 0 1 19 18z',
};

export function icon(name, size = 20, extra = {}) {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', extra.fill || 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', extra.strokeWidth || '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', PATHS[name] || PATHS.file);
  s.append(p);
  return s;
}

export function folderIcon(size = 22) {
  return icon('folder', size, { fill: 'currentColor', strokeWidth: '0' });
}

const KINDS = [
  [/^image\//, 'IMG', 'k-img'],
  [/^video\//, 'VID', 'k-vid'],
  [/^audio\//, 'AUD', 'k-aud'],
  [/pdf/, 'PDF', 'k-pdf'],
  [/zip|rar|7z|tar|gzip|compressed/, 'ZIP', 'k-zip'],
  [/sheet|excel|csv/, 'XLS', 'k-xls'],
  [/word|document|rtf/, 'DOC', 'k-doc'],
  [/presentation|powerpoint/, 'PPT', 'k-ppt'],
  [/^text\/|json|xml|javascript/, 'TXT', 'k-txt'],
];

export function kindOf(item) {
  if (item.type === 'folder') return { label: 'DIR', cls: 'k-dir' };
  const ext = item.name.includes('.') ? item.name.split('.').pop().toUpperCase().slice(0, 4) : '';
  for (const [re, label, cls] of KINDS) if (re.test(item.mime || '')) return { label: ext || label, cls };
  return { label: ext || 'FILE', cls: 'k-other' };
}

export function badge(item) {
  const k = kindOf(item);
  return h('span', { class: `badge ${k.cls}`, 'aria-hidden': 'true' }, k.label);
}
