// All encryption happens in the browser with WebCrypto.
//
// - Passphrase -> PBKDF2-SHA256 (600k iterations) -> AES-GCM key.
//   Used for the drive index and for the locally stored Telegram session.
// - Every file gets its own random 256-bit key and 8-byte nonce prefix.
//   Block i is encrypted with IV = nonce(8) || uint32be(i).

const enc = new TextEncoder();
const dec = new TextDecoder();
export const PBKDF2_ITERATIONS = 600_000;

const subtle = () => globalThis.crypto.subtle;

export function randomBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) globalThis.crypto.getRandomValues(b.subarray(i, i + 65536));
  return b;
}

export function toB64(bytes) {
  let s = '';
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export async function deriveKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await subtle().importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function importFileKey(raw) {
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function blockIv(nonce8, index) {
  const iv = new Uint8Array(12);
  iv.set(nonce8, 0);
  new DataView(iv.buffer).setUint32(8, index >>> 0, false);
  return iv;
}

export async function encryptBlock(key, nonce8, index, plain) {
  return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: blockIv(nonce8, index) }, key, plain));
}

export async function decryptBlock(key, nonce8, index, cipher) {
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: blockIv(nonce8, index) }, key, cipher));
}

// ---- Sealed blobs (index + local session) ----
// Format: "TDRV" | version(1) | salt(16) | iv(12) | AES-GCM(gzip(json))
const MAGIC = [0x54, 0x44, 0x52, 0x56];
const VERSION = 1;
const HEADER = 4 + 1 + 16 + 12;

async function gzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export function readSealedSalt(blob) {
  const u = new Uint8Array(blob);
  if (u.length < HEADER || MAGIC.some((m, i) => u[i] !== m)) throw new Error('Bukan file index T-Drive');
  if (u[4] !== VERSION) throw new Error('Versi index tidak didukung: ' + u[4]);
  return u.slice(5, 21);
}

export async function seal(key, salt, value) {
  const iv = randomBytes(12);
  const body = await gzip(enc.encode(JSON.stringify(value)));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, body));
  const out = new Uint8Array(HEADER + ct.length);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  out.set(salt, 5);
  out.set(iv, 21);
  out.set(ct, HEADER);
  return out;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Passphrase salah');
    this.name = 'WrongPassphraseError';
  }
}

export async function unseal(key, blob) {
  const u = new Uint8Array(blob);
  readSealedSalt(u);
  const iv = u.slice(21, HEADER);
  let body;
  try {
    body = await subtle().decrypt({ name: 'AES-GCM', iv }, key, u.slice(HEADER));
  } catch {
    throw new WrongPassphraseError();
  }
  return JSON.parse(dec.decode(await gunzip(new Uint8Array(body))));
}
