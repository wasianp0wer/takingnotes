# Desktop spike (Task 7)

Run on 2026-11-11 on macOS 15 (Darwin 24.4.0, Apple Silicon), Electron 45.3.0,
Node 25.8.1, from `npm run desktop:build` output (`dist/` + `dist-electron/`).
Each check below was run; nothing here is inferred.

## How it was checked

Nobody looked at a window, so the checks were automated with a throwaway
harness, `scripts/spike/desktop-spike.cjs` (in the gitignored `scripts/spike/`,
so it is not committed and not shipped). It:

1. points `userData` at a temp directory (so the real profile is untouched),
2. `require`s the unchanged `dist-electron/main.cjs`, so the window, the
   `app://` handler, the CSP header and the navigation guards are exactly the
   shipped ones,
3. logs every http(s) host the session contacts and every redirect
   (`session.webRequest`), plus all renderer console messages,
4. after `did-finish-load`, runs each check in the renderer with
   `webContents.executeJavaScript`, prints the results as JSON and quits.

The workers and pdf.js are exercised through the **built** assets
(`/assets/regexRunner.worker-*.js`, `/assets/whisper.worker-*.js`,
`/assets/pdf-*.js`, `/assets/pdf.worker-*.mjs`), using the same message
protocols the app uses. The UI itself was not clicked.

The window was a normal on-screen window (not headless, no offscreen flag).

## Results

| # | Check | Result |
|---|---|---|
| 1 | App renders | **Pass.** `location.href` = `app://takingnotes/`; `#root` has content; the Sessions view text ("No sessions yet. Use Start session…") is present. `window.takingnotesDesktop` = `{ platform: "darwin" }`; `require` and `process` are undefined in the page; `isSecureContext` = true. |
| 2 | IndexedDB, origin | **Pass.** `location.origin` = `app://takingnotes`. The app had already created `takingnotes@5`. A probe DB wrote and read back a `Uint8Array`. On disk the store is `IndexedDB/app_takingnotes_0.indexeddb.leveldb`. |
| 3 | Regex search worker | **Pass.** The built module worker answered `{ ok: true, matches: [null, { index: 10, length: 7 }] }` for `wee?k \d+`. |
| 4 | Whisper worker + WebGPU | **Pass, after a CSP change (below).** `navigator.gpu.requestAdapter()` resolves in the page and inside a worker (vendor `apple`, architecture `metal-3`). The Whisper worker transcribed 1 s of a 440 Hz tone with `Xenova/whisper-tiny.en` (output " Beeping."). The cached files are `encoder_model.onnx` (fp32) and `decoder_model_merged_q4.onnx`, which is the WebGPU dtype branch in `whisper.worker.ts`, so WebGPU was used. The wasm fallback was **not** exercised in Electron (it stays covered by the unit tests). |
| 5 | PDF.js | **Pass.** pdf.js 6.3.289 parsed a 1-page syllabus PDF and returned its text: `HIST 101 Syllabus \| Week 1: Introduction to the archive \| Week 2: Reading primary sources`. `samples/` has no syllabus PDF (only `samples/handwriting`), so the PDF was generated for the spike (Helvetica text, real xref). |
| 6 | Ollama from `app://` | **Pass.** See below. |
| 7 | `npm run desktop:dev` + HMR | **Pass.** See below. |

### 4. The CSP had to change for Whisper

With the brief's `script-src 'self' 'wasm-unsafe-eval'`, the Whisper worker
failed outright:

```
no available backend found. ERR: [webgpu] TypeError: Failed to fetch dynamically
imported module: blob:app://takingnotes/a2a334ee-…
Loading the script 'blob:app://takingnotes/…' violates the following Content
Security Policy directive: "script-src 'self' 'wasm-unsafe-eval'"
```

transformers.js 4.3.0 (`src/backends/onnx.js`, `ensureWasmLoaded`) fetches
onnxruntime's `ort-wasm-simd-threaded.asyncify.mjs` from jsdelivr, wraps it in
a `blob:` URL and `import()`s that. So no ORT backend (WebGPU or wasm) can
start. `script-src` now adds `blob:`. The alternative was adding
`https://cdn.jsdelivr.net` to `script-src`, which runs remote code directly;
`blob:` keeps the download under `connect-src` and only same-origin script can
mint a `blob:` URL.

### Also changed: Google Fonts

