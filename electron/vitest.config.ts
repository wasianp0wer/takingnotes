import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const electronDir = path.dirname(fileURLToPath(import.meta.url));

// The desktop shell's own suite. The root config only picks up `src/**` and
// runs in happy-dom; the main-process modules are plain Node code.
export default defineConfig({
  root: electronDir,
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
  },
});
