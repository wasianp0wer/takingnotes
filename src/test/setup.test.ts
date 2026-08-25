import { describe, expect, it } from 'vitest';

describe('test environment', () => {
  it('provides a DOM global from happy-dom', () => {
    expect(typeof document).toBe('object');
  });

  it('provides an indexedDB global from fake-indexeddb', () => {
    expect(globalThis.indexedDB).toBeDefined();
    expect(typeof globalThis.indexedDB.open).toBe('function');
  });

  it('can open and close a database', async () => {
    const opened = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = globalThis.indexedDB.open('probe-db', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(opened.name).toBe('probe-db');
    opened.close();
  });
});