`src/index.css` `@import`s the TASA Orbiter face from
`https://fonts.googleapis.com` (files from `https://fonts.gstatic.com`). The
brief's `style-src`/`font-src` blocked it (console: "Loading the stylesheet
'https://fonts.googleapis.com/…' violates … style-src"). Both hosts were added.
Self-hosting the font would let them go again.

### Hosts actually contacted (cold cache)

| Host | Why |
|---|---|
| `huggingface.co` | model config/tokenizer/onnx; `307` to itself, then `302` for large files |
| `us.aws.cdn.hf.co` | the `302` target for the `.onnx` files (Xet bridge, path `/xet-bridge-us/…`) |
| `cdn.jsdelivr.net` | `onnxruntime-web@1.31.0-dev.20260914-8d85527a0` `.mjs` and `.wasm` |
| `fonts.googleapis.com`, `fonts.gstatic.com` | the UI font |
| `localhost:11434`, `127.0.0.1:11434` | Ollama |

`connect-src` lists `https://huggingface.co`, `https://*.huggingface.co` and
`https://*.hf.co`. Only `us.aws.cdn.hf.co` was observed as a CDN host; the
wildcards also cover the other hosts the Hub is known to redirect to
(`cdn-lfs*.huggingface.co`, `cdn-lfs*.hf.co`, `cas-bridge.xethub.hf.co`), which
were not observed here. No CSP violation was logged for any Hugging Face host.

On a second run with the same profile there was **no** traffic to Hugging
Face or jsdelivr: everything came from the Cache API (`transformers-cache`),
and load + transcribe took about 1.1 s. So the Cache API works on the
`app://` origin and the model works offline once cached.

### CSP and guard spot checks

- `fetch('https://example.com/')` and `fetch('http://192.168.1.1:11434/…')`
  are refused by `connect-src` (a LAN Ollama is out of scope, as decided).
- `eval('1')` throws `EvalError`.
- `location.href = 'https://example.com/'` is cancelled by `will-navigate`;
  the page stays on `app://takingnotes/`. Per design the URL was handed to
  `shell.openExternal`, so it opened in the system browser.
- `app://takingnotes/assets/nope.js` → 404; `app://takingnotes/notes/123` →
  200 (`index.html`, SPA fallback); `.mjs` is served as `text/javascript`, and
  every response carries the CSP header.
- `crossOriginIsolated` is false (no COOP/COEP), the same as the web build.

### 6. Ollama

`curl -s localhost:11434/api/tags` answered (Ollama 0.40.13, models
`gemma4-agent:latest`, `gemma4:12b`, `gemma4:26b`).

`OLLAMA_ORIGINS` was **not** set (`launchctl getenv OLLAMA_ORIGINS` empty, not
in the shell env), so the server ran with its defaults. Its own startup log
(`~/.ollama/logs/server.log`) prints the effective list:

```
OLLAMA_ORIGINS:[http://localhost https://localhost http://localhost:* https://localhost:*
http://127.0.0.1 https://127.0.0.1 http://127.0.0.1:* https://127.0.0.1:* http://0.0.0.0
https://0.0.0.0 http://0.0.0.0:* https://0.0.0.0:* app://* file://* tauri://*
vscode-webview://* vscode-file://*]
```

`app://*` is in the default list. From the `app://takingnotes` page:

