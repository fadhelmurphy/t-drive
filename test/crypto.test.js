import { describe, it, expect } from 'vitest';
import * as C from '../src/core/crypto.js';

describe('crypto', () => {
  it('block round trip and tamper detection', async () => {
    const key = await C.importFileKey(C.randomBytes(32));
    const nonce = C.randomBytes(8);
    const plain = C.randomBytes(1000);
    const ct = await C.encryptBlock(key, nonce, 7, plain);
    expect(ct.length).toBe(1016);
    expect(await C.decryptBlock(key, nonce, 7, ct)).toEqual(plain);
    await expect(C.decryptBlock(key, nonce, 8, ct)).rejects.toBeTruthy(); // wrong index
    ct[3] ^= 1;
    await expect(C.decryptBlock(key, nonce, 7, ct)).rejects.toBeTruthy();
  });
  it('seal/unseal with passphrase', async () => {
    const salt = C.randomBytes(16);
    const key = await C.deriveKey('rahasia sekali', salt, 1000);
    const blob = await C.seal(key, salt, { v: 1, items: { a: { name: 'x' } } });
    expect(C.readSealedSalt(blob)).toEqual(salt);
    expect(await C.unseal(key, blob)).toEqual({ v: 1, items: { a: { name: 'x' } } });
    const wrong = await C.deriveKey('salah', salt, 1000);
    await expect(C.unseal(wrong, blob)).rejects.toBeInstanceOf(C.WrongPassphraseError);
  });
  it('base64 round trip', () => {
    const b = C.randomBytes(100000);
    expect(C.fromB64(C.toB64(b))).toEqual(b);
  });
});
