import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cache-verdict.mjs');

test('--version prints the package version', () => {
  const out = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  if (!/^\d+\.\d+\.\d+/.test(out.trim())) throw new Error('unexpected version: ' + out);
});

test('--help names the tool and its MVP', () => {
  const out = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  if (!out.includes('cache-verdict')) throw new Error('help does not name the tool');
});