- `GET http://localhost:11434/api/tags` → **200**, three models listed.
- `POST http://localhost:11434/api/show` with `Content-Type: application/json`
  (forces a CORS preflight, like the app's `/api/generate`) → **200**.
- `GET http://127.0.0.1:11434/api/tags` → **200**.

**Decision input for Task 8: requests from `app://` are accepted by a default
Ollama (0.40.13), so the main-process route is not needed.** Verified on this
one Ollama version only.

### 7. Dev workflow

- `npm run desktop:dev` started Vite on 5199, built the shell, launched
  Electron; the window loaded `http://localhost:5199` (an
  `http_localhost_5199` IndexedDB appeared in the profile). Ctrl+C (SIGINT)
  stopped Vite and Electron together.
- The profile went to `~/Library/Application Support/TakingNotes`, confirming
  `app.setName('TakingNotes')` sets the data location. (The spike deleted that
  directory afterwards; it did not exist before.)
- HMR: with Vite on 5199 and the harness on `TAKINGNOTES_DEV_URL`, editing the
  text in `src/sessions/SessionsView.tsx` showed in the window in about 600 ms.
  A marker set on `window` survived, so it was a hot update, not a reload.
  Console: `[vite] hot updated: /src/sessions/SessionsView.tsx`. The edit was
  reverted.
- In dev the CSP header is **not** applied (pages come from Vite, not the
  `app://` handler). CSP problems only show in the `app://` load.

### `npx electron .` and single instance

`npx electron .` (via `"main": "dist-electron/main.cjs"`) opened the app and
created `app_takingnotes_0.indexeddb.leveldb`. A second `npx electron .`
exited with code 0 within a second while the first kept running (it received
`second-instance` and focused its window; the focus itself was not observed).

## Not verified

- Bluetooth, HID, microphone permissions: Task 9.
- The Whisper wasm fallback inside Electron.
- Windows and Linux.
- Packaged (asar) build: Task 11.

## Notes for later tasks

- The window title comes from `index.html`'s `<title>`
  ("takingnotes.ink - Drawing & Animation"), not "TakingNotes".

## Navigation hardening (fix round 1)

`main.ts` now applies one guard (`navigationAction` in `security.ts`) to every
webContents via `app.on('web-contents-created')`: `will-navigate` (off-origin
http(s) opens the system browser, anything else is refused),
`will-frame-navigate` (sub-frames only; refused off-origin) and `will-redirect`
(refused off-origin); `will-attach-webview` is always refused, and window-open
is always denied. Rerunning the harness with a listener registered after the
guard showed:

- in-origin sub-frame loads and navigations (`app://takingnotes/manifest.json`
  → `icon.svg`) reach `will-frame-navigate` and are allowed;
- an off-origin sub-frame navigation never reaches the guard: CSP blocks it in
  the renderer first ("Framing 'https://example.com/' violates … default-src
  'self'"), and Chromium refuses `file://` ("Not allowed to load local
  resource"). So the deny path of the frame and redirect guards could not be
  exercised end to end; it is defence in depth, covered by the
  `navigationAction` unit tests;
- `customElements.get('webview')` is undefined (no `<webview>` tag);
- all earlier checks (render, IndexedDB, regex worker, pdf.js, Ollama,
  Whisper) still pass.

## Task 10: device picker and Ollama probe (built app)

Run on 2026-11-11, same machine, after `npm run desktop:build` at commit
`014b895`. The harness is `scripts/spike/picker-spike.cjs` (gitignored, not
committed). It uses a temp `userData`, `require`s the unchanged
`dist-electron/main.cjs`, and drives the page with `executeJavaScript`. Nobody
clicked the window.

| Check | Result |
|---|---|
| Bridge shape | `Object.keys(window.takingnotesDesktop)` = `platform`, `devices`, `probeOllama`. |
| HID picker opens | **Pass.** `navigator.hid.requestDevice({ filters: [] })`, called with a user gesture (`executeJavaScript(code, true)`), opened the in-app dialog titled **Choose a USB device**. It listed the 12 HID devices on this Mac (for example "Apple Internal Keyboard / Trackpad", "Keyboard Backlight", "Headset"). A screenshot showed the Radix dialog in the app theme over a dimmed overlay. |
| Cancel settles the request | **Pass.** Clicking **Cancel** closed the dialog, and `requestDevice()` resolved with an empty array (`{ ok: true, n: 0 }`) instead of hanging. |
| `probeOllama` | **Pass.** With Ollama running (`curl localhost:11434/api/tags` gave 200): `http://localhost:11434` gave true and `http://127.0.0.1:11434` gave true. `http://localhost:1` (a closed port) gave false. `http://example.com` and `https://localhost:11434` gave false. Those last two are refused by the URL check before anything is fetched. |

**Not checked:**
- **Bluetooth.** `navigator.bluetooth.requestDevice()` was not called. It raises
  the macOS Bluetooth permission prompt, which must not be answered on the
  user's behalf. The Bluetooth path ("Choose a tablet", the live list) is
  covered only by unit tests.
- **The real Connect button.** No tablet was attached. The HID request was
  made directly, without the app's Huion filters, so the dialog listed every
  HID device.
- **Selecting a device.** Selection in the built app was not exercised. It is
  covered by unit tests only.
- **`npm run desktop:dev`.** It was not re-run for this task. The check above
  used the production `app://` build.
