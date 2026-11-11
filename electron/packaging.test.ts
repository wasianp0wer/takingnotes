// Pins the packaging values the desktop app can't run correctly without: the
// app ID is the bundle ID macOS keys permissions to, the Info.plist strings are what macOS
// requires before it grants the mic or Bluetooth, and `files` must ship both
// the renderer and the shell.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(projectDir, name), 'utf8')) as Record<string, unknown>;
}

type Target = { target: string; arch: string[] };

describe('electron-builder.json', () => {
  const config = readJson('electron-builder.json');
  const mac = config.mac as Record<string, unknown>;
  const win = config.win as Record<string, unknown>;

  it('uses the fixed app ID and product name the shell sets at runtime', () => {
    expect(config.appId).toBe('org.takingnotes.app');
    expect(config.productName).toBe('TakingNotes');
  });

  it('ships the renderer build, the shell bundle and package.json', () => {
    expect(config.files).toEqual(expect.arrayContaining(['dist/**', 'dist-electron/**', 'package.json']));
    expect((config.directories as Record<string, unknown>).output).toBe('release');
  });

  it('ships no node_modules: the renderer and the shell are fully bundled', () => {
    // electron-builder copies production dependencies into the app unless told
    // not to; here that was ~430 MB (onnxruntime-node included) nobody loads.
    expect(config.files).toContain('!node_modules/**');
    expect(config.npmRebuild).toBe(false);
  });

  it('declares both macOS usage strings in Info.plist', () => {
    expect(mac.extendInfo).toEqual({
      NSMicrophoneUsageDescription: 'TakingNotes records lecture audio for your notes.',
      NSBluetoothAlwaysUsageDescription: 'TakingNotes connects to your drawing tablet over Bluetooth.',
    });
  });

  it('builds an ad-hoc signed arm64 dmg and zip for macOS', () => {
    const targets = mac.target as Target[];
    for (const kind of ['dmg', 'zip']) {
      expect(targets).toContainEqual({ target: kind, arch: ['arm64'] });
    }
    // "-" is ad-hoc signing; null would skip signing and leave a bundle whose
    // signature fails `codesign --verify` (Gatekeeper then calls it damaged).
    expect(mac.identity).toBe('-');
    expect(mac.hardenedRuntime).toBe(false);
    expect(mac.entitlements).toBe('build/entitlements.mac.plist');
  });

  it('builds an x64 NSIS installer for Windows', () => {
    expect(win.target).toEqual([{ target: 'nsis', arch: ['x64'] }]);
  });
});

describe('build/entitlements.mac.plist', () => {
  const plist = readFileSync(path.join(projectDir, 'build/entitlements.mac.plist'), 'utf8');

  it.each([
    'com.apple.security.device.audio-input',
    'com.apple.security.device.bluetooth',
    'com.apple.security.cs.allow-jit',
  ])('grants %s', (key) => {
    expect(plist).toMatch(new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*<true/>`));
  });
});

describe('package.json packaging', () => {
  const pkg = readJson('package.json');
  const scripts = pkg.scripts as Record<string, string>;
  const devDeps = pkg.devDependencies as Record<string, string>;

  it('has a dist script per platform that builds first', () => {
    expect(scripts['desktop:dist:mac']).toBe('npm run desktop:build && electron-builder --mac');
    expect(scripts['desktop:dist:win']).toBe('npm run desktop:build && electron-builder --win');
  });

  it('pins electron-builder to an exact version', () => {
    expect(devDeps['electron-builder']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
