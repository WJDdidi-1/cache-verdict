import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { matchGlob, toPosix, walkTree } from './glob.mjs';

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
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
