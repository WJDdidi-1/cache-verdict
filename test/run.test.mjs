import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cache-verdict.mjs');

const FAST_BUILD = `
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const warm = existsSync('cache/marker');
const wait = warm ? 5 : 220;
const start = Date.now();
while (Date.now() - start < wait) {}
mkdirSync('cache', { recursive: true });
writeFileSync('cache/marker', 'artifact');
writeFileSync('cache/payload.bin', 'x'.repeat(2048));
`;

const SLOW_WARM_BUILD = `
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const warm = existsSync('cache/marker');
const wait = warm ? 220 : 5;
const start = Date.now();
while (Date.now() - start < wait) {}
mkdirSync('cache', { recursive: true });
writeFileSync('cache/marker', 'artifact');
`;

const ROTATING_INPUT_BUILD = `
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
let step = 0;
try { step = Number(readFileSync('.counter', 'utf8')); } catch {}
const next = step % 2 === 0 ? 'B\\n' : 'A\\n';
writeFileSync('src/input.txt', next);
writeFileSync('.counter', String(step + 1));
mkdirSync('cache', { recursive: true });
writeFileSync('cache/marker', next);
`;

function makeProject(t, build, configOverrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cache-verdict-run-'));
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
  writeFileSync(path.join(dir, 'build.mjs'), build.trimStart());
  writeFileSync(path.join(dir, '.cache-verdict.json'), `${JSON.stringify(config, null, 2)}\n`);
  return dir;
}

function runCli(cwd, args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
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

function readLedgerFile(file) {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function readLedger(dir) {
  return readLedgerFile(path.join(dir, '.cache-verdict', 'ledger.jsonl'));
}

function storeKeys(dir) {
  return readdirSync(path.join(dir, '.cache-verdict', 'store')).sort();
}

test('run restores a matching content-addressed key and report says cache-pays', (t) => {
  const dir = makeProject(t, FAST_BUILD);

  const cold = runCli(dir, ['run']);
  assert.equal(cold.status, 0, cold.stderr);
  assert.match(cold.stdout, /MISS \(cold\)/);

  const warm = runCli(dir, ['run']);
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /HIT \(warm\)/);

  const ledger = readLedger(dir);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].hit, false);
  assert.equal(ledger[0].cold, true);
  assert.equal(ledger[1].hit, true);
  assert.equal(ledger[1].warm, true);
  assert.equal(ledger[1].key, ledger[0].key);
  assert.match(ledger[0].key, /^sha256:[a-f0-9]{64}$/);
  assert.ok(ledger[1].restoreSizeBytes >= 2048, 'warm run should record the restored cache size');
  assert.ok(ledger[1].sizeBytes >= 2048, 'run should record the produced cache size');
  assert.ok(ledger[1].restoreCostMs >= 0);

  const report = runCli(dir, ['report']);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /Runs: 2 \(1 hit, 1 miss\)/);
  assert.match(report.stdout, /Hit rate: 50\.0%/);
  assert.match(report.stdout, /Median cold total: \d+\.\d ms/);
  assert.match(report.stdout, /Median warm total: \d+\.\d ms/);
  assert.match(report.stdout, /Restore cost: \d+\.\d ms/);
  assert.match(report.stdout, /Net ms per hit: \d+\.\d ms/);
  assert.match(report.stdout, /Cache size: [1-9]/);
  assert.match(report.stdout, /Verdict: cache-pays/);

  const net = Number(/Net ms per hit: (\d+(?:\.\d+)?) ms/.exec(report.stdout)[1]);
  assert.ok(net > 50, `expected a clearly positive net, got ${net}`);

  const check = runCli(dir, ['check']);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Verdict: cache-pays/);

  const json = runCli(dir, ['report', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).verdict, 'cache-pays');
});

test('a warm build that is slower than cold reports cache-costs and check exits 2', (t) => {
  const dir = makeProject(t, SLOW_WARM_BUILD);

  assert.equal(runCli(dir, ['run']).status, 0);
  assert.equal(runCli(dir, ['run']).status, 0);

  const report = runCli(dir, ['report']);
  assert.match(report.stdout, /Verdict: cache-costs/);
  assert.match(report.stdout, /Net ms per hit: -\d+\.\d ms/);

  const check = runCli(dir, ['check']);
  assert.equal(check.status, 2);
  assert.match(check.stderr, /cache-costs/);
});

