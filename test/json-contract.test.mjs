import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'cache-verdict.mjs');

const SCHEMA_VERSION = 1;

// The public contract for schemaVersion 1. Keep these lists in sync with the
// "JSON output contract" section of README.md; the last test in this file
// fails when a documented key disappears from either side.
const ANALYSIS_KEYS = [
  'schemaVersion',
  'runs',
  'hits',
  'misses',
  'hitRate',
  'coldRuns',
  'warmRuns',
  'uniqueKeys',
  'medianColdMs',
  'medianWarmMs',
  'restoreMs',
  'netMsPerHit',
  'storedKeys',
  'cacheSizeBytes',
  'cachePaths',
  'cacheState',
  'inputChanges',
  'history',
  'regressedAt',
  'verdict',
  'moreRunsNeeded',
  'reason',
  'policy',
  'policyFailures',
];

const RUN_KEYS = [
  'schemaVersion',
  'timestamp',
  'key',
  'hit',
  'miss',
  'cold',
  'warm',
  'temperature',
  'forcedCold',
  'buildMs',
  'restoreMs',
  'restoreCostMs',
  'totalMs',
  'sizeBytes',
  'cacheSizeBytes',
  'restoreSizeBytes',
  'stored',
  'command',
  'inputs',
  'inputCount',
  'inputsTruncated',
];

const PRUNE_KEYS = ['schemaVersion', 'kept', 'evicted'];
const HISTORY_KEYS = ['index', 'timestamp', 'hit', 'totalMs', 'netMs'];
const INPUT_CHANGES_KEYS = ['available', 'reason', 'paths', 'changes', 'truncated'];
const INPUT_CHANGES_AVAILABLE_KEYS = [
  'previousKey',
  'currentKey',
  'previousTimestamp',
  'currentTimestamp',
];
const INPUT_CHANGE_KEYS = ['path', 'change', 'before', 'after'];
const POLICY_KEYS = ['minNetMsPerHit', 'maxRestoreMs'];
const POLICY_FAILURE_KEYS = ['threshold', 'measured', 'limit', 'shortfall', 'message'];
const INPUT_KEYS = ['path', 'sha256'];

const ALL_DOCUMENTED_KEYS = [
  ...new Set([
    ...ANALYSIS_KEYS,
    ...RUN_KEYS,
    ...PRUNE_KEYS,
    ...HISTORY_KEYS,
    ...INPUT_CHANGES_KEYS,
    ...INPUT_CHANGES_AVAILABLE_KEYS,
    ...INPUT_CHANGE_KEYS,
    ...POLICY_KEYS,
    ...POLICY_FAILURE_KEYS,
    ...INPUT_KEYS,
  ]),
];

const KEY_A = `sha256:${'a'.repeat(64)}`;
const KEY_B = `sha256:${'b'.repeat(64)}`;
const KEY_C = `sha256:${'c'.repeat(64)}`;

const BUILD_SCRIPT = `
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('cache', { recursive: true });
writeFileSync('cache/artifact.txt', 'artifact');
`;

function writeConfig(dir, policy = null) {
  const config = {
    schemaVersion: 1,
    ecosystem: 'npm',
    displayName: 'json-contract-test',
    command: 'node build.mjs',
    inputs: ['src/**', 'build.mjs'],
    cachePath: ['cache'],
    detectedFrom: ['package.json'],
  };
  if (policy !== null) config.policy = policy;
  writeFileSync(path.join(dir, '.cache-verdict.json'), `${JSON.stringify(config, null, 2)}\n`);
}

function makeProject(t, policy = null) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cache-verdict-json-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'input.txt'), 'A\n');
  writeFileSync(path.join(dir, 'build.mjs'), BUILD_SCRIPT.trimStart());
  writeConfig(dir, policy);
  return dir;
}

function sample(index, { hit, totalMs, restoreMs = 0, key, inputHash }) {
  return {
    schemaVersion: 1,
    timestamp: `2026-01-01T00:0${index}:00.000Z`,
    key,
    hit,
    miss: !hit,
    cold: !hit,
    warm: hit,
    temperature: hit ? 'warm' : 'cold',
    forcedCold: false,
    buildMs: totalMs - restoreMs,
    restoreMs,
    restoreCostMs: restoreMs,
    totalMs,
    sizeBytes: 4096,
    cacheSizeBytes: 4096,
    restoreSizeBytes: hit ? 4096 : 0,
    stored: true,
    command: 'node build.mjs',
    inputs: [{ path: 'src/input.txt', sha256: inputHash }],
    inputCount: 1,
    inputsTruncated: false,
  };
}

