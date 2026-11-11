// `npm test`: the web suite (root vitest.config.ts, src/**) and then the
// desktop shell's suite (electron/vitest.config.ts). Arguments after `--` go to
// both, so `npm test -- src/sessions` still filters the web suite.
//
// With no arguments both suites must find tests. With a filter, a suite the
// filter doesn't touch is allowed to find none (--passWithNoTests), but at least
// one suite must have run something, or the filter matched nothing at all.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitest = path.join(projectDir, 'node_modules/vitest/vitest.mjs');
const forwarded = process.argv.slice(2);
const filtered = forwarded.length > 0;

function runSuite(name, configArgs) {
  const args = [vitest, 'run', ...configArgs, ...(filtered ? ['--passWithNoTests'] : []), ...forwarded];
  // Piped (to spot "no test files"), so keep vitest's colours when we are on a terminal.
  const env = process.stdout.isTTY ? { ...process.env, FORCE_COLOR: '1' } : process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: projectDir, env, stdio: ['inherit', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // vitest prints "No test files found" when a filter matches nothing in this suite.
      const ranNothing = output.includes('No test files found');
      console.log(`[test-all] ${name}: exit ${code}${ranNothing ? ' (no matching tests)' : ''}`);
      resolve({ status: code ?? 1, ranNothing });
    });
  });
}

const web = await runSuite('web suite', []);
const desktop = await runSuite('electron suite', ['--config', 'electron/vitest.config.ts']);

if (web.status !== 0 || desktop.status !== 0) process.exit(1);
if (web.ranNothing && desktop.ranNothing) {
  console.error('[test-all] no test files matched the filter in either suite');
  process.exit(1);
}
