import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
// A git worktree's `node_modules` is a symlink to the shared checkout three
// levels up (`.claude/worktrees/<name>/node_modules -> ../../../node_modules`).
// Vite's dev-server file allowlist defaults to this project's own root, so a
// worktree's test run otherwise fails with "Denied ID" the moment a test
// transitively resolves a package by its real (symlink-resolved) path - e.g.
// pdfjs-dist's worker, pulled in by the syllabus importer. Harmless to widen
// in the main checkout too: this only affects what Vite will serve to its own
// test runner, not a publicly reachable server.
const sharedCheckoutDir = path.resolve(rootDir, '../../..');

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(rootDir, './src'),
    },
  },
  server: {
    fs: {
      allow: [rootDir, sharedCheckoutDir],
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
