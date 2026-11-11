// Layout math for encrypted, block-aligned storage.
//
// A file is cut into plaintext blocks of PLAIN_BLOCK bytes. Each block is
// encrypted with AES-GCM (adds a 16-byte tag), so every full cipher block is
// exactly 1 MiB. Telegram's upload.GetFile serves 1 MiB windows aligned to
// 1 MiB, so cipher block i of a part can be fetched with a single request.
//
// Blocks are grouped into "parts"; each part is one Telegram document
// (max ~2000 MiB). BLOCKS_PER_PART keeps a safe margin under that limit.

export const TAG_SIZE = 16;
export const CIPHER_BLOCK = 1024 * 1024;
export const PLAIN_BLOCK = CIPHER_BLOCK - TAG_SIZE; // 1_048_560
// ~1.86 GiB per Telegram document. Mutable only so tests can use tiny parts.
export const LAYOUT = { blocksPerPart: 1900 };
export const BLOCKS_PER_PART = LAYOUT.blocksPerPart;
export const TG_UPLOAD_PART = 512 * 1024; // Telegram upload part size
export const TG_BIG_FILE = 10 * 1024 * 1024; // > this needs SaveBigFilePart

export function blockCount(size) {
  if (!Number.isFinite(size) || size < 0) throw new RangeError('invalid size');
  return Math.ceil(size / PLAIN_BLOCK);
}

export function partCount(size) {
  return Math.ceil(blockCount(size) / LAYOUT.blocksPerPart);
}

/** Plaintext length of block `i` of a file of `size` bytes. */
export function plainBlockLength(size, i) {
  const n = blockCount(size);
  if (i < 0 || i >= n) throw new RangeError('block out of range');
  return i === n - 1 ? size - i * PLAIN_BLOCK : PLAIN_BLOCK;
}

/** Where block `i` lives: which part, and byte offset inside that part. */
export function locateBlock(i) {
  const bpp = LAYOUT.blocksPerPart;
  const part = Math.floor(i / bpp);
  const offset = (i - part * bpp) * CIPHER_BLOCK;
  return { part, offset };
}

/** Block index range [first, last] contained in part `p`. */
export function partBlocks(size, p) {
  const n = blockCount(size);
  const first = p * LAYOUT.blocksPerPart;
  const last = Math.min(n, first + LAYOUT.blocksPerPart) - 1;
  if (first > last) throw new RangeError('part out of range');
  return { first, last };
}

/** Encrypted byte size of part `p`. */
export function partCipherSize(size, p) {
  const { first, last } = partBlocks(size, p);
  let total = 0;
  for (let i = first; i <= last; i++) total += plainBlockLength(size, i) + TAG_SIZE;
  return total;
}

/**
 * Map an inclusive plaintext byte range to the blocks that cover it.
 * Returns [{ block, from, to }] where from/to are inclusive offsets
 * inside the decrypted block.
 */
export function rangeToBlocks(size, start, end) {
  if (size === 0) return [];
  if (start < 0 || end >= size || start > end) throw new RangeError('bad range');
  const out = [];
  const first = Math.floor(start / PLAIN_BLOCK);
  const last = Math.floor(end / PLAIN_BLOCK);
  for (let b = first; b <= last; b++) {
    const base = b * PLAIN_BLOCK;
    out.push({
      block: b,
      from: b === first ? start - base : 0,
      to: b === last ? end - base : plainBlockLength(size, b) - 1,
    });
  }
  return out;
}

/** Parse an HTTP Range header against a resource of `size` bytes. */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return { invalid: true };
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return { invalid: true };
  return { start, end };
}
