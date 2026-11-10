import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cache-verdict.mjs');
const KEY = `sha256:${'a'.repeat(64)}`;

function makeProject(t, configOverrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cache-verdict-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const config = {
    schemaVersion: 1,
    ecosystem: 'npm',
    displayName: 'npm',
    command: 'node build.mjs',
    inputs: ['src/**', 'build.mjs'],
    cachePath: ['cache'],
    detectedFrom: ['package.json'],
    ...configOverrides,
  };
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'input.txt'), 'A\n');
  writeFileSync(path.join(dir, 'build.mjs'), '// fixture build\n');
  writeFileSync(path.join(dir, '.cache-verdict.json'), `${JSON.stringify(config, null, 2)}\n`);
  return dir;
}

function writeRows(dir, { coldMs = 100, warmBuildMs = 20, warmRestoreMs = 5 } = {}) {
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
    buildMs: coldMs,
    restoreMs: 0,
    restoreCostMs: 0,
    totalMs: coldMs,
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
    buildMs: warmBuildMs,
    restoreMs: warmRestoreMs,
    restoreCostMs: warmRestoreMs,
    totalMs: warmBuildMs + warmRestoreMs,
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

function runCli(cwd, args) {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
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

test('check passes when the measured savings satisfy the configured policy', (t) => {
  // Cold 100 ms, warm 20 ms build + 5 ms restore = 75 ms net per hit.
  const dir = makeProject(t, { policy: { minNetMsPerHit: 50, maxRestoreMs: 30 } });
  writeRows(dir);

  const check = runCli(dir, ['check']);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Verdict: cache-pays/);
  assert.match(check.stdout, /Policy: min net 50\.0 ms per hit, max restore 30\.0 ms/);
  assert.doesNotMatch(check.stdout, /Policy failure:/);

  const checkJson = JSON.parse(runCli(dir, ['check', '--json']).stdout);
  assert.deepEqual(checkJson.policy, { minNetMsPerHit: 50, maxRestoreMs: 30 });
  assert.deepEqual(checkJson.policyFailures, []);

  const reportJson = JSON.parse(runCli(dir, ['report', '--json']).stdout);
  assert.deepEqual(reportJson.policy, { minNetMsPerHit: 50, maxRestoreMs: 30 });
  assert.deepEqual(reportJson.policyFailures, []);
});

test('check exits 4 when net savings miss policy.minNetMsPerHit and names the shortfall', (t) => {
  const dir = makeProject(t, { policy: { minNetMsPerHit: 100 } });
  writeRows(dir);

  const check = runCli(dir, ['check']);
  assert.equal(check.status, 4);
  assert.match(check.stderr, /policy\.minNetMsPerHit missed/);
  assert.match(check.stderr, /measured 75\.0 ms saved per hit/);
  assert.match(check.stderr, /needs at least 100\.0 ms/);
  assert.match(check.stderr, /shortfall 25\.0 ms/);

  const json = JSON.parse(runCli(dir, ['check', '--json']).stdout);
  assert.equal(json.verdict, 'cache-pays');
  assert.deepEqual(json.policy, { minNetMsPerHit: 100, maxRestoreMs: null });
  assert.equal(json.policyFailures.length, 1);
  assert.deepEqual(json.policyFailures[0], {
    threshold: 'minNetMsPerHit',
    measured: 75,
    limit: 100,
    shortfall: 25,
    message:
      'policy.minNetMsPerHit missed: measured 75.0 ms saved per hit, needs at least 100.0 ms (shortfall 25.0 ms)',
  });

  const reportJson = JSON.parse(runCli(dir, ['report', '--json']).stdout);
  assert.equal(reportJson.policyFailures[0].threshold, 'minNetMsPerHit');
});

test('check exits 4 when restore cost exceeds policy.maxRestoreMs and names the shortfall', (t) => {
  const dir = makeProject(t, { policy: { maxRestoreMs: 10 } });
  // Cold 100 ms, warm 5 ms build + 25 ms restore = 70 ms net per hit.
  writeRows(dir, { warmBuildMs: 5, warmRestoreMs: 25 });

  const check = runCli(dir, ['check']);
  assert.equal(check.status, 4);
  assert.match(check.stderr, /policy\.maxRestoreMs missed/);
  assert.match(check.stderr, /measured 25\.0 ms restore/);
  assert.match(check.stderr, /allows at most 10\.0 ms/);
  assert.match(check.stderr, /shortfall 15\.0 ms/);

  const json = JSON.parse(runCli(dir, ['check', '--json']).stdout);
  assert.equal(json.verdict, 'cache-pays');
  assert.deepEqual(json.policy, { minNetMsPerHit: null, maxRestoreMs: 10 });
  assert.equal(json.policyFailures.length, 1);
  assert.equal(json.policyFailures[0].threshold, 'maxRestoreMs');
  assert.equal(json.policyFailures[0].measured, 25);
  assert.equal(json.policyFailures[0].limit, 10);
  assert.equal(json.policyFailures[0].shortfall, 15);
});

test('without a policy check keeps the 0, 2, and 3 verdict-only exit codes', (t) => {
  const paying = makeProject(t);
  writeRows(paying);
  const passing = runCli(paying, ['check']);
  assert.equal(passing.status, 0, passing.stderr);
  assert.equal(passing.stderr, '');
  const payingJson = JSON.parse(runCli(paying, ['check', '--json']).stdout);
  assert.deepEqual(payingJson.policy, { minNetMsPerHit: null, maxRestoreMs: null });
  assert.deepEqual(payingJson.policyFailures, []);

  const losing = makeProject(t);
  // Cold 10 ms, warm 20 ms build + 5 ms restore: the cache costs time.
  writeRows(losing, { coldMs: 10, warmBuildMs: 20, warmRestoreMs: 5 });
  const failing = runCli(losing, ['check']);
  assert.equal(failing.status, 2);
  assert.match(failing.stderr, /cache-costs/);

  const waiting = makeProject(t);
  writeRows(waiting);
  // Keep only the cold sample so a cold baseline exists but no warm sample does.
  const ledger = path.join(waiting, '.cache-verdict', 'ledger.jsonl');
  const firstLine = readFileSync(ledger, 'utf8').split('\n')[0];
  writeFileSync(ledger, `${firstLine}\n`);
  const waitingCheck = runCli(waiting, ['check']);
  assert.equal(waitingCheck.status, 3);
  assert.match(waitingCheck.stderr, /not enough samples/);
});

test('command-line thresholds override the config policy per threshold', (t) => {
  const dir = makeProject(t, { policy: { minNetMsPerHit: 100, maxRestoreMs: 10 } });
  writeRows(dir);

  // The config policy fails both thresholds; the flags relax both.
  const relaxed = runCli(dir, ['check', '--min-net-ms', '50', '--max-restore-ms', '30']);
  assert.equal(relaxed.status, 0, relaxed.stderr);

  const equalsForm = runCli(dir, ['check', '--min-net-ms=50', '--max-restore-ms=30']);
  assert.equal(equalsForm.status, 0, equalsForm.stderr);

  // Only the override threshold is replaced; maxRestoreMs still comes from
  // the config, so the restore value of 5 ms keeps it passing.
  const json = JSON.parse(runCli(dir, ['check', '--json', '--min-net-ms', '80']).stdout);
  assert.deepEqual(json.policy, { minNetMsPerHit: 80, maxRestoreMs: 10 });
  assert.equal(json.policyFailures.length, 1);
  assert.equal(json.policyFailures[0].threshold, 'minNetMsPerHit');
  assert.equal(json.policyFailures[0].measured, 75);
  assert.equal(json.policyFailures[0].shortfall, 5);

  const noPolicy = makeProject(t);
  writeRows(noPolicy);
  const restoredTooSlow = runCli(noPolicy, ['check', '--max-restore-ms', '1']);
  assert.equal(restoredTooSlow.status, 4);
  assert.match(restoredTooSlow.stderr, /policy\.maxRestoreMs missed/);

  for (const args of [
    ['check', '--min-net-ms'],
    ['check', '--min-net-ms=-1'],
    ['check', '--max-restore-ms', 'soon'],
  ]) {
    const invalid = runCli(noPolicy, args);
    assert.equal(invalid.status, 2, `${args.join(' ')} should be a usage error`);
    assert.match(invalid.stderr, /non-negative number/);
  }
});

test('check rejects a malformed policy in .cache-verdict.json', (t) => {
  const dir = makeProject(t, { policy: { minNetMsPerHit: '50' } });
  writeRows(dir);

  const check = runCli(dir, ['check']);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /policy\.minNetMsPerHit/);
  assert.match(check.stderr, /non-negative number/);
});
