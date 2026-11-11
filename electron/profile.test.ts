import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { userDataPath } from './profile';

const appData = path.join('/Users', 'u', 'Library', 'Application Support');

describe('userDataPath', () => {
  it('packaged: the same TakingNotes directory as before, so nothing migrates', () => {
    expect(userDataPath({ appData, devUrl: null, hasUserDataDirSwitch: false })).toBe(
      path.join(appData, 'TakingNotes'),
    );
  });

  it('dev: its own directory, apart from the installed app and its single-instance lock', () => {
    expect(userDataPath({ appData, devUrl: 'http://localhost:5199/', hasUserDataDirSwitch: false })).toBe(
      path.join(appData, 'TakingNotes Dev'),
    );
  });

  it('an explicit --user-data-dir wins, so throwaway profiles stay throwaway', () => {
    expect(userDataPath({ appData, devUrl: null, hasUserDataDirSwitch: true })).toBeNull();
    expect(userDataPath({ appData, devUrl: 'http://localhost:5199/', hasUserDataDirSwitch: true })).toBeNull();
  });

  it('treats an empty dev URL as packaged', () => {
    expect(userDataPath({ appData, devUrl: '', hasUserDataDirSwitch: false })).toBe(
      path.join(appData, 'TakingNotes'),
    );
  });
});
