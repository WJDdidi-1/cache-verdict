import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { normalizePolicy } from './policy.mjs';

export const CONFIG_FILENAME = '.cache-verdict.json';
export const CONFIG_VERSION = 1;

/**
 * Turn a detection result into the config a human reviews before sampling.
 * The override is kept separate so detection stays reusable by `run`.
 *
 * @param {ReturnType<import('./detect.mjs').detectProject>} detection
 * @param {{ command?: string }} [overrides]
 */
export function buildConfig(detection, overrides = {}) {
  if (detection === null || typeof detection !== 'object') {
    throw new Error('cannot build a config without a detection result');
  }

  const command = overrides.command === undefined ? detection.command : overrides.command;
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('build command must be a non-empty string');
  }

  const config = {
    schemaVersion: CONFIG_VERSION,
    ecosystem: detection.ecosystem,
    displayName: detection.displayName,
    command: command.trim(),
    inputs: [...detection.inputs],
    cachePath: [...detection.cachePath],
    detectedFrom: [...detection.detectedFrom],
  };

  const notes = [...(detection.notes ?? [])];
  if (notes.length > 0) config.notes = notes;

  return config;
}

export function serializeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function stringArray(value, field, source) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${source}: "${field}" must be an array of strings`);
  }
  return [...value];
}

/**
 * Load and minimally validate the reviewed config. `run`, `report`, `check`,
 * and `prune` all read the same file, so validation lives here.
 *
 * @param {string} directory absolute project directory
 */
export function loadConfig(directory) {
  const target = path.join(directory, CONFIG_FILENAME);
  let text;
  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`no ${CONFIG_FILENAME} in ${directory}; run "cache-verdict init" first`);
    }
    throw new Error(`cannot read ${target}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`cannot parse ${target}: ${error.message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${target} must contain a JSON object`);
  }
  if (typeof parsed.command !== 'string' || parsed.command.trim() === '') {
    throw new Error(`${target}: "command" must be a non-empty string`);
  }

  return {
    ...parsed,
    command: parsed.command.trim(),
    inputs: stringArray(parsed.inputs, 'inputs', target),
    cachePath: stringArray(parsed.cachePath, 'cachePath', target),
    // A missing policy is normal; `check` then keeps its verdict-only exit
    // codes. When a policy is present, reject typos and negative thresholds
    // here so every command reports the same config error.
    policy: normalizePolicy(parsed.policy, target),
  };
}

/**
 * Whether a config file (or another filesystem entry with that name) already
 * exists. `init --github-action` uses this to add a workflow without
 * discarding a config the user reviewed earlier.
 *
 * @param {string} directory
 */
export function configExists(directory) {
  const target = path.join(directory, CONFIG_FILENAME);
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error(`cannot inspect ${target}: ${error.message}`);
  }
}

/**
 * Check whether `init` may replace the config. Exported so a command that
 * writes more than one file can fail before writing either of them.
 *
 * @param {string} directory
 * @param {{ force?: boolean }} [options]
 * @returns {string} the config path
 */
export function assertConfigWritable(directory, options = {}) {
  const target = path.join(directory, CONFIG_FILENAME);

  let existing;
  try {
    existing = lstatSync(target);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`cannot inspect ${target}: ${error.message}`);
    }
    existing = undefined;
  }

  if (existing !== undefined) {
    if (existing.isDirectory()) {
      throw new Error(`cannot overwrite ${target}: it is a directory`);
    }
    if (options.force !== true) {
      throw new Error(
        `refusing to overwrite existing ${CONFIG_FILENAME} in ${directory}; use --force to replace it`,
      );
    }
  }

  return target;
}

/**
 * Write the config atomically. An existing file is only replaced with
 * `force`, so `init` can never silently discard a reviewed configuration.
 *
 * @param {string} directory
 * @param {object} config
 * @param {{ force?: boolean }} [options]
 * @returns {string} the path that was written
 */
export function writeConfig(directory, config, options = {}) {
  const target = assertConfigWritable(directory, options);
  const temp = path.join(directory, `.${CONFIG_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, serializeConfig(config), { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temporary file may never have been created; the real error is below.
    }
    throw new Error(`cannot write ${target}: ${error.message}`);
  }

  return target;
}
