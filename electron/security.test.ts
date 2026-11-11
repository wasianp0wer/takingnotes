import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, isAllowedNavigation, isExternalHttpUrl } from './security';

function directive(csp: string, name: string): string[] {
  const found = csp
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([key]) => key === name);
  if (!found) throw new Error(`no ${name} directive in ${csp}`);
  return found.slice(1);
}

describe('contentSecurityPolicy', () => {
  const csp = contentSecurityPolicy();

  it('allows localhost Ollama and CDNs', () => {
    const connect = directive(csp, 'connect-src');
    for (const source of [
      "'self'",
      'app://takingnotes',
      'http://localhost:*',
      'http://127.0.0.1:*',
      'https://cdn.jsdelivr.net',
      'https://huggingface.co',
    ]) {
      expect(connect).toContain(source);
    }
    // Model files redirect from huggingface.co to its CDN / Xet storage hosts.
    expect(connect).toContain('https://*.huggingface.co');
    expect(connect).toContain('https://*.hf.co');
  });

  it('has no unsafe-eval', () => {
    expect(csp).not.toContain("'unsafe-eval'");
    expect(directive(csp, 'script-src')).toEqual(["'self'", "'wasm-unsafe-eval'", 'blob:']);
  });

  it('lets transformers.js import the onnxruntime factory it turns into a blob: URL', () => {
    // Spike finding: without blob: the Whisper worker fails with
    // "no available backend found ... Failed to fetch dynamically imported module: blob:app://...".
    expect(directive(csp, 'script-src')).toContain('blob:');
    expect(directive(csp, 'script-src')).not.toContain('https://cdn.jsdelivr.net');
  });

  it('allows the Google Fonts stylesheet src/index.css imports', () => {
    expect(directive(csp, 'style-src')).toContain('https://fonts.googleapis.com');
    expect(directive(csp, 'font-src')).toContain('https://fonts.gstatic.com');
  });

  it('pins the remaining directives', () => {
    expect(directive(csp, 'default-src')).toEqual(["'self'"]);
    expect(directive(csp, 'worker-src')).toEqual(["'self'", 'blob:']);
    expect(directive(csp, 'style-src')).toEqual(["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']);
    expect(directive(csp, 'img-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(directive(csp, 'font-src')).toEqual(["'self'", 'data:', 'https://fonts.gstatic.com']);
    expect(directive(csp, 'media-src')).toEqual(["'self'", 'blob:']);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
  });

  it('does not allow a remote Ollama host', () => {
    expect(directive(csp, 'connect-src')).not.toContain('http:');
    expect(directive(csp, 'connect-src')).not.toContain('*');
  });
});

describe('isAllowedNavigation', () => {
  it('allows the app origin', () => {
    expect(isAllowedNavigation('app://takingnotes/', null)).toBe(true);
    expect(isAllowedNavigation('app://takingnotes/notes/1', null)).toBe(true);
  });

  it('allows the dev server origin only in dev', () => {
    expect(isAllowedNavigation('http://localhost:5199/', 'http://localhost:5199')).toBe(true);
    expect(isAllowedNavigation('http://localhost:5199/src/main.tsx', 'http://localhost:5199/')).toBe(true);
    expect(isAllowedNavigation('http://localhost:5199/', null)).toBe(false);
    expect(isAllowedNavigation('http://localhost:5200/', 'http://localhost:5199')).toBe(false);
  });

  it('blocks everything else', () => {
    expect(isAllowedNavigation('https://example.com/', null)).toBe(false);
    expect(isAllowedNavigation('app://evil/', null)).toBe(false);
    expect(isAllowedNavigation('file:///etc/passwd', 'http://localhost:5199')).toBe(false);
    expect(isAllowedNavigation('javascript:alert(1)', null)).toBe(false);
    expect(isAllowedNavigation('garbage', 'not a url')).toBe(false);
  });
});

describe('isExternalHttpUrl', () => {
  it('is true for http(s) links off the app origins', () => {
    expect(isExternalHttpUrl('https://ollama.com/download')).toBe(true);
    expect(isExternalHttpUrl('http://example.com')).toBe(true);
  });

  it('is false for the app origin, the dev server and other schemes', () => {
    expect(isExternalHttpUrl('app://takingnotes/x')).toBe(false);
    expect(isExternalHttpUrl('http://localhost:5199/', 'http://localhost:5199')).toBe(false);
    expect(isExternalHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isExternalHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isExternalHttpUrl('mailto:a@b.c')).toBe(false);
    expect(isExternalHttpUrl('nonsense')).toBe(false);
  });
});
