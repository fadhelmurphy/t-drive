import { describe, it, expect } from 'vitest';
import * as B from '../src/core/blocks.js';

describe('blocks', () => {
  it('full cipher blocks are exactly 1 MiB', () => {
    expect(B.PLAIN_BLOCK + B.TAG_SIZE).toBe(B.CIPHER_BLOCK);
  });
  it('counts blocks and parts', () => {
    expect(B.blockCount(0)).toBe(0);
    expect(B.blockCount(1)).toBe(1);
    expect(B.blockCount(B.PLAIN_BLOCK)).toBe(1);
    expect(B.blockCount(B.PLAIN_BLOCK + 1)).toBe(2);
    expect(B.partCount(B.PLAIN_BLOCK * B.BLOCKS_PER_PART)).toBe(1);
    expect(B.partCount(B.PLAIN_BLOCK * B.BLOCKS_PER_PART + 1)).toBe(2);
  });
  it('part stays under Telegram 2000 MiB limit', () => {
    expect(B.BLOCKS_PER_PART * B.CIPHER_BLOCK).toBeLessThan(2000 * 1024 * 1024);
  });
  it('locates blocks across parts', () => {
    expect(B.locateBlock(0)).toEqual({ part: 0, offset: 0 });
    expect(B.locateBlock(5)).toEqual({ part: 0, offset: 5 * B.CIPHER_BLOCK });
    expect(B.locateBlock(B.BLOCKS_PER_PART + 2)).toEqual({ part: 1, offset: 2 * B.CIPHER_BLOCK });
  });
  it('sizes last block and part', () => {
    const size = B.PLAIN_BLOCK * 2 + 10;
    expect(B.plainBlockLength(size, 2)).toBe(10);
    expect(B.partCipherSize(size, 0)).toBe(2 * B.CIPHER_BLOCK + 10 + B.TAG_SIZE);
  });
  it('maps ranges to blocks', () => {
    const size = B.PLAIN_BLOCK * 3;
    expect(B.rangeToBlocks(size, 0, 9)).toEqual([{ block: 0, from: 0, to: 9 }]);
    const r = B.rangeToBlocks(size, B.PLAIN_BLOCK - 5, B.PLAIN_BLOCK + 4);
    expect(r).toEqual([
      { block: 0, from: B.PLAIN_BLOCK - 5, to: B.PLAIN_BLOCK - 1 },
      { block: 1, from: 0, to: 4 },
    ]);
    const total = B.rangeToBlocks(size, 0, size - 1).reduce((s, x) => s + x.to - x.from + 1, 0);
    expect(total).toBe(size);
  });
  it('parses Range headers', () => {
    expect(B.parseRange(null, 100)).toBe(null);
    expect(B.parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(B.parseRange('bytes=10-20', 100)).toEqual({ start: 10, end: 20 });
    expect(B.parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(B.parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(B.parseRange('bytes=100-', 100)).toEqual({ invalid: true });
    expect(B.parseRange('bytes=0-1,5-6', 100)).toEqual({ invalid: true });
  });
});
