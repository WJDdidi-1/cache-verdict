import { CONFIG_FILENAME } from './config.mjs';

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
  };
}

function round(value) {
  return value === null ? null : Math.round(value * 1000) / 1000;
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
        reason = `the cache is populated (${evidence}) but no run restored it; compare the keys in .cache-verdict/ledger.jsonl and edit "inputs" in ${CONFIG_FILENAME} if the key changes between runs`;
      }
    }
  } else if (cold.length === 0) {
    verdict = 'cache-unobserved';
    moreRunsNeeded = true;
    reason = 'no cold baseline has been recorded; add one with "cache-verdict run --cold"';
  } else if (keys.size > 1) {
    verdict = 'cache-churns';
    reason = `${keys.size} distinct keys across ${observations.length} samples; the cache key changes too often to accumulate hits`;
  } else if (netMsPerHit !== null && netMsPerHit > 0) {
    verdict = 'cache-pays';
    reason = `warm builds are ${netMsPerHit.toFixed(1)} ms faster per hit after paying the restore cost`;
  } else {
    verdict = 'cache-costs';
    reason = `a warm build is not faster than cold (${netMsPerHit?.toFixed(1) ?? 'unknown'} ms per hit)`;
  }

  return {
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
    verdict,
    moreRunsNeeded,
    reason,
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

export function formatReport(analysis) {
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
    `Verdict: ${analysis.verdict}`,
  ];
  if (analysis.reason) lines.push(`Reason: ${analysis.reason}`);
  return `${lines.join('\n')}\n`;
}
