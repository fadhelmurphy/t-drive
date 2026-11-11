import './polyfills.js';
import './styles.css';
import { start } from './app.js';
import { h } from './ui/dom.js';
import { errorText } from './ui/dialogs.js';

function fatal(e) {
  console.error(e);
  document.getElementById('app').replaceChildren(
    h(
      'main',
      { class: 'auth' },
      h(
        'div',
        { class: 'auth-card' },
        h('h1', { class: 'auth-title' }, 'Terjadi kesalahan'),
        h('p', { class: 'auth-sub' }, errorText(e)),
        h('button', { class: 'btn btn-primary btn-block', onclick: () => location.reload() }, 'Muat ulang'),
      ),
    ),
  );
}

if (!window.isSecureContext || !crypto?.subtle) {
  fatal(new Error('T-Drive butuh HTTPS (atau localhost) agar enkripsi di browser bisa berjalan.'));
} else {
  start().catch(fatal);
}
