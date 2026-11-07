#!/usr/bin/env node
// Run the npm-build-cache example against a temporary copy of the project, so
// trying it out never leaves .cache-verdict/, node_modules/.cache, or dist/ in
// the checkout. Uses only Node.js built-ins.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'bin', 'cache-verdict.mjs');
const source = path.join(here, 'npm-build-cache');

const temporary = mkdtempSync(path.join(tmpdir(), 'cache-verdict-example-'));
const project = path.join(temporary, 'npm-build-cache');

function run(args) {
  console.log(`$ node ${path.relative(process.cwd(), cli) || cli} ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: project,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cache-verdict ${args.join(' ')} exited with status ${result.status}`);
  }
}

try {
  cpSync(source, project, { recursive: true });

  // A manual run in the checkout may have left state behind; always start clean.
  for (const leftover of ['node_modules', '.cache-verdict', 'dist']) {
    rmSync(path.join(project, leftover), { recursive: true, force: true });
  }

  console.log(`Running the example in a temporary copy: ${project}\n`);
  run(['init']);
  run(['run']);
  run(['run']);
  run(['report']);

  // check prints the same report again, so only surface it when it disagrees.
  const check = spawnSync(process.execPath, [cli, 'check'], {
    cwd: project,
    encoding: 'utf8',
  });
  if (check.error) throw check.error;
  if (check.status !== 0) {
    process.stderr.write(check.stdout ?? '');
    process.stderr.write(check.stderr ?? '');
    throw new Error(`cache-verdict check exited with status ${check.status}`);
  }

  console.log('\ncheck exited 0: this example cache pays.');
} catch (error) {
  process.exitCode = 1;
  console.error(`\nexample failed: ${error.message}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
  console.log('Removed the temporary copy.');
}
