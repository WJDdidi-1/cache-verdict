import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { matchGlob, toPosix, walkTree } from './glob.mjs';

/**
 * A ledger is an append-only history, so a project with a huge input tree
 * must not turn every sample into a multi-megabyte line. The cache key still
 * covers every matched file; the ledger records a deterministic prefix and
 * marks itself truncated so `report` can say the list is partial.
 */
export const MAX_RECORDED_INPUTS = 500;
export const MAX_RECORDED_INPUT_BYTES = 48 * 1024;

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Select the bounded prefix of hashed input files that a ledger sample keeps.
 * Files arrive sorted by path, so the prefix is stable between runs.
 *
 * @param {Array<{ path: string, sha256: string }>} files
 * @param {{ maxFiles?: number, maxBytes?: number }} [limits]
 * @returns {{ files: Array<{ path: string, sha256: string }>, totalFiles: number, truncated: boolean }}
 */
export function recordInputFiles(files, limits = {}) {
  if (!Array.isArray(files)) {
    throw new Error('cannot record inputs: expected an array of files');
  }

  const maxFiles =
    Number.isInteger(limits.maxFiles) && limits.maxFiles >= 0
      ? limits.maxFiles
      : MAX_RECORDED_INPUTS;
  const maxBytes =
    Number.isInteger(limits.maxBytes) && limits.maxBytes >= 0
      ? limits.maxBytes
      : MAX_RECORDED_INPUT_BYTES;

  const recorded = [];
  let bytes = 0;

  for (const file of files) {
    if (recorded.length >= maxFiles) break;
    const entry = {
      path: String(file.path),
      sha256: String(file.sha256),
    };
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    if (bytes + entryBytes > maxBytes) break;
    recorded.push(entry);
    bytes += entryBytes;
  }

  return {
    files: recorded,
    totalFiles: files.length,
    truncated: recorded.length < files.length,
  };
}

/**
 * Content-address the declared inputs. The command, cache paths, and input
 * patterns are part of the address too: changing how a build is invoked or
 * what it measures must not silently reuse an unrelated stored cache.
 *
 * @param {string} directory absolute project directory
 * @param {{ command: string, inputs: string[], cachePath: string[] }} config
 * @returns {{ key: string, files: Array<{ path: string, sha256: string }> }}
 */
export function computeInputKey(directory, config) {
  const patterns = [...new Set(config.inputs.map(toPosix))].sort();
  const cachePatterns = [...new Set(config.cachePath.map(toPosix))].sort();
  const { files } = walkTree(directory);

  const matched = files.filter((relative) =>
    patterns.some((pattern) => matchGlob(relative, pattern)),
  );

  const entries = matched.map((relative) => {
    const absolute = path.join(directory, ...relative.split('/'));
    let contents;
    try {
      contents = readFileSync(absolute);
    } catch (error) {
      throw new Error(`cannot read declared input ${relative}: ${error.message}`);
    }
    return { path: relative, sha256: sha256(contents) };
  });

  const payload = {
    schemaVersion: 1,
    command: config.command,
    inputs: patterns,
    cachePath: cachePatterns,
    files: entries,
  };

  return {
    key: `sha256:${sha256(JSON.stringify(payload))}`,
    files: entries,
  };
}
