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

function writePolicyFixture(dir, policy) {
  const config = {
    schemaVersion: 1,
    ecosystem: 'npm',
    displayName: 'npm',
    command: 'node build.mjs',
    inputs: ['src/**', 'build.mjs'],
    cachePath: ['cache'],
    detectedFrom: ['package.json'],
    policy,
  };
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'input.txt'), 'A\n');
  writeFileSync(path.join(dir, 'build.mjs'), '// fixture build\n');
  writeFileSync(path.join(dir, '.cache-verdict.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Cold 100 ms, warm 20 ms build + 5 ms restore = 75 ms net per hit.
 * Both samples are written directly so the policy result does not depend on
 * machine speed; `run` timing itself is covered by test/policy.test.mjs.
 */
function writePolicyLedger(dir) {
  const cold = {
    schemaVersion: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    key: KEY,
    hit: false,
    miss: true,
    cold: true,
    warm: false,
    temperature: 'cold',
    forcedCold: false,
    buildMs: 100,
    restoreMs: 0,
    restoreCostMs: 0,
    totalMs: 100,
    sizeBytes: 2048,
    cacheSizeBytes: 2048,
    restoreSizeBytes: 0,
    stored: true,
    command: 'node build.mjs',
  };
  const warm = {
    schemaVersion: 1,
    timestamp: '2026-01-01T00:01:00.000Z',
    key: KEY,
    hit: true,
    miss: false,
    cold: false,
    warm: true,
    temperature: 'warm',
    forcedCold: false,
    buildMs: 20,
    restoreMs: 5,
    restoreCostMs: 5,
    totalMs: 25,
    sizeBytes: 2048,
    cacheSizeBytes: 2048,
    restoreSizeBytes: 2048,
    stored: true,
    command: 'node build.mjs',
  };

  const target = path.join(dir, '.cache-verdict', 'ledger.jsonl');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${[cold, warm].map((row) => JSON.stringify(row)).join('\n')}\n`);
}

test('a clean npm pack and install enforces the savings policy', (t) => {
  const work = mkdtempSync(path.join(tmpdir(), 'cache-verdict-policy-install-'));
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
    `${JSON.stringify({ name: 'cache-verdict-clean-install', version: '1.0.0', private: true }, null, 2)}\n`,
  );
  runNpm(
    ['install', path.join(packDir, tarballs[0]), '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'],
    { cwd: installDir, env: npmEnv },
  );

  const installedCli = path.join(installDir, 'node_modules', 'cache-verdict', 'bin', 'cache-verdict.mjs');
  assert.ok(existsSync(installedCli), 'the installed package must expose bin/cache-verdict.mjs');

  const help = runInstalledCli(installedCli, installDir, ['check', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--min-net-ms <ms>/);
  assert.match(help.stdout, /--max-restore-ms <ms>/);
  assert.match(help.stdout, /4  check missed a threshold/);

  const fixture = path.join(work, 'fixture');
  mkdirSync(fixture);
  writePolicyFixture(fixture, { minNetMsPerHit: 100 });
  writePolicyLedger(fixture);

  const strict = runInstalledCli(installedCli, fixture, ['check']);
  assert.equal(strict.status, 4, strict.stderr);
  assert.match(strict.stdout, /Verdict: cache-pays/);
  assert.match(strict.stdout, /Policy: min net 100\.0 ms per hit/);
  assert.match(strict.stdout, /Policy failure: policy\.minNetMsPerHit missed/);
  assert.match(strict.stderr, /measured 75\.0 ms saved per hit, needs at least 100\.0 ms/);
  assert.match(strict.stderr, /shortfall 25\.0 ms/);

  // The same measured samples pass once the project sets a permissive policy.
  writePolicyFixture(fixture, { minNetMsPerHit: 50 });
  const permissive = runInstalledCli(installedCli, fixture, ['check']);
  assert.equal(permissive.status, 0, permissive.stderr);
  assert.match(permissive.stdout, /Policy: min net 50\.0 ms per hit/);
  assert.doesNotMatch(permissive.stdout, /Policy failure:/);
  assert.equal(permissive.stderr, '');

  // The command-line override wins over the config for that threshold, from
  // the same installed package.
  writePolicyFixture(fixture, { minNetMsPerHit: 100 });
  const overridden = runInstalledCli(installedCli, fixture, ['check', '--min-net-ms', '50']);
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.match(overridden.stdout, /Policy: min net 50\.0 ms per hit/);
});
