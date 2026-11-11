import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = `sha256:${'a'.repeat(64)}`;

/**
 * Run npm through the CLI that launched `npm test` when it is available. That
 * avoids relying on `.cmd` shims on Windows; the plain command is only a
 * fallback for `node --test` invoked outside npm.
 */
function runNpm(args, options = {}) {
  const execpath = process.env.npm_execpath;
  const useNpmCli = typeof execpath === 'string' && execpath !== '' && existsSync(execpath);
  const command = useNpmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const prefix = useNpmCli ? [execpath] : [];
  return execFileSync(command, [...prefix, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: !useNpmCli && process.platform === 'win32',
    ...options,
  });
}

function runInstalledCli(installedCli, cwd, args) {
  try {
    const stdout = execFileSync(process.execPath, [installedCli, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
    };
  }
}

function sample(index, { hit, totalMs, restoreMs = 0 }) {
  return {
    schemaVersion: 1,
    timestamp: `2026-01-01T00:0${index}:00.000Z`,
    key: KEY,
    hit,
    miss: !hit,
    cold: !hit,
    warm: hit,
    temperature: hit ? 'warm' : 'cold',
    buildMs: totalMs - restoreMs,
    restoreMs,
    restoreCostMs: restoreMs,
    totalMs,
    sizeBytes: 2048,
    restoreSizeBytes: hit ? 2048 : 0,
    stored: true,
    command: 'node build.mjs',
  };
}

/**
 * A ledger whose middle sample hit and whose two later samples missed. The
 * rows are written directly so the output under test does not depend on
 * machine speed; the real run path is covered by test/history.test.mjs and
 * docs/validation/history.sh.
 */
function writeHistoryFixture(dir) {
  const config = {
    schemaVersion: 1,
    ecosystem: 'npm',
    displayName: 'history-install',
    command: 'node build.mjs',
    inputs: ['src/**', 'build.mjs'],
    cachePath: ['cache'],
    detectedFrom: ['package.json'],
  };
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'input.txt'), 'A\n');
  writeFileSync(path.join(dir, 'build.mjs'), '// fixture build\n');
  writeFileSync(path.join(dir, '.cache-verdict.json'), `${JSON.stringify(config, null, 2)}\n`);

  const target = path.join(dir, '.cache-verdict', 'ledger.jsonl');
  mkdirSync(path.dirname(target), { recursive: true });
  const rows = [
    sample(1, { hit: false, totalMs: 200 }),
    sample(2, { hit: true, totalMs: 50, restoreMs: 5 }),
    sample(3, { hit: false, totalMs: 190 }),
  ];
  writeFileSync(target, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

test('a clean npm pack and install prints the history and regression point', (t) => {
  const work = mkdtempSync(path.join(tmpdir(), 'cache-verdict-history-install-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));

  const packDir = path.join(work, 'pack');
  const installDir = path.join(work, 'install');
  mkdirSync(packDir);
  mkdirSync(installDir);

  // Keep npm's cache and logs inside the temporary directory. A shared cache
  // can be read-only in sandboxes and CI, which would fail before npm ever
  // looks at the tarball.
  const npmEnv = {
    ...process.env,
    npm_config_cache: path.join(work, 'npm-cache'),
    npm_config_logs_dir: path.join(work, 'npm-logs'),
    npm_config_update_notifier: 'false',
  };

  runNpm(['pack', '--pack-destination', packDir], { cwd: repoRoot, env: npmEnv });
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, `expected one tarball, found ${tarballs.join(', ')}`);

  writeFileSync(
    path.join(installDir, 'package.json'),
    `${JSON.stringify({ name: 'cache-verdict-history-clean-install', version: '1.0.0', private: true }, null, 2)}\n`,
  );
  runNpm(
    ['install', path.join(packDir, tarballs[0]), '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'],
    { cwd: installDir, env: npmEnv },
  );

  const installedCli = path.join(installDir, 'node_modules', 'cache-verdict', 'bin', 'cache-verdict.mjs');
  assert.ok(existsSync(installedCli), 'the installed package must expose bin/cache-verdict.mjs');

  const help = runInstalledCli(installedCli, installDir, ['report', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--history/);
  assert.match(help.stdout, /regression point/);
  assert.match(help.stdout, /regressedAt/);

  const fixture = path.join(work, 'fixture');
  mkdirSync(fixture);
  writeHistoryFixture(fixture);

  const plain = runInstalledCli(installedCli, fixture, ['report']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /History:/);

  const history = runInstalledCli(installedCli, fixture, ['report', '--history']);
  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /^History:$/m);
  assert.match(
    history.stdout,
    /^\s+1\s+2026-01-01T00:01:00\.000Z\s+MISS\s+200\.0 ms\s+-5\.0 ms$/m,
  );
  assert.match(
    history.stdout,
    /^\s+2\s+2026-01-01T00:02:00\.000Z\s+HIT\s+50\.0 ms\s+145\.0 ms$/m,
  );
  assert.match(
    history.stdout,
    /^\s+3\s+2026-01-01T00:03:00\.000Z\s+MISS\s+190\.0 ms\s+5\.0 ms$/m,
  );
  assert.match(history.stdout, /Regression: sample 2 was the last hit; no sample has hit since\./);

  const json = runInstalledCli(installedCli, fixture, ['report', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const analysis = JSON.parse(json.stdout);
  assert.equal(analysis.regressedAt, 2);
  assert.deepEqual(
    analysis.history.map((entry) => entry.hit),
    [false, true, false],
  );
  assert.deepEqual(analysis.history[1], {
    index: 2,
    timestamp: '2026-01-01T00:02:00.000Z',
    hit: true,
    totalMs: 50,
    netMs: 145,
  });
});