test('changing keys report cache-churns and a cache that never restores reports cache-never-hits', (t) => {
  const dir = makeProject(t, ROTATING_INPUT_BUILD);

  // Rotate through two keys so the keys differ between samples.
  assert.equal(runCli(dir, ['run']).status, 0);
  assert.equal(runCli(dir, ['run']).status, 0);
  assert.equal(runCli(dir, ['run']).status, 0);

  const keys = readLedger(dir).map((sample) => sample.key);
  assert.equal(new Set(keys).size, 2);
  assert.equal(readLedger(dir).filter((sample) => sample.hit).length, 1);

  // The third sample is a hit, so this case is churn rather than never-hits.
  const churn = runCli(dir, ['report']);
  assert.match(churn.stdout, /Verdict: cache-churns/);
  assert.equal(runCli(dir, ['check']).status, 2);

  const never = makeProject(t, `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
appendFileSync('src/input.txt', 'changed\\n');
mkdirSync('cache', { recursive: true });
writeFileSync('cache/marker', 'artifact');
`);
  assert.equal(runCli(never, ['run']).status, 0);
  assert.equal(runCli(never, ['run']).status, 0);
  assert.equal(readLedger(never).filter((sample) => sample.hit).length, 0);

  const report = runCli(never, ['report']);
  assert.match(report.stdout, /Verdict: cache-never-hits/);
  assert.equal(runCli(never, ['check']).status, 2);
});

