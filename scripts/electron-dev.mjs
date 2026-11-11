// `npm run desktop:dev`: Vite dev server (with HMR) plus the Electron shell
// pointed at it. Ctrl+C, or closing the window, stops both.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const DEV_URL = `http://localhost:${PORT}`;
const node = process.execPath;

const children = new Set();

function start(bin, args, env = process.env) {
  const child = spawn(bin, args, { cwd: projectDir, env, stdio: 'inherit' });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function stopAll(code) {
  for (const child of children) child.kill();
  process.exit(code);
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite did not start at ${url} within ${timeoutMs / 1000}s`);
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = start(bin, args);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited with ${code}`))));
  });
}

process.on('SIGINT', () => stopAll(130));
process.on('SIGTERM', () => stopAll(143));

try {
  const vite = start(node, [path.join(projectDir, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort']);
  vite.on('exit', (code) => stopAll(code ?? 1));
  await waitForServer(DEV_URL);
  await run(node, [path.join(projectDir, 'scripts/build-electron.mjs')]);

  const { default: electronBinary } = await import('electron');
  const electron = start(electronBinary, ['.'], { ...process.env, TAKINGNOTES_DEV_URL: DEV_URL });
  electron.on('exit', (code) => stopAll(code ?? 0));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  stopAll(1);
}
