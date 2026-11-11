import '../src/polyfills.js';
// Dev-only UI harness: runs the real UI against an in-memory fake Telegram.
import '../src/styles.css';
import { FakeTg } from './fake-tg.js';
import { DriveStore } from '../src/core/drive.js';
import { Reader } from '../src/core/reader.js';
import { Uploader } from '../src/core/uploader.js';
import { installStreamBridge, registerStreamWorker } from '../src/core/stream.js';
import { DriveView } from '../src/ui/drive-view.js';

async function png(color, w = 800, h = 500) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, w, h);
  g.fillStyle = '#ffffff88'; g.beginPath(); g.arc(w * 0.7, h * 0.4, h * 0.25, 0, 7); g.fill();
  return c.convertToBlob({ type: 'image/png' });
}

const tg = new FakeTg();
const drive = new DriveStore(tg);
await drive.create('harness-passphrase');
const reader = new Reader(tg);
const uploader = new Uploader(tg, drive);
installStreamBridge((id) => drive.index.get(id), reader);
const streamOk = await registerStreamWorker();
const view = new DriveView({
  root: document.getElementById('app'), drive, reader, uploader, tg,
  me: { firstName: 'Fadhel', phone: '62812000000' }, streamOk,
  prefs: { get: () => ({}), set: () => {} }, onLock: () => true, onLogout: () => true,
});
view.mount();
const ix = drive.index;
const f1 = drive.mutate((x) => x.createFolder('Pekerjaan'));
drive.mutate((x) => x.createFolder('Foto iPhone'));
drive.mutate((x) => x.createFolder('Video Lari'));
const files = [
  new File([await png('#2f6fb3')], 'Pantai.png', { type: 'image/png' }),
  new File([await png('#b35a2f')], 'Senja di Bromo.png', { type: 'image/png' }),
  new File(['SELECT * FROM bronze.leads;\n'.repeat(50)], 'query.sql', { type: 'text/plain' }),
  new File([new Uint8Array(3 * 1024 * 1024)], 'Laporan Q3.pdf', { type: 'application/pdf' }),
  new File([new Uint8Array(1500)], 'Budget Nikah.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  new File([new Uint8Array(2048)], 'backup.zip', { type: 'application/zip' }),
];
uploader.add(files.map((file) => ({ file, parent: 'root' })));
window.__h = { tg, drive, uploader, view, f1 };
window.__ready = new Promise((r) => { const t = setInterval(() => { if (!uploader.active) { clearInterval(t); r(); } }, 50); });

// Browser-realm TL serialization check (Buffer polyfill path).
import { Api } from 'telegram';
import { Tg } from '../src/core/tg.js';
window.__ser = (async () => {
  const t = new Tg(12345, '0123456789abcdef0123456789abcdef');
  t.useChannel({ id: '1234567890', accessHash: '-987654321' });
  const names = [];
  t.client.invoke = async (r) => { r.getBytes(); names.push(r.className); return r instanceof Api.messages.SendMedia ? { updates: [new Api.UpdateNewChannelMessage({ message: { id: 7, media: { document: {} } }, pts: 1, ptsCount: 1 })] } : true; };
  const fileId = t.newFileId();
  await t.savePart({ fileId, part: 0, totalParts: 3, bytes: new Uint8Array(524288), big: true });
  await t.sendDocument({ fileId, totalParts: 3, big: true, name: 'x.bin' });
  await t.pin(7);
  return names.join(',');
})().catch((e) => 'ERR ' + e.message);

// 2FA (SRP) check in the browser realm.
import { computeCheck } from 'telegram/Password.js';
import bigInt from 'big-integer';
window.__srp = (async () => {
  const hex = 'c71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c3720fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f642477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a4a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae4e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851f0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b';
  const p = Buffer.from(hex, 'hex');
  const rnd = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
  const algo = new Api.PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow({ salt1: rnd(40), salt2: rnd(16), g: 3, p });
  const req = new Api.account.Password({ hasPassword: true, currentAlgo: algo, srp_B: Buffer.from(bigInt(3).modPow(bigInt(123456789), bigInt(hex, 16)).toString(16).padStart(512, '0'), 'hex'), srpId: bigInt(42), newAlgo: algo, newSecureAlgo: new Api.SecurePasswordKdfAlgoUnknown(), secureRandom: rnd(32) });
  const check = await computeCheck(req, 'kata sandi uji');
  new Api.auth.CheckPassword({ password: check }).getBytes();
  return 'SRP OK ' + check.className;
})().catch((e) => 'SRP ERR ' + e.message);
