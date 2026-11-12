import { CONFIG_FILENAME } from './config.mjs';
import { describePolicy, evaluatePolicy, normalizePolicy } from './policy.mjs';

/**
 * Version of the machine-readable payloads printed by `--json`: the analysis
 * from `report`/`check`, the sample from `run`, and the result from `prune`.
 * Bump this only when an existing field is removed, renamed, or changes
 * meaning; adding a field is backwards compatible.
 */
export const SCHEMA_VERSION = 1;

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

const MAX_REPORTED_INPUT_CHANGES = 20;
const MAX_REASON_INPUT_CHANGES = 5;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Samples written before input hashes were recorded have no `inputs` field.
 * Treat anything that is not a well-formed path/hash list as unavailable
 * rather than failing the whole report.
 */
function normalizeInputs(value) {
  if (!Array.isArray(value)) return null;
  const inputs = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    if (typeof item.path !== 'string' || item.path === '') return null;
    if (typeof item.sha256 !== 'string' || item.sha256 === '') return null;
    inputs.push({ path: item.path, sha256: item.sha256 });
  }
  return inputs;
}

function sampleTiming(sample) {
  const buildMs = finite(sample.buildMs);
  const restoreMs = finite(sample.restoreMs);
  const totalMs = finite(sample.totalMs) ?? (buildMs !== null && restoreMs !== null ? buildMs + restoreMs : null);
  return {
    buildMs,
    restoreMs,
    totalMs,
    hit: sample.hit === true || sample.temperature === 'warm',
    key: typeof sample.key === 'string' ? sample.key : 'unknown',
    sizeBytes: finite(sample.sizeBytes),
    restoreSizeBytes: finite(sample.restoreSizeBytes),
    timestamp: typeof sample.timestamp === 'string' ? sample.timestamp : null,
    inputs: normalizeInputs(sample.inputs),
    inputsTruncated: sample.inputsTruncated === true,
  };
}

/**
 * Compare the recorded inputs of the last two samples. Paths present in only
 * one side are added/removed; a different hash means the contents changed.
 *
 * @param {Array<{ path: string, sha256: string }>} previous
 * @param {Array<{ path: string, sha256: string }>} current
 * @returns {Array<{ path: string, change: 'added'|'removed'|'modified', before: string|null, after: string|null }>}
 */
