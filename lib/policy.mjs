/**
 * Savings policy for `cache-verdict check`.
 *
 * The policy lives in `.cache-verdict.json` and may be overridden per check by
 * `--min-net-ms` / `--max-restore-ms`. It is deliberately independent of the
 * verdict: a cache can pay for itself and still fail a team's minimum savings
 * requirement.
 */

export const POLICY_FIELDS = ['minNetMsPerHit', 'maxRestoreMs'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function policyNumber(value, field, source) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${source}: "policy.${field}" must be a non-negative number`);
  }
  return value;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function formatMs(value) {
  return `${value.toFixed(1)} ms`;
}

/**
 * Validate a policy object and fill absent thresholds with null. A null
 * threshold means "not configured"; it is not the same as a zero threshold.
 *
 * @param {unknown} value
 * @param {string} [source] where the policy came from, for error messages
 * @returns {{ minNetMsPerHit: number|null, maxRestoreMs: number|null }}
 */
export function normalizePolicy(value, source = 'policy') {
  if (value === undefined || value === null) {
    return { minNetMsPerHit: null, maxRestoreMs: null };
  }
  if (!isPlainObject(value)) {
    throw new Error(`${source}: "policy" must be an object`);
  }

  const policy = { minNetMsPerHit: null, maxRestoreMs: null };
  for (const field of POLICY_FIELDS) {
    if (value[field] === undefined || value[field] === null) continue;
    policy[field] = policyNumber(value[field], field, source);
  }
  return policy;
}

/**
 * Combine the config policy with command-line overrides. An override set on
 * the command line wins for that threshold; the other config threshold stays
 * in effect.
 *
 * @param {unknown} configPolicy
 * @param {{ minNetMsPerHit?: number|null, maxRestoreMs?: number|null }} [overrides]
 * @returns {{ minNetMsPerHit: number|null, maxRestoreMs: number|null }}
 */
export function resolvePolicy(configPolicy, overrides = {}) {
  const policy = normalizePolicy(configPolicy, 'config');
  for (const field of POLICY_FIELDS) {
    const override = overrides?.[field];
    if (override === undefined || override === null) continue;
    policy[field] = policyNumber(override, field, 'command line');
  }
  return policy;
}

export function hasPolicy(policy) {
  return (
    (policy?.minNetMsPerHit !== undefined && policy?.minNetMsPerHit !== null) ||
    (policy?.maxRestoreMs !== undefined && policy?.maxRestoreMs !== null)
  );
}

function minFailure(measured, limit) {
  const shortfall = round(limit - measured);
  return {
    threshold: 'minNetMsPerHit',
    measured: round(measured),
    limit,
    shortfall,
    message: `policy.minNetMsPerHit missed: measured ${formatMs(measured)} saved per hit, needs at least ${formatMs(limit)} (shortfall ${formatMs(shortfall)})`,
  };
}

function maxFailure(measured, limit) {
  const shortfall = round(measured - limit);
  return {
    threshold: 'maxRestoreMs',
    measured: round(measured),
    limit,
    shortfall,
    message: `policy.maxRestoreMs missed: measured ${formatMs(measured)} restore, allows at most ${formatMs(limit)} (shortfall ${formatMs(shortfall)}, over by ${formatMs(shortfall)})`,
  };
}

/**
 * Compare the measured savings and restore cost with the policy. A threshold
 * with no usable measurement is skipped rather than treated as a pass or a
 * failure; callers already require enough samples before gating.
 *
 * @param {{ netMsPerHit: number|null, restoreMs: number|null }} measurements
 * @param {{ minNetMsPerHit: number|null, maxRestoreMs: number|null }} policy
 * @returns {Array<{ threshold: string, measured: number, limit: number, shortfall: number, message: string }>}
 */
export function evaluatePolicy(measurements, policy) {
  const normalized = normalizePolicy(policy, 'policy');
  const failures = [];

  if (normalized.minNetMsPerHit !== null) {
    const measured = measurements.netMsPerHit;
    if (typeof measured === 'number' && Number.isFinite(measured) && measured < normalized.minNetMsPerHit) {
      failures.push(minFailure(measured, normalized.minNetMsPerHit));
    }
  }

  if (normalized.maxRestoreMs !== null) {
    const measured = measurements.restoreMs;
    if (typeof measured === 'number' && Number.isFinite(measured) && measured > normalized.maxRestoreMs) {
      failures.push(maxFailure(measured, normalized.maxRestoreMs));
    }
  }

  return failures;
}

/**
 * Human-readable one-line description for the report, or null when no
 * threshold is configured.
 */
export function describePolicy(policy) {
  const normalized = normalizePolicy(policy, 'policy');
  const parts = [];
  if (normalized.minNetMsPerHit !== null) {
    parts.push(`min net ${formatMs(normalized.minNetMsPerHit)} per hit`);
  }
  if (normalized.maxRestoreMs !== null) {
    parts.push(`max restore ${formatMs(normalized.maxRestoreMs)}`);
  }
  return parts.length === 0 ? null : parts.join(', ');
}
