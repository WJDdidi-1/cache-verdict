import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeSamples } from '../lib/report.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cache-verdict.mjs');
const KEY = `sha256:${'a'.repeat(64)}`;

function sample(index, { hit, totalMs, restoreMs = 0, timestamp }) {
  return {
    schemaVersion: 1,
    timestamp: timestamp ?? `2026-01-01T00:0${index}:00.000Z`,
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

function analyze(samples) {
  return analyzeSamples(samples, {
    hasCachePaths: true,
    cachePaths: ['cache'],
    storedKeys: 1,
    storedSizeBytes: 2048,
  });
}

function makeProject(t, samples) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cache-verdict-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(
    path.join(dir, '.cache-verdict.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        ecosystem: 'npm',
        displayName: 'history-test',
        command: 'node build.mjs',
        inputs: ['src/**'],
        cachePath: ['cache'],
        detectedFrom: ['package.json'],
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(path.join(dir, '.cache-verdict'), { recursive: true });
  writeFileSync(
    path.join(dir, '.cache-verdict', 'ledger.jsonl'),
    `${samples.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
  return dir;
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

test('history rows and regressedAt identify a cache that hit and then stopped', () => {
  const analysis = analyze([
    sample(1, { hit: false, totalMs: 200 }),
    sample(2, { hit: true, totalMs: 50, restoreMs: 5 }),
    sample(3, { hit: true, totalMs: 60, restoreMs: 6 }),
    sample(4, { hit: false, totalMs: 190 }),
    sample(5, { hit: false, totalMs: 210 }),
  ]);

  assert.deepEqual(
    analysis.history.map((entry) => entry.index),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    analysis.history.map((entry) => entry.hit),
    [false, true, true, false, false],
  );
  assert.deepEqual(
    analysis.history.map((entry) => entry.timestamp),
    [
      '2026-01-01T00:01:00.000Z',
      '2026-01-01T00:02:00.000Z',
      '2026-01-01T00:03:00.000Z',
      '2026-01-01T00:04:00.000Z',
      '2026-01-01T00:05:00.000Z',
    ],
  );
  assert.deepEqual(
    analysis.history.map((entry) => entry.totalMs),
    [200, 50, 60, 190, 210],
  );
  // Net ms is the median cold total (200 ms) minus each sample's total.
  assert.deepEqual(
    analysis.history.map((entry) => entry.netMs),
    [0, 150, 140, 10, -10],
  );
  assert.equal(analysis.regressedAt, 3);
});

test('an all-miss ledger has no regression point', () => {
  const analysis = analyze([
    sample(1, { hit: false, totalMs: 200 }),
    sample(2, { hit: false, totalMs: 210 }),
    sample(3, { hit: false, totalMs: 190 }),
  ]);

  assert.equal(analysis.regressedAt, null);
  assert.deepEqual(
    analysis.history.map((entry) => entry.hit),
    [false, false, false],
  );
  assert.deepEqual(
    analysis.history.map((entry) => entry.netMs),
    [0, -10, 10],
  );
});

test('an all-hit ledger has no regression point and no cold baseline to net against', () => {
  const analysis = analyze([
    sample(1, { hit: true, totalMs: 50, restoreMs: 5 }),
    sample(2, { hit: true, totalMs: 60, restoreMs: 6 }),
    sample(3, { hit: true, totalMs: 55, restoreMs: 4 }),
  ]);

  assert.equal(analysis.regressedAt, null);
  assert.deepEqual(
    analysis.history.map((entry) => entry.hit),
    [true, true, true],
  );
  assert.deepEqual(
    analysis.history.map((entry) => entry.netMs),
    [null, null, null],
  );
});

test('a recovered cache has no regression point', () => {
  const analysis = analyze([
    sample(1, { hit: false, totalMs: 200 }),
    sample(2, { hit: true, totalMs: 50, restoreMs: 5 }),
    sample(3, { hit: true, totalMs: 60, restoreMs: 6 }),
  ]);

  assert.equal(analysis.regressedAt, null);
});

test('report --json includes the history array and regressedAt', (t) => {
  const dir = makeProject(t, [
    sample(1, { hit: false, totalMs: 200 }),
    sample(2, { hit: true, totalMs: 50, restoreMs: 5 }),
    sample(3, { hit: false, totalMs: 190 }),
  ]);

  const result = runCli(dir, ['report', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);

  assert.equal(json.regressedAt, 2);
  assert.equal(json.history.length, 3);
  assert.deepEqual(Object.keys(json.history[0]).sort(), [
    'hit',
    'index',
    'netMs',
    'timestamp',
    'totalMs',
  ]);
  assert.deepEqual(json.history[1], {
    index: 2,
    timestamp: '2026-01-01T00:02:00.000Z',
    hit: true,
    totalMs: 50,
    netMs: 145,
  });
});

test('report --history prints a row per sample and the regression point', (t) => {
  const dir = makeProject(t, [
    sample(1, { hit: false, totalMs: 200 }),
    sample(2, { hit: true, totalMs: 50, restoreMs: 5 }),
    sample(3, { hit: false, totalMs: 190 }),
  ]);

  const plain = runCli(dir, ['report']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /History:/);
  assert.doesNotMatch(plain.stdout, /Regression:/);

  const history = runCli(dir, ['report', '--history']);
  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /History:/);
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

  const help = runCli(dir, ['report', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--history/);
});