function makeLedgerProject(t, rows, policy = null) {
  const dir = makeProject(t, policy);
  mkdirSync(path.join(dir, '.cache-verdict'), { recursive: true });
  writeFileSync(
    path.join(dir, '.cache-verdict', 'ledger.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
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

function parseJson(result, label) {
  assert.notEqual(
    result.stdout.trim(),
    '',
    `${label}: expected JSON on stdout, got empty output${result.stderr ? `; stderr: ${result.stderr}` : ''}`,
  );
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(`${label}: stdout is not valid JSON (${error.message})`);
  }
}

function assertPlainObject(value, label) {
  assert.equal(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    true,
    `${label} must be a JSON object`,
  );
}

function assertKeys(value, keys, label) {
  assertPlainObject(value, label);
  for (const key of keys) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(value, key),
      `${label} is missing required JSON key "${key}"`,
    );
  }
}

function assertSchemaVersion(payload, label) {
  assert.equal(
    payload.schemaVersion,
    SCHEMA_VERSION,
    `${label}: schemaVersion must be ${SCHEMA_VERSION}`,
  );
}

function assertHistory(history, label) {
  assert.ok(Array.isArray(history), `${label}.history must be an array`);
  for (const [index, entry] of history.entries()) {
    assertKeys(entry, HISTORY_KEYS, `${label}.history[${index}]`);
    assert.equal(typeof entry.index, 'number', `${label}.history[${index}].index must be a number`);
    assert.equal(typeof entry.hit, 'boolean', `${label}.history[${index}].hit must be a boolean`);
  }
}

function assertInputChanges(inputChanges, label) {
  assertKeys(inputChanges, INPUT_CHANGES_KEYS, label);
  assert.ok(Array.isArray(inputChanges.paths), `${label}.paths must be an array`);
  assert.ok(Array.isArray(inputChanges.changes), `${label}.changes must be an array`);
  assert.equal(
    typeof inputChanges.truncated,
    'boolean',
    `${label}.truncated must be a boolean`,
  );
  assert.ok(
    inputChanges.reason === null || typeof inputChanges.reason === 'string',
    `${label}.reason must be a string or null`,
  );

  if (inputChanges.available === true) {
    assertKeys(inputChanges, INPUT_CHANGES_AVAILABLE_KEYS, label);
  } else {
    assert.equal(inputChanges.available, false, `${label}.available must be a boolean`);
  }

  for (const [index, change] of inputChanges.changes.entries()) {
    assertKeys(change, INPUT_CHANGE_KEYS, `${label}.changes[${index}]`);
    assert.equal(
      typeof change.path,
      'string',
      `${label}.changes[${index}].path must be a string`,
    );
    assert.ok(
      ['added', 'removed', 'modified'].includes(change.change),
      `${label}.changes[${index}].change must be added, removed, or modified`,
    );
  }
}

function assertPolicy(policy, label) {
  assertKeys(policy, POLICY_KEYS, label);
  for (const key of POLICY_KEYS) {
    assert.ok(
      policy[key] === null || typeof policy[key] === 'number',
      `${label}.${key} must be a number or null`,
    );
  }
}

function assertAnalysisContract(payload, label) {
  assertKeys(payload, ANALYSIS_KEYS, label);
  assertSchemaVersion(payload, label);

  for (const key of ['verdict', 'cacheState', 'reason']) {
    assert.equal(typeof payload[key], 'string', `${label}.${key} must be a string`);
  }
  assert.equal(typeof payload.moreRunsNeeded, 'boolean', `${label}.moreRunsNeeded must be a boolean`);
  assert.ok(Array.isArray(payload.cachePaths), `${label}.cachePaths must be an array`);
  assert.ok(
    payload.regressedAt === null || Number.isInteger(payload.regressedAt),
    `${label}.regressedAt must be an integer or null`,
  );

  assertHistory(payload.history, label);
  assertInputChanges(payload.inputChanges, `${label}.inputChanges`);
  assertPolicy(payload.policy, `${label}.policy`);

  assert.ok(Array.isArray(payload.policyFailures), `${label}.policyFailures must be an array`);
  for (const [index, failure] of payload.policyFailures.entries()) {
    assertKeys(failure, POLICY_FAILURE_KEYS, `${label}.policyFailures[${index}]`);
    assert.equal(
      typeof failure.message,
      'string',
      `${label}.policyFailures[${index}].message must be a string`,
    );
  }
}

