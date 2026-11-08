import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { loadConfig } from './config.mjs';
import { resolvePathPatterns } from './glob.mjs';
import { computeInputKey } from './key.mjs';
import {
  appendLedgerSample,
  ensureWorkDirectory,
  ledgerPath,
  movePath,
  pathExists,
  pathSize,
  readStoredCache,
  removePath,
  restoreStoredCache,
  storeCache,
  storeKeyDirectory,
  tempDirectory,
  touchStoredCache,
  workDirectory,
} from './ledger.mjs';

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function assertSafeTarget(root, target) {
  const project = path.resolve(root);
  const resolved = path.resolve(target);
  const internal = path.resolve(workDirectory(project));

  if (resolved === project) {
    throw new Error('cachePath must not point at the project root');
  }
  const projectInsideTarget = path.relative(resolved, project);
  if (
    projectInsideTarget !== '' &&
    !projectInsideTarget.startsWith('..') &&
    !path.isAbsolute(projectInsideTarget)
  ) {
    throw new Error(`cachePath ${resolved} contains the project itself`);
  }
  if (resolved === internal || resolved.startsWith(`${internal}${path.sep}`)) {
    throw new Error(`cachePath ${resolved} is inside cache-verdict's own work directory`);
  }
}

function resolveTargets(root, config, options = {}) {
  const resolved = resolvePathPatterns(root, config.cachePath, options);
  for (const target of resolved.targets) assertSafeTarget(root, target);
  return resolved;
}

function moveWorkingTargets(targets, stashRoot) {
  const moved = [];
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      if (!pathExists(target)) continue;
      const stash = path.join(stashRoot, String(index));
      movePath(target, stash);
      moved.push({ target, stash });
    }
  } catch (error) {
    for (const entry of [...moved].reverse()) movePath(entry.stash, entry.target);
    removePath(stashRoot);
    throw error;
  }
  return moved;
}

function restoreWorkingTargets(root, config, moved, stashRoot) {
  const produced = resolveTargets(root, config, { existingOnly: true }).targets;
  const current = new Set([...moved.map((entry) => entry.target), ...produced]);
  for (const target of current) removePath(target);
  for (const entry of moved) {
    if (pathExists(entry.stash)) movePath(entry.stash, entry.target);
  }
  removePath(stashRoot);
}

/**
 * Take one timed sample. Existing cache directories are moved aside first, a
 * stored cache for this exact key (if any) is restored, the build runs once,
 * and the produced artifacts are stored for the next identical key.
 *
 * @param {string} root absolute project directory
 * @param {{ cold?: boolean, ledgerPath?: string }} [options]
 */
export function runSample(root, options = {}) {
  const directory = path.resolve(root);
  const config = loadConfig(directory);
  const forceCold = options.cold === true;
  const ledger = ledgerPath(directory, options.ledgerPath);
  const unresolvedBefore = resolveTargets(directory, config);
  if (config.cachePath.length > 0 && unresolvedBefore.targets.length === 0) {
    throw new Error(
      `cannot resolve any cachePath entries (${unresolvedBefore.unresolved.join(', ') || config.cachePath.join(', ')}); set the referenced environment variables or edit cachePath`,
    );
  }

  const { key } = computeInputKey(directory, config);
  const before = resolveTargets(directory, config, { existingOnly: true }).targets;

  ensureWorkDirectory(directory);
  const stashRoot = path.join(
    tempDirectory(directory),
    `${Date.now()}-${process.pid}-${randomUUID()}`,
  );
  const moved = moveWorkingTargets(before, stashRoot);

  let hit = false;
  let restoreMs = 0;
  let restoreBytes = 0;
  let buildMs = 0;
  let produced = [];
  let sizeBytes = 0;
  let stored = false;

  try {
    if (!forceCold) {
      const storedCache = readStoredCache(directory, key);
      if (storedCache !== null) {
        const restoreStart = nowMs();
        const restored = restoreStoredCache(directory, storedCache);
        restoreMs = nowMs() - restoreStart;
        restoreBytes = restored.restoredBytes;
        hit = true;
        touchStoredCache(directory, storedCache);
      }
    }

    const buildStart = nowMs();
    const result = spawnSync(config.command, {
      cwd: directory,
      shell: true,
      stdio: 'inherit',
    });
    buildMs = nowMs() - buildStart;

    if (result.error) throw result.error;
    const status = result.status ?? 1;
    if (status !== 0) {
      throw new Error(`build command exited with status ${status}: ${config.command}`);
    }

    produced = resolveTargets(directory, config, { existingOnly: true }).targets;
    sizeBytes = produced.reduce((total, target) => total + pathSize(target), 0);

    if (produced.length > 0) {
      storeCache(directory, key, produced);
      stored = true;
    } else if (!forceCold) {
      // The build used to produce artifacts for this key but no longer does.
      removePath(storeKeyDirectory(directory, key));
    }

    const totalMs = restoreMs + buildMs;
    const sample = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      key,
      hit,
      miss: !hit,
      cold: !hit,
      warm: hit,
      temperature: hit ? 'warm' : 'cold',
      forcedCold: forceCold,
      buildMs: roundMs(buildMs),
      restoreMs: roundMs(restoreMs),
      restoreCostMs: roundMs(restoreMs),
      totalMs: roundMs(totalMs),
      sizeBytes,
      cacheSizeBytes: sizeBytes,
      restoreSizeBytes: restoreBytes,
      stored,
      command: config.command,
    };

    appendLedgerSample(directory, sample, ledger);
    removePath(stashRoot);
    return sample;
  } catch (error) {
    restoreWorkingTargets(directory, config, moved, stashRoot);
    throw error;
  }
}

export function formatRunSummary(sample, config) {
  const temperature = sample.hit ? 'HIT (warm)' : 'MISS (cold)';
  return [
    `cache-verdict: ${temperature}`,
    `  key:     ${sample.key}`,
    `  command: ${config.command}`,
    `  restore: ${sample.restoreMs.toFixed(1)} ms`,
    `  build:   ${sample.buildMs.toFixed(1)} ms`,
    `  total:   ${sample.totalMs.toFixed(1)} ms`,
    `  size:    ${sample.sizeBytes} bytes${sample.stored ? '' : ' (no cache artifacts stored)'}`,
  ].join('\n');
}