test('report tells an empty cachePath apart from a populated cache that was missed', (t) => {
  const empty = makeProject(t, '// the build writes no cache artifacts\n');
  // Mirror a real project: the declared cache directory exists but stays empty.
  mkdirSync(path.join(empty, 'cache'), { recursive: true });
  assert.equal(runCli(empty, ['run']).status, 0);
  assert.equal(runCli(empty, ['run']).status, 0);

  const emptyReport = runCli(empty, ['report']);
  assert.equal(emptyReport.status, 0, emptyReport.stderr);
  assert.match(emptyReport.stdout, /Verdict: cache-never-hits/);
  assert.match(
    emptyReport.stdout,
    /Reason: cachePath is empty: no cache artifacts were found under cache/,
  );
  assert.match(emptyReport.stdout, /\.cache-verdict\.json/);
  assert.equal(JSON.parse(runCli(empty, ['report', '--json']).stdout).cacheState, 'empty');

  const emptyCheck = runCli(empty, ['check']);
  assert.equal(emptyCheck.status, 2);
  assert.match(emptyCheck.stderr, /cachePath is empty/);

  const populated = makeProject(t, `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
appendFileSync('src/input.txt', 'changed\\n');
mkdirSync('cache', { recursive: true });
writeFileSync('cache/marker', 'artifact');
`);
  assert.equal(runCli(populated, ['run']).status, 0);
  assert.equal(runCli(populated, ['run']).status, 0);

  const populatedReport = runCli(populated, ['report']);
  assert.equal(populatedReport.status, 0, populatedReport.stderr);
  assert.match(populatedReport.stdout, /Verdict: cache-never-hits/);
  assert.match(populatedReport.stdout, /Reason: the cache is populated \(/);
  assert.doesNotMatch(populatedReport.stdout, /cachePath is empty/);
  assert.equal(JSON.parse(runCli(populated, ['report', '--json']).stdout).cacheState, 'populated');
  assert.equal(runCli(populated, ['check']).status, 2);
});

test('an empty cachePath is cache-unobserved rather than a fake hit rate', (t) => {
  const dir = makeProject(t, '// no cache is produced\n', {
    command: 'node build.mjs',
    cachePath: [],
  });

  const run = runCli(dir, ['run']);
  assert.equal(run.status, 0, run.stderr);
  const sample = readLedger(dir)[0];
  assert.equal(sample.hit, false);
  assert.equal(sample.sizeBytes, 0);

  const report = runCli(dir, ['report']);
  assert.match(report.stdout, /Verdict: cache-unobserved/);
  assert.match(report.stdout, /Cache size: 0 B/);
  assert.equal(runCli(dir, ['check']).status, 2);
});

test('run --cold adds a baseline without wedging the next hit', (t) => {
  const dir = makeProject(t, FAST_BUILD);

  assert.equal(runCli(dir, ['run']).status, 0);
  const forced = runCli(dir, ['run', '--cold']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /MISS \(cold\)/);

  const third = runCli(dir, ['run']);
  assert.equal(third.status, 0, third.stderr);
  assert.match(third.stdout, /HIT \(warm\)/);

  const ledger = readLedger(dir);
  assert.equal(ledger.length, 3);
  assert.equal(ledger[1].forcedCold, true);
  assert.equal(ledger[1].hit, false);
  assert.equal(ledger[2].hit, true);
  assert.equal(ledger[2].key, ledger[0].key);

  const check = runCli(dir, ['check']);
  assert.equal(check.status, 0, check.stderr);
});

test('prune evicts least-recently-used stored keys', (t) => {
  const dir = makeProject(t, ROTATING_INPUT_BUILD);

  assert.equal(runCli(dir, ['run']).status, 0);
  assert.equal(runCli(dir, ['run']).status, 0);
  assert.equal(runCli(dir, ['run']).status, 0);

  const ledger = readLedger(dir);
  const firstKey = ledger[0].key;
  const thirdKey = ledger[2].key;
  assert.equal(thirdKey, firstKey, 'the third run should hit and refresh the first key');
  assert.equal(storeKeys(dir).length, 2);

  const prune = runCli(dir, ['prune', '--keep', '1']);
  assert.equal(prune.status, 0, prune.stderr);
  assert.deepEqual(storeKeys(dir), [firstKey.slice('sha256:'.length)]);

  assert.equal(runCli(dir, ['prune', '--keep', '0']).status, 0);
  assert.deepEqual(storeKeys(dir), []);

  const report = runCli(dir, ['report']);
  assert.match(report.stdout, /Cache size: 0 B across 0 stored keys/);
});

test('run refuses a cachePath that would move the project itself', (t) => {
  const dir = makeProject(t, FAST_BUILD, { cachePath: ['.'] });

  const result = runCli(dir, ['run']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /project root/);
  assert.equal(readFileSync(path.join(dir, 'src', 'input.txt'), 'utf8'), 'A\n');
});

test('run needs a config and check waits for a second sample', (t) => {
  const empty = mkdtempSync(path.join(tmpdir(), 'cache-verdict-empty-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));

  const missing = runCli(empty, ['run']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cache-verdict init/);

  const dir = makeProject(t, FAST_BUILD);
  assert.equal(runCli(dir, ['run']).status, 0);

  const report = runCli(dir, ['report']);
  assert.match(report.stdout, /Verdict: cache-unobserved/);
  const check = runCli(dir, ['check']);
  assert.equal(check.status, 3);
  assert.match(check.stderr, /not enough samples/);
});

test('--ledger writes, reads, and gates on a custom ledger path', (t) => {
  const dir = makeProject(t, FAST_BUILD);
  const custom = path.join(dir, 'ci-state', 'ledger.jsonl');
  const defaultLedger = path.join(dir, '.cache-verdict', 'ledger.jsonl');

  const waiting = runCli(dir, ['check', '--ledger', custom]);
  assert.equal(waiting.status, 3);
  assert.match(waiting.stderr, /not enough samples/);
  assert.match(waiting.stderr, /ci-state/);

  const cold = runCli(dir, ['run', '--ledger', custom]);
  assert.equal(cold.status, 0, cold.stderr);
  assert.match(cold.stdout, /MISS \(cold\)/);

  const warm = runCli(dir, ['run', `--ledger=${custom}`]);
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /HIT \(warm\)/);

  const ledger = readLedgerFile(custom);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].hit, false);
  assert.equal(ledger[1].hit, true);
  assert.equal(existsSync(defaultLedger), false, 'a custom ledger must not write the default ledger');

  const report = runCli(dir, ['report', '--ledger', custom]);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /Runs: 2 \(1 hit, 1 miss\)/);
  assert.match(report.stdout, /Verdict: cache-pays/);

  const json = runCli(dir, ['report', '--ledger', custom, '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).runs, 2);

  const check = runCli(dir, ['check', '--ledger', custom]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Verdict: cache-pays/);
});

test('CACHE_VERDICT_LEDGER persists samples across builds and --ledger overrides it', (t) => {
  const dir = makeProject(t, FAST_BUILD);
  const envLedger = path.join(dir, 'shared', 'ledger.jsonl');
  const flagLedger = path.join(dir, 'flag', 'ledger.jsonl');
  const env = { ...process.env, CACHE_VERDICT_LEDGER: path.join('shared', 'ledger.jsonl') };

  const first = runCli(dir, ['run'], { env });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readLedgerFile(envLedger).length, 1);

  // An explicit --ledger wins over the environment variable.
  const second = runCli(dir, ['run', '--ledger', flagLedger], { env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readLedgerFile(envLedger).length, 1);
  assert.equal(readLedgerFile(flagLedger).length, 1);

  const report = runCli(dir, ['report'], { env });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /Runs: 1 \(0 hits, 1 miss\)/);
  assert.match(report.stdout, /Verdict: cache-unobserved/);

  const check = runCli(dir, ['check'], { env });
  assert.equal(check.status, 3);
  assert.match(check.stderr, /shared[/\\]ledger\.jsonl/);
});

test('--ledger rejects a missing path and is documented by run, report, and check', (t) => {
  const dir = makeProject(t, FAST_BUILD);

  const missing = runCli(dir, ['run', '--ledger']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--ledger needs a path/);

  for (const command of ['run', 'report', 'check']) {
    const help = runCli(dir, [command, '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--ledger <path>/);
  }
});