function assertRunContract(payload, label) {
  assertKeys(payload, RUN_KEYS, label);
  assertSchemaVersion(payload, label);

  assert.equal(typeof payload.timestamp, 'string', `${label}.timestamp must be a string`);
  assert.match(payload.key, /^sha256:[a-f0-9]{64}$/, `${label}.key must be a content hash`);
  for (const key of ['hit', 'miss', 'cold', 'warm', 'forcedCold', 'stored', 'inputsTruncated']) {
    assert.equal(typeof payload[key], 'boolean', `${label}.${key} must be a boolean`);
  }
  assert.equal(typeof payload.command, 'string', `${label}.command must be a string`);
  assert.equal(typeof payload.inputCount, 'number', `${label}.inputCount must be a number`);
  assert.ok(Array.isArray(payload.inputs), `${label}.inputs must be an array`);
  for (const [index, input] of payload.inputs.entries()) {
    assertKeys(input, INPUT_KEYS, `${label}.inputs[${index}]`);
  }
}

function assertPruneContract(payload, label) {
  assertKeys(payload, PRUNE_KEYS, label);
  assertSchemaVersion(payload, label);

  for (const key of ['kept', 'evicted']) {
    assert.ok(Array.isArray(payload[key]), `${label}.${key} must be an array`);
    for (const value of payload[key]) {
      assert.equal(typeof value, 'string', `${label}.${key} entries must be strings`);
    }
  }
}

test('report --json and check --json expose the schemaVersion 1 contract', (t) => {
  const dir = makeLedgerProject(
    t,
    [
      sample(1, {
        hit: false,
        totalMs: 200,
        key: KEY_A,
        inputHash: 'a'.repeat(64),
      }),
      sample(2, {
        hit: true,
        totalMs: 50,
        restoreMs: 5,
        key: KEY_B,
        inputHash: 'b'.repeat(64),
      }),
      sample(3, {
        hit: false,
        totalMs: 190,
        key: KEY_C,
        inputHash: 'c'.repeat(64),
      }),
    ],
    { minNetMsPerHit: 500 },
  );

  const report = runCli(dir, ['report', '--json']);
  assert.equal(report.status, 0, report.stderr);
  const reportJson = parseJson(report, 'report --json');
  assertAnalysisContract(reportJson, 'report --json');
  assert.equal(reportJson.regressedAt, 2, 'regressedAt should point at the last hit');
  assert.equal(reportJson.history.length, 3);
  assert.equal(reportJson.inputChanges.available, true);
  assert.ok(
    reportJson.inputChanges.changes.length > 0,
    'the changed-input contract needs a change in the fixture',
  );

  const check = runCli(dir, ['check', '--json']);
  assert.equal(check.status, 4, check.stderr);
  const checkJson = parseJson(check, 'check --json');
  assertAnalysisContract(checkJson, 'check --json');
  assert.ok(
    checkJson.policyFailures.length > 0,
    'the policy-failure contract needs a failure in the fixture',
  );
});

test('run --json exposes the schemaVersion 1 contract', (t) => {
  const dir = makeProject(t);

  const run = runCli(dir, ['run', '--json']);
  assert.equal(run.status, 0, run.stderr);
  assertRunContract(parseJson(run, 'run --json'), 'run --json');
});

test('prune --json exposes the schemaVersion 1 contract', (t) => {
  const dir = makeProject(t);

  const run = runCli(dir, ['run', '--json']);
  assert.equal(run.status, 0, run.stderr);

  const prune = runCli(dir, ['prune', '--keep', '0', '--json']);
  assert.equal(prune.status, 0, prune.stderr);
  const pruned = parseJson(prune, 'prune --json');
  assertPruneContract(pruned, 'prune --json');
  assert.equal(pruned.kept.length, 0);
  assert.equal(pruned.evicted.length, 1);
});

test('README documents every required JSON contract key', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const start = readme.indexOf('### JSON output contract');
  assert.notEqual(start, -1, 'README is missing the "JSON output contract" section');
  const end = readme.indexOf('\n## ', start);
  const section = readme.slice(start, end === -1 ? undefined : end);

  for (const key of ALL_DOCUMENTED_KEYS) {
    assert.ok(
      section.includes(`\`${key}\``),
      `README JSON output contract does not document required key "${key}"`,
    );
  }
});
