import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ORIGIN, APP_SCHEME, resolveAppRequest } from './appProtocol';

const root = path.resolve('/opt/takingnotes/dist');

describe('app protocol constants', () => {
  it('names the scheme and origin', () => {
    expect(APP_SCHEME).toBe('app');
    expect(APP_ORIGIN).toBe('app://takingnotes');
  });
});

describe('resolveAppRequest', () => {
  it('maps root to index.html', () => {
    expect(resolveAppRequest('app://takingnotes/', root)).toBe(path.join(root, 'index.html'));
    expect(resolveAppRequest('app://takingnotes', root)).toBe(path.join(root, 'index.html'));
  });

  it('maps asset path', () => {
    expect(resolveAppRequest('app://takingnotes/assets/index-abc123.js', root)).toBe(
      path.join(root, 'assets', 'index-abc123.js'),
    );
    expect(resolveAppRequest('app://takingnotes/manifest.json?v=2#x', root)).toBe(path.join(root, 'manifest.json'));
  });

  it('decodes percent-encoded file names', () => {
    expect(resolveAppRequest('app://takingnotes/assets/my%20file.wasm', root)).toBe(
      path.join(root, 'assets', 'my file.wasm'),
    );
  });

  it('rejects traversal', () => {
    // The URL parser normalises a literal `..` away, so it can never climb above root.
    expect(resolveAppRequest('app://takingnotes/../../etc/passwd.txt', root)).toBe(path.join(root, 'etc', 'passwd.txt'));
    expect(resolveAppRequest('app://takingnotes/assets/..%2f..%2f..%2fetc/passwd', root)).toBeNull();
    expect(resolveAppRequest('app://takingnotes/assets/..%5c..%5csecret.txt', root)).toBeNull();
  });

  it('rejects encoded traversal', () => {
    // `%2e%2e` as a whole segment is a dot-segment to the URL parser, so it is removed, not followed.
    expect(resolveAppRequest('app://takingnotes/%2e%2e/%2e%2e/etc/passwd.txt', root)).toBe(
      path.join(root, 'etc', 'passwd.txt'),
    );
    expect(resolveAppRequest('app://takingnotes/%2e%2e%2f%2e%2e%2fetc%2fpasswd.txt', root)).toBeNull();
    expect(resolveAppRequest('app://takingnotes/%252e%252e/x.txt', root)).toBe(path.join(root, '%2e%2e', 'x.txt'));
  });

  it('rejects a NUL byte and malformed encoding', () => {
    expect(resolveAppRequest('app://takingnotes/index.html%00.js', root)).toBeNull();
    expect(resolveAppRequest('app://takingnotes/%E0%A4%A.js', root)).toBeNull();
  });

  it('rejects foreign host', () => {
    expect(resolveAppRequest('app://evil/index.html', root)).toBeNull();
    expect(resolveAppRequest('https://takingnotes/index.html', root)).toBeNull();
    expect(resolveAppRequest('not a url', root)).toBeNull();
  });

  it('falls back to index.html for unknown route', () => {
    expect(resolveAppRequest('app://takingnotes/notes/123', root)).toBe(path.join(root, 'index.html'));
    expect(resolveAppRequest('app://takingnotes/settings/', root)).toBe(path.join(root, 'index.html'));
  });
});
