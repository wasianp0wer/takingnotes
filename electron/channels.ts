// IPC channel names shared by main.ts and preload.ts. Plain strings, no imports.

/** main → renderer: a `ChooserMessage`. */
export const CHOOSER_MESSAGE = 'takingnotes:devices:chooser';
/** renderer → main: `(requestId, deviceId)`. */
export const CHOOSER_SELECT = 'takingnotes:devices:select';
/** renderer → main: `(requestId)`. */
export const CHOOSER_CANCEL = 'takingnotes:devices:cancel';
/** renderer → main, invoke: `(baseUrl)` → `boolean`. */
export const OLLAMA_PROBE = 'takingnotes:ollama:probe';