export function diffInputFiles(previous, current) {
  const before = new Map(previous.map((input) => [input.path, input.sha256]));
  const after = new Map(current.map((input) => [input.path, input.sha256]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = [];

  for (const inputPath of paths) {
    const beforeHash = before.get(inputPath);
    const afterHash = after.get(inputPath);
    if (beforeHash === afterHash) continue;
    changes.push({
      path: inputPath,
      change:
        beforeHash === undefined ? 'added' : afterHash === undefined ? 'removed' : 'modified',
      before: beforeHash ?? null,
      after: afterHash ?? null,
    });
  }

  return changes;
}

function compareLatestInputs(observations) {
  if (observations.length < 2) {
    return {
      available: false,
      reason:
        observations.length === 0
          ? 'no samples have been recorded'
          : 'only one sample has been recorded',
      paths: [],
      changes: [],
      truncated: false,
    };
  }

  const previous = observations[observations.length - 2];
  const current = observations[observations.length - 1];

  if (previous.inputs === null || current.inputs === null) {
    return {
      available: false,
      reason: 'the last two samples do not both record input hashes (they predate input recording)',
      paths: [],
      changes: [],
      truncated: false,
      previousKey: previous.key,
      currentKey: current.key,
    };
  }

  const changes = diffInputFiles(previous.inputs, current.inputs);
  return {
    available: true,
    reason: null,
    previousKey: previous.key,
    currentKey: current.key,
    previousTimestamp: previous.timestamp,
    currentTimestamp: current.timestamp,
    paths: changes.map((change) => change.path),
    changes,
    truncated: previous.inputsTruncated || current.inputsTruncated,
  };
}

function summarizeChanges(changes, limit) {
  const shown = changes.slice(0, limit);
  const parts = shown.map((change) => `${change.path} (${change.change})`);
  const remaining = changes.length - shown.length;
  return `${parts.join(', ')}${remaining > 0 ? `, and ${remaining} more` : ''}`;
}

function latestInputChangeSuffix(inputChanges) {
  if (!inputChanges.available) return '';
  if (inputChanges.changes.length === 0) {
    return inputChanges.truncated
      ? '; no recorded input changed between the last two samples, but the recorded input list is truncated, so inspect the config for a change outside it'
      : '; the recorded inputs are unchanged between the last two samples, so inspect the command or config instead';
  }
  const truncation = inputChanges.truncated ? ' (recorded list truncated)' : '';
  return `; the last two samples changed ${summarizeChanges(inputChanges.changes, MAX_REASON_INPUT_CHANGES)}${truncation}`;
}

function round(value) {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

/**
 * One row per ledger sample, in ledger order. `netMs` uses the same baseline
 * as the report's "Net ms per hit": positive means the sample was faster than
 * the median cold build, negative means it was slower. Without a cold sample
 * there is no baseline, so both timings and net savings are unavailable.
 */
function sampleHistory(samples, medianColdMs) {
  return samples.map((sample, position) => {
    const timing = sampleTiming(sample);
    return {
      index: position + 1,
      timestamp: timing.timestamp,
      hit: timing.hit,
      totalMs: round(timing.totalMs),
      netMs:
        timing.totalMs === null || medianColdMs === null
          ? null
          : round(medianColdMs - timing.totalMs),
    };
  });
}

/**
 * The regression point is the last hit before the history ends in misses.
 * A ledger that never hit (all misses), never missed (all hits), or recovered
 * with a later hit has no regression to report.
 */
function regressionPoint(history) {
  let lastHit = null;
  for (const entry of history) {
    if (entry.hit) lastHit = entry.index;
  }
  if (lastHit === null || lastHit === history.length) return null;
  return lastHit;
}

/**
 * Turn ledger samples into the numbers and single verdict the report prints.
 *
 * `cacheState` separates two cases that both end in cache-never-hits: the
 * build never produced anything under cachePath ("empty"), and a cache was
 * written but no sample restored it ("populated"). The verdict and exit code
 * stay the same; only the explanation and next step differ.
 *
 * @param {Array<object>} samples samples read from the JSONL ledger
 * @param {{ hasCachePaths?: boolean, cachePaths?: string[], storedKeys?: number, storedSizeBytes?: number }} [context]
 */
export function analyzeSamples(samples, context = {}) {
  const hasCachePaths = context.hasCachePaths !== false;
  const cachePaths = Array.isArray(context.cachePaths)
    ? context.cachePaths.filter((value) => typeof value === 'string' && value.trim() !== '')
    : [];
  const observations = samples.map(sampleTiming).filter((sample) => sample.totalMs !== null);
  const inputChanges = compareLatestInputs(observations);

  const cold = observations.filter((sample) => !sample.hit);
  const warm = observations.filter((sample) => sample.hit);
  const keys = new Set(observations.map((sample) => sample.key));

  const coldTotals = cold.map((sample) => sample.totalMs);
  const warmTotals = warm.map((sample) => sample.totalMs);
  const restoreCosts = warm
    .map((sample) => sample.restoreMs)
    .filter((value) => value !== null);

  const medianColdMs = median(coldTotals);
  const medianWarmMs = median(warmTotals);
  const restoreMs = median(restoreCosts);
  const netMsPerHit =
    medianColdMs !== null && medianWarmMs !== null ? medianColdMs - medianWarmMs : null;

  const history = sampleHistory(samples, medianColdMs);
  const regressedAt = regressionPoint(history);

  const storedKeys = context.storedKeys ?? 0;
  const storedSizeBytes = context.storedSizeBytes ?? 0;
  const observedCacheBytes = observations.reduce(
    (maximum, sample) => Math.max(maximum, sample.sizeBytes ?? 0, sample.restoreSizeBytes ?? 0),
    0,
  );
  const hasCacheEvidence = observedCacheBytes > 0 || storedSizeBytes > 0 || storedKeys > 0;
  const cacheState = !hasCachePaths
    ? 'none'
    : observations.length === 0
      ? 'unknown'
      : hasCacheEvidence
        ? 'populated'
        : 'empty';
  const cachePathLabel = cachePaths.length > 0 ? cachePaths.join(', ') : 'the declared cachePath';

  let verdict;
  let moreRunsNeeded = false;
  let reason;

  if (!hasCachePaths) {
    verdict = 'cache-unobserved';
    reason = 'cachePath is empty, so there is nothing to measure';
  } else if (observations.length === 0) {
    verdict = 'cache-unobserved';
    moreRunsNeeded = true;
    reason = 'no samples have been recorded yet; run the build once';
  } else if (warm.length === 0) {
    if (observations.length < 2) {
      verdict = 'cache-unobserved';
      moreRunsNeeded = true;
      reason = 'one cold sample is not enough; run again to collect a warm sample';
    } else {
      verdict = 'cache-never-hits';
      if (cacheState === 'empty') {
        const runs = `${observations.length} ${observations.length === 1 ? 'run' : 'runs'}`;
        reason = `cachePath is empty: no cache artifacts were found under ${cachePathLabel} in any of the ${runs}; check that the build writes to this path or edit "cachePath" in ${CONFIG_FILENAME}`;
      } else {
        const storedLabel = `${storedKeys} stored cache key${storedKeys === 1 ? '' : 's'}`;
        const evidence =
          observedCacheBytes > 0
            ? `${formatBytes(observedCacheBytes)} of cache artifacts were written`
            : `${storedLabel} ${storedKeys === 1 ? 'exists' : 'exist'}`;
        if (!inputChanges.available) {
          reason = `the cache is populated (${evidence}) but no run restored it; these samples predate input recording, so run again with this version to see whether an input changed`;
        } else if (inputChanges.changes.length > 0) {
          reason = `the cache is populated (${evidence}) but no run restored it; the key changed with ${summarizeChanges(inputChanges.changes, MAX_REASON_INPUT_CHANGES)}, so the build stored a new key instead of restoring the previous one`;
        } else {
          reason = `the cache is populated (${evidence}) but no run restored it, and the recorded inputs did not change; inspect how the build restores ${cachePathLabel}`;
        }
      }
    }
  } else if (cold.length === 0) {
    verdict = 'cache-unobserved';
    moreRunsNeeded = true;
    reason = 'no cold baseline has been recorded; add one with "cache-verdict run --cold"';
  } else if (keys.size > 1) {
    verdict = 'cache-churns';
    reason = `${keys.size} distinct keys across ${observations.length} samples; the cache key changes too often to accumulate hits${latestInputChangeSuffix(inputChanges)}`;
  } else if (netMsPerHit !== null && netMsPerHit > 0) {
    verdict = 'cache-pays';
    reason = `warm builds are ${netMsPerHit.toFixed(1)} ms faster per hit after paying the restore cost`;
  } else {
    verdict = 'cache-costs';
    reason = `a warm build is not faster than cold (${netMsPerHit?.toFixed(1) ?? 'unknown'} ms per hit)`;
  }

  const policy = normalizePolicy(context.policy, 'policy');
  const policyFailures = moreRunsNeeded
    ? []
    : evaluatePolicy({ netMsPerHit: round(netMsPerHit), restoreMs: round(restoreMs) }, policy);

  return {
    schemaVersion: SCHEMA_VERSION,
    runs: observations.length,
    hits: warm.length,
    misses: cold.length,
    hitRate: observations.length === 0 ? null : warm.length / observations.length,
    coldRuns: cold.length,
    warmRuns: warm.length,
    uniqueKeys: keys.size,
    medianColdMs: round(medianColdMs),
    medianWarmMs: round(medianWarmMs),
    restoreMs: round(restoreMs),
    netMsPerHit: round(netMsPerHit),
    storedKeys,
    cacheSizeBytes: storedSizeBytes,
    cachePaths,
    cacheState,
    inputChanges,
    history,
    regressedAt,
    verdict,
    moreRunsNeeded,
    reason,
    policy,
    policyFailures,
  };
}

function formatMs(value) {
  return value === null || value === undefined ? 'n/a' : `${value.toFixed(1)} ms`;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value;
  let unit = -1;
  do {
    scaled /= 1024;
    unit += 1;
  } while (scaled >= 1024 && unit < units.length - 1);
  return `${scaled.toFixed(1)} ${units[unit]}`;
}

function formatInputChangesLine(inputChanges) {
  if (!inputChanges) return null;
  if (!inputChanges.available) {
    return `Changed inputs since previous sample: unavailable (${inputChanges.reason})`;
  }
  if (inputChanges.changes.length === 0) {
    return inputChanges.truncated
      ? 'Changed inputs since previous sample: none among the recorded inputs [recorded input list truncated]'
      : 'Changed inputs since previous sample: none';
  }
  const truncation = inputChanges.truncated ? ' [recorded input list truncated]' : '';
  return `Changed inputs since previous sample: ${summarizeChanges(inputChanges.changes, MAX_REPORTED_INPUT_CHANGES)}${truncation}`;
}

function formatHistory(history) {
  const lines = [
    'History:',
    `  #  ${'Timestamp'.padEnd(24)}  ${'Result'.padEnd(6)}  ${'Total'.padStart(9)}  ${'Net'.padStart(9)}`,
  ];
  for (const entry of history) {
    const timestamp = (entry.timestamp ?? 'n/a').padEnd(24);
    const result = (entry.hit ? 'HIT' : 'MISS').padEnd(6);
    lines.push(
      `  ${String(entry.index).padStart(2)}  ${timestamp}  ${result}  ${formatMs(entry.totalMs).padStart(9)}  ${formatMs(entry.netMs).padStart(9)}`,
    );
  }
  return lines;
}

function formatRegression(analysis) {
  if (Number.isInteger(analysis.regressedAt)) {
    return `Regression: sample ${analysis.regressedAt} was the last hit; no sample has hit since.`;
  }
  if (analysis.hits === 0) return 'Regression: none (no sample has hit).';
  if (analysis.misses === 0) return 'Regression: none (no sample has missed).';
  return 'Regression: none (no run of misses ends the history).';
}

export function formatReport(analysis, options = {}) {
  const hitRate =
    analysis.hitRate === null ? 'n/a' : `${(analysis.hitRate * 100).toFixed(1)}%`;
  const storedKeys = analysis.storedKeys === 1 ? 'stored key' : 'stored keys';
  const lines = [
    `Runs: ${analysis.runs} (${analysis.hits} hit${analysis.hits === 1 ? '' : 's'}, ${analysis.misses} miss${analysis.misses === 1 ? '' : 'es'})`,
    `Hit rate: ${hitRate}`,
    `Median cold total: ${formatMs(analysis.medianColdMs)}`,
    `Median warm total: ${formatMs(analysis.medianWarmMs)}`,
    `Restore cost: ${formatMs(analysis.restoreMs)}`,
    `Net ms per hit: ${formatMs(analysis.netMsPerHit)}`,
    `Cache size: ${formatBytes(analysis.cacheSizeBytes)} across ${analysis.storedKeys} ${storedKeys}`,
  ];
  const changedInputs = formatInputChangesLine(analysis.inputChanges);
  if (changedInputs) lines.push(changedInputs);
  const policy = describePolicy(analysis.policy);
  if (policy) lines.push(`Policy: ${policy}`);
  for (const failure of analysis.policyFailures ?? []) {
    lines.push(`Policy failure: ${failure.message}`);
  }
  lines.push(`Verdict: ${analysis.verdict}`);
  if (analysis.reason) lines.push(`Reason: ${analysis.reason}`);
  if (options.history === true) {
    lines.push('', ...formatHistory(analysis.history ?? []), formatRegression(analysis));
  }
  return `${lines.join('\n')}\n`;
}
