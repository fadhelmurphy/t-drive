import { describe, it, expect } from 'vitest';
import { DriveIndex, ROOT } from '../src/core/drive-index.js';

const file = (ix, name, parent = ROOT, parts = [1]) =>
  ix.addFile({ name, parent, size: 10, mime: 'text/plain', key: 'k', nonce: 'n', parts });

describe('DriveIndex', () => {
  it('creates folders with unique names', () => {
    const ix = new DriveIndex();
    const a = ix.createFolder('Foto');
    const b = ix.createFolder('foto');
    expect(a.name).toBe('Foto');
    expect(b.name).toBe('foto (1)');
    expect(file(ix, 'a.txt').name).toBe('a.txt');
    expect(file(ix, 'a.txt').name).toBe('a (1).txt');
  });
  it('rejects bad names', () => {
    const ix = new DriveIndex();
    expect(() => ix.createFolder('  ')).toThrow();
    expect(() => ix.createFolder('a/b')).toThrow();
  });
  it('moves but not into own subtree', () => {
    const ix = new DriveIndex();
    const a = ix.createFolder('A');
    const b = ix.createFolder('B', a.id);
    const f = file(ix, 'f', b.id);
    expect(() => ix.move([a.id], b.id)).toThrow();
    ix.move([f.id], ROOT);
    expect(ix.get(f.id).parent).toBe(ROOT);
    expect(ix.path(b.id).map((x) => x.name)).toEqual(['A', 'B']);
  });
  it('trash hides subtree; restore and remove forever', () => {
    const ix = new DriveIndex();
    const a = ix.createFolder('A');
    const f = file(ix, 'f', a.id, [11, 12]);
    const g = file(ix, 'g', ROOT, [13]);
    ix.trashItems([a.id]);
    expect(ix.isLive(f.id)).toBe(false);
    expect(ix.trash().map((x) => x.id)).toEqual([a.id]);
    expect(ix.stats()).toEqual({ size: 10, count: 1 });
    ix.restore([a.id]);
    expect(ix.isLive(f.id)).toBe(true);
    ix.trashItems([a.id]);
    expect(ix.emptyTrash().sort()).toEqual([11, 12]);
    expect(ix.get(f.id)).toBeUndefined();
    expect(ix.get(g.id)).toBeTruthy();
  });
  it('restores to root when parent is gone', () => {
    const ix = new DriveIndex();
    const a = ix.createFolder('A');
    const f = file(ix, 'f', a.id);
    ix.trashItems([f.id]);
    ix.trashItems([a.id]);
    ix.restore([f.id]);
    expect(ix.get(f.id).parent).toBe(ROOT);
  });
  it('ensureFolder reuses existing', () => {
    const ix = new DriveIndex();
    const a = ix.ensureFolder('Docs', ROOT);
    expect(ix.ensureFolder('docs', ROOT).id).toBe(a.id);
  });
});
