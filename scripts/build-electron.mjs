// Bundles the Electron main process and preload into dist-electron/*.cjs.
// The renderer is the ordinary Vite build in dist/ (`npm run build`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  absWorkingDir: projectDir,
  entryPoints: {
    main: 'electron/main.ts',
    preload: 'electron/preload.ts',
  },
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
});
