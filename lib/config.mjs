import { randomUUID } from 'node:crypto';
import { lstatSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
  const force = options.force === true;
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
    if (!force) {
      throw new Error(
        `refusing to overwrite existing ${CONFIG_FILENAME} in ${directory}; use --force to replace it`,
      );
    }
  }

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
