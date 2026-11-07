import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { toPosix } from './glob.mjs';

export const WORK_DIRECTORY = '.cache-verdict';
export const LEDGER_FILENAME = 'ledger.jsonl';
export const STORE_DIRECTORY = 'store';
export const MANIFEST_FILENAME = 'manifest.json';
export const TMP_DIRECTORY = 'tmp';

export function workDirectory(root) {
  return path.join(root, WORK_DIRECTORY);
}

export function ledgerPath(root) {
  return path.join(workDirectory(root), LEDGER_FILENAME);
}

export function storeDirectory(root) {
  return path.join(workDirectory(root), STORE_DIRECTORY);
}

export function tempDirectory(root) {
  return path.join(workDirectory(root), TMP_DIRECTORY);
}

export function ensureWorkDirectory(root) {
  const directory = workDirectory(root);
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function pathExists(target) {
  return existsSync(target);
}

export function pathSize(target) {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return 0;
  }

  if (stat.isSymbolicLink()) return stat.size;
  if (!stat.isDirectory()) return stat.size;

  let total = 0;
  let entries;
  try {
    entries = readdirSync(target, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const entry of entries) {
    total += pathSize(path.join(target, entry.name));
  }
  return total;
}

export function removePath(target) {
  rmSync(target, { recursive: true, force: true });
}

export function copyPath(source, target) {
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    dereference: false,
  });
}

/**
 * Move a cache path out of the build directory. Falling back to copy+delete
 * keeps absolute cache paths on another filesystem working too.
 */
export function movePath(source, target) {
  mkdirSync(path.dirname(target), { recursive: true });
  removePath(target);
  try {
    renameSync(source, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    copyPath(source, target);
    removePath(source);
  }
}

export function readLedger(root) {
  const target = ledgerPath(root);
  let text;
  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`cannot read ${target}: ${error.message}`);
  }

  const samples = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    try {
      const sample = JSON.parse(line);
      if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) {
        throw new Error('sample must be a JSON object');
      }
      samples.push(sample);
    } catch (error) {
      throw new Error(`cannot parse ${target} line ${index + 1}: ${error.message}`);
    }
  }
  return samples;
}

export function appendLedgerSample(root, sample) {
  ensureWorkDirectory(root);
  appendFileSync(ledgerPath(root), `${JSON.stringify(sample)}\n`, 'utf8');
}

function keySegment(key) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(key);
  if (!match) throw new Error(`invalid cache key ${JSON.stringify(key)}`);
  return match[1];
}

export function storeKeyDirectory(root, key) {
  return path.join(storeDirectory(root), keySegment(key));
}

export function encodeStoredTarget(root, target) {
  const relative = path.relative(root, target);
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return { kind: 'relative', path: toPosix(relative) };
  }
  return { kind: 'absolute', path: target };
}

export function decodeStoredTarget(root, target) {
  if (target?.kind === 'relative' && typeof target.path === 'string') {
    return path.resolve(root, ...target.path.split('/'));
  }
  if (target?.kind === 'absolute' && typeof target.path === 'string') {
    return path.normalize(target.path);
  }
  throw new Error('stored cache manifest contains an invalid target');
}

function readManifestFile(directory) {
  const target = path.join(directory, MANIFEST_FILENAME);
  let text;
  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`cannot read ${target}: ${error.message}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot parse ${target}: ${error.message}`);
  }

  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.slots)) {
    throw new Error(`${target} must contain a manifest object with "slots"`);
  }
  return manifest;
}

export function readStoredCache(root, key) {
  const directory = storeKeyDirectory(root, key);
  const manifest = readManifestFile(directory);
  if (manifest === null) return null;
  if (manifest.key !== key) {
    throw new Error(`stored cache ${key} has a mismatched manifest`);
  }

  const slots = manifest.slots
    .filter((slot) => Number.isInteger(slot.index) && slot.target !== undefined)
    .filter((slot) => existsSync(path.join(directory, String(slot.index))))
    .sort((left, right) => left.index - right.index);

  if (slots.length === 0) return null;
  return { ...manifest, slots, directory };
}

