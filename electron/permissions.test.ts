import { describe, expect, it } from 'vitest';
import { isDeviceAllowed, isPermissionAllowed, wantsMicrophone } from './permissions';

const APP = 'app://takingnotes';
const DEV = 'http://localhost:5173/';

describe('isPermissionAllowed', () => {
  it('allows audio media for app origin', () => {
    expect(isPermissionAllowed('media', APP, { mediaTypes: ['audio'] })).toBe(true);
  });

  it('denies video media', () => {
    expect(isPermissionAllowed('media', APP, { mediaTypes: ['video'] })).toBe(false);
    expect(isPermissionAllowed('media', APP, { mediaTypes: ['audio', 'video'] })).toBe(false);
  });

  it('denies media when the media type is unknown or missing', () => {
    expect(isPermissionAllowed('media', APP)).toBe(false);
    expect(isPermissionAllowed('media', APP, { mediaTypes: [] })).toBe(false);
    expect(isPermissionAllowed('media', APP, { mediaTypes: ['unknown'] })).toBe(false);
  });

  it('denies foreign origin', () => {
    expect(isPermissionAllowed('media', 'https://evil.example', { mediaTypes: ['audio'] })).toBe(false);
    expect(isPermissionAllowed('hid', 'https://evil.example')).toBe(false);
    expect(isPermissionAllowed('bluetooth', 'app://other')).toBe(false);
    expect(isPermissionAllowed('fullscreen', 'not a url')).toBe(false);
    expect(isPermissionAllowed('fullscreen', '')).toBe(false);
  });

  it('allows exactly the listed permissions for the app origin', () => {
    for (const permission of ['bluetooth', 'hid', 'clipboard-sanitized-write', 'fullscreen']) {
      expect(isPermissionAllowed(permission, APP), permission).toBe(true);
    }
    for (const permission of ['geolocation', 'notifications', 'clipboard-read', 'usb', 'serial', 'openExternal', 'display-capture']) {
      expect(isPermissionAllowed(permission, APP), permission).toBe(false);
    }
  });

  it('accepts the origin as Chromium writes it: with a trailing slash or as a full URL', () => {
    expect(isPermissionAllowed('hid', 'app://takingnotes/')).toBe(true);
    expect(isPermissionAllowed('hid', 'app://takingnotes/sessions/1')).toBe(true);
  });

  it('allows the dev origin only when a dev URL is set', () => {
    expect(isPermissionAllowed('media', 'http://localhost:5173', { mediaTypes: ['audio'] })).toBe(false);
    expect(isPermissionAllowed('media', 'http://localhost:5173', { mediaTypes: ['audio'] }, DEV)).toBe(true);
    expect(isPermissionAllowed('media', 'http://localhost:5174', { mediaTypes: ['audio'] }, DEV)).toBe(false);
  });
});

describe('isDeviceAllowed', () => {
  it('allows hid device for app origin', () => {
    expect(isDeviceAllowed({ deviceType: 'hid', origin: APP })).toBe(true);
    expect(isDeviceAllowed({ deviceType: 'hid', origin: `${APP}/` })).toBe(true);
    expect(isDeviceAllowed({ deviceType: 'bluetooth', origin: APP })).toBe(true);
  });

  it('denies other device types and foreign origins', () => {
    expect(isDeviceAllowed({ deviceType: 'usb', origin: APP })).toBe(false);
    expect(isDeviceAllowed({ deviceType: 'serial', origin: APP })).toBe(false);
    expect(isDeviceAllowed({ deviceType: 'hid', origin: 'https://evil.example' })).toBe(false);
  });

  it('allows the dev origin only when a dev URL is set', () => {
    expect(isDeviceAllowed({ deviceType: 'hid', origin: 'http://localhost:5173' })).toBe(false);
    expect(isDeviceAllowed({ deviceType: 'hid', origin: 'http://localhost:5173' }, DEV)).toBe(true);
  });
});

describe('wantsMicrophone', () => {
  it('is true only for a media request that includes audio', () => {
    expect(wantsMicrophone('media', { mediaTypes: ['audio'] })).toBe(true);
    expect(wantsMicrophone('media', { mediaTypes: ['video'] })).toBe(false);
    expect(wantsMicrophone('media', {})).toBe(false);
    expect(wantsMicrophone('hid', { mediaTypes: ['audio'] })).toBe(false);
  });
});
