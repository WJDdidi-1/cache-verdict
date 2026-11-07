import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Paths in configs and ledgers always use forward slashes so a config written
 * on Windows still describes the same inputs on Linux CI.
 */
export function toPosix(value) {
  return value.split(path.sep).join('/');
}

export function hasGlob(value) {
  return /[*?[\]{}]/.test(value);
}

export function expandEnvironment(value, environment = process.env) {
  return value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (match, braced, bare) => {
    const name = braced ?? bare;
    return Object.prototype.hasOwnProperty.call(environment, name) ? environment[name] : match;
  });
}

function escapeRegExp(character) {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

/**
 * Translate the small glob dialect used by detectors into a regular
 * expression: `*` stays inside one path segment, `**` crosses segments, and
 * a double-star directory prefix also matches zero directories.
 */
export function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character === '*') {
      if (pattern[index + 1] === '*') {
        while (pattern[index + 1] === '*') index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(character);
    }
  }
  return new RegExp(`^${source}$`);
}

export function matchGlob(relativePath, pattern) {
  return globToRegExp(toPosix(pattern)).test(toPosix(relativePath));
}

function lstatSafe(target) {
  try {
    return lstatSync(target);
  } catch {
    return undefined;
  }
}

/**
 * Walk a project without following symlinks. Generated dependency trees are
 * skipped by default because they are never useful build inputs and can make
 * content hashing unexpectedly expensive.
 */
export function walkTree(root, options = {}) {
  const skipDirectories = new Set(
    options.skipDirectories ?? ['.git', '.hg', '.svn', '.cache-verdict', 'node_modules'],
  );
  const files = [];
  const directories = [];

  function walk(relativeDirectory) {
    const absoluteDirectory =
      relativeDirectory === ''
        ? root
        : path.join(root, ...relativeDirectory.split('/').filter(Boolean));

    let entries;
    try {
      entries = readdirSync(absoluteDirectory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const relative = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;

      if (entry.isDirectory()) {
        directories.push(relative);
        if (skipDirectories.has(entry.name)) continue;
        walk(relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }

  walk('');
  files.sort();
  directories.sort();
  return { files, directories };
}

function staticPrefix(pattern) {
  const segments = pattern.split('/');
  const kept = [];
  for (const segment of segments) {
    if (hasGlob(segment)) break;
    kept.push(segment);
  }
  // The final literal segment may be the file itself, so only walk its parent.
  if (kept.length === segments.length) kept.pop();
  return kept.join('/');
}

/**
 * Resolve declared input or cache paths to absolute filesystem targets.
 *
 * A non-glob path is always returned (unless `existingOnly` is set), because
 * `run` needs to know where a cache directory will appear after the build.
 * Globs only return paths that currently exist.
 *
 * @param {string} root absolute project directory
 * @param {string[]} patterns declared paths, possibly containing $ENV or globs
 * @param {{ existingOnly?: boolean, environment?: NodeJS.ProcessEnv }} [options]
 * @returns {{ targets: string[], unresolved: string[] }}
 */
export function resolvePathPatterns(root, patterns, options = {}) {
  const existingOnly = options.existingOnly === true;
  const environment = options.environment ?? process.env;
  const targets = new Set();
  const unresolved = [];

  for (const declared of patterns) {
    if (typeof declared !== 'string' || declared.trim() === '') continue;

    const expanded = expandEnvironment(declared.trim(), environment);
    if (expanded.includes('$')) {
      unresolved.push(declared);
      continue;
    }

    if (path.isAbsolute(expanded)) {
      if (hasGlob(expanded)) {
        unresolved.push(declared);
        continue;
      }
      const stat = lstatSafe(expanded);
      if (!existingOnly || stat !== undefined) targets.add(path.normalize(expanded));
      continue;
    }

    if (!hasGlob(expanded)) {
      const target = path.resolve(root, expanded);
      const stat = lstatSafe(target);
      if (!existingOnly || stat !== undefined) targets.add(target);
      continue;
    }

    const prefix = staticPrefix(toPosix(expanded));
    const base = prefix === '' ? root : path.resolve(root, ...prefix.split('/'));
    const baseStat = lstatSafe(base);
    if (baseStat === undefined || !baseStat.isDirectory()) continue;

    const pattern = toPosix(expanded);
    const relativeBase = path.relative(root, base);
    const start = relativeBase === '' ? '' : toPosix(relativeBase);
    const tree = walkTree(root, { skipDirectories: ['.git', '.hg', '.svn', '.cache-verdict', 'node_modules'] });

    for (const relative of [...tree.files, ...tree.directories]) {
      if (start !== '' && !(relative === start || relative.startsWith(`${start}/`))) continue;
      if (matchGlob(relative, pattern)) targets.add(path.resolve(root, ...relative.split('/')));
    }
  }

  return {
    targets: [...targets].sort(),
    unresolved,
  };
}