export function restoreStoredCache(root, manifest) {
  let restoredBytes = 0;

  for (const slot of manifest.slots) {
    const target = decodeStoredTarget(root, slot.target);
    const source = path.join(manifest.directory, String(slot.index));
    removePath(target);
    copyPath(source, target);
    restoredBytes += Number.isFinite(slot.sizeBytes) ? slot.sizeBytes : pathSize(source);
  }

  return { restoredBytes, restoredSlots: manifest.slots.length };
}

export function touchStoredCache(root, manifest) {
  const { directory, ...stored } = manifest;
  const updated = { ...stored, lastUsedAt: new Date().toISOString() };
  writeFileSync(
    path.join(directory, MANIFEST_FILENAME),
    `${JSON.stringify(updated, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Store the artifacts produced by a build under their content-addressed key.
 * The new directory is built beside the old one and swapped in at the end, so
 * a failed copy cannot destroy the cache that was just used for a hit.
 */
export function storeCache(root, key, targets) {
  const store = storeDirectory(root);
  mkdirSync(store, { recursive: true });

  const segment = keySegment(key);
  const finalDirectory = path.join(store, segment);
  const staging = path.join(store, `.${segment}.${process.pid}.${randomUUID()}.tmp`);
  mkdirSync(staging, { recursive: true });

  let sizeBytes = 0;
  const slots = [];
  const sorted = [...targets].sort();

  try {
    for (let index = 0; index < sorted.length; index += 1) {
      const target = sorted[index];
      const slotDirectory = path.join(staging, String(index));
      copyPath(target, slotDirectory);
      const slotSize = pathSize(target);
      sizeBytes += slotSize;
      slots.push({
        index,
        target: encodeStoredTarget(root, target),
        sizeBytes: slotSize,
      });
    }

    const now = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      key,
      createdAt: now,
      lastUsedAt: now,
      sizeBytes,
      slots,
    };
    writeFileSync(
      path.join(staging, MANIFEST_FILENAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    removePath(finalDirectory);
    renameSync(staging, finalDirectory);
    return manifest;
  } catch (error) {
    removePath(staging);
    throw error;
  }
}

function listStoreDirectories(root) {
  const store = storeDirectory(root);
  let entries;
  try {
    entries = readdirSync(store, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`cannot read ${store}: ${error.message}`);
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(store, entry.name));
}

export function storeStats(root) {
  const directories = listStoreDirectories(root);
  let sizeBytes = 0;
  let keys = 0;

  for (const directory of directories) {
    const manifest = readManifestFile(directory);
    if (manifest === null) {
      sizeBytes += pathSize(directory);
      keys += 1;
      continue;
    }
    sizeBytes += Number.isFinite(manifest.sizeBytes) ? manifest.sizeBytes : pathSize(directory);
    keys += 1;
  }

  return { keys, sizeBytes };
}

/**
 * Evict least-recently-used stored keys. A hit updates lastUsedAt, so pruning
 * keeps the keys the sampled builds actually restore.
 */
export function pruneStore(root, keep) {
  const directories = listStoreDirectories(root);
  const entries = directories.map((directory) => {
    let manifest = null;
    try {
      manifest = readManifestFile(directory);
    } catch {
      manifest = null;
    }
    const lastUsed = manifest?.lastUsedAt ? Date.parse(manifest.lastUsedAt) : Number.NaN;
    let fallback = 0;
    try {
      fallback = statSync(directory).mtimeMs;
    } catch {
      fallback = 0;
    }
    return {
      directory,
      key: manifest?.key ?? path.basename(directory),
      lastUsedAt: Number.isFinite(lastUsed) ? lastUsed : fallback,
    };
  });

  entries.sort((left, right) => right.lastUsedAt - left.lastUsedAt);

  const kept = entries.slice(0, keep);
  const evicted = entries.slice(keep);
  for (const entry of evicted) removePath(entry.directory);

  return {
    kept: kept.map((entry) => entry.key),
    evicted: evicted.map((entry) => entry.key),
  };
}
