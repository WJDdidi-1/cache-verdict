#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  detectProject,
  isSupportedEcosystem,
  supportedEcosystemIds,
} from '../lib/detect.mjs';
import {
  CONFIG_FILENAME,
  buildConfig,
  loadConfig,
  serializeConfig,
  writeConfig,
} from '../lib/config.mjs';
import { ledgerPath, pruneStore, readLedger, storeStats } from '../lib/ledger.mjs';
import { analyzeSamples, formatReport } from '../lib/report.mjs';
import { formatRunSummary, runSample } from '../lib/run.mjs';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const USAGE = `cache-verdict: times build-cache cold vs warm runs and says whether the cache pays

Usage:
  cache-verdict init [directory] [options]
  cache-verdict run [directory] [--cold] [--ledger <path>]
  cache-verdict report [directory] [--json] [--ledger <path>]
  cache-verdict check [directory] [--ledger <path>]
  cache-verdict prune [directory] --keep <n>
  cache-verdict --help
  cache-verdict --version

Commands:
  init    Detect Cargo, Gradle, Next.js, npm, Python, or Go in a project and
          write a reviewable .cache-verdict.json beside its build files.
  run     Move declared cache dirs aside, restore a cache for the content-
          addressed key when one exists, time the build, store the produced
          artifacts, and append a sample to .cache-verdict/ledger.jsonl.
  report  Print hit rate, median cold and warm totals, restore cost, net ms
          per hit, cache size, and one verdict.
  check   Exit 0 for cache-pays, 2 for cache-costs, cache-churns,
          cache-never-hits, or cache-unobserved, and 3 when more runs are
          needed before a verdict is possible.
  prune   Evict least-recently-used stored cache keys.

Init options:
  -e, --ecosystem <id>  Use this detector when several build systems match.
                        One of: ${supportedEcosystemIds().join(', ')}
      --command <cmd>   Override the detected build command.
  -f, --force           Overwrite an existing .cache-verdict.json.
      --dry-run         Print the config to stdout instead of writing it.
  -h, --help            Show this help.

Run options:
      --cold            Force a cold baseline sample. A stored cache is kept
                        for the next normal run, so it does not prevent a hit.
  -h, --help            Show this help.

Report options:
      --json            Print the analysis as JSON.
  -h, --help            Show this help.

Ledger options (run, report, and check):
      --ledger <path>   Read or append samples at this file instead of
                        .cache-verdict/ledger.jsonl. Relative paths resolve
                        from the current directory. CACHE_VERDICT_LEDGER
                        provides the same path when the flag is absent.

Prune options:
  -k, --keep <n>        Number of most-recently-used stored keys to retain.
  -h, --help            Show this help.

The config records the detected build command, the files whose contents make
up the cache key, the cache paths to measure, and why the project was detected.
Review and edit it before sampling. Detection order is Next.js, Cargo, Gradle,
Go, Python, then npm; use --ecosystem to override.

Measured files live under .cache-verdict/ in the project: ledger.jsonl is the
append-only sample history and store/ holds one content-addressed cache per
key. Add .cache-verdict/ to .gitignore. To carry samples between CI builds, put
the ledger on a persisted path with --ledger or CACHE_VERDICT_LEDGER; keep
store/ too so later builds can still restore a cache for the same key.

Exit codes:
  0  success; check found that the cache pays
  1  no matching build system, unreadable directory, existing config, or a
     failed build command
  2  invalid command-line usage; check found a losing, churning, unobserved,
     or never-hitting cache
  3  check needs more runs before it can decide
`;

class UsageError extends Error {}

class CliError extends Error {}

function resolveDirectory(value) {
  const directory = path.resolve(process.cwd(), value);
  let stat;
  try {
    stat = statSync(directory);
  } catch {
    throw new CliError(`cannot read directory ${directory}`);
  }
  if (!stat.isDirectory()) throw new CliError(`${directory} is not a directory`);
  return directory;
}

function parseInitOptions(args) {
  const options = {
    dir: '.',
    force: false,
    dryRun: false,
    ecosystem: null,
    command: undefined,
    help: false,
  };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--force' || argument === '-f') {
      options.force = true;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--ecosystem' || argument === '-e') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError(`${argument} needs an ecosystem id`);
      }
      options.ecosystem = value;
      index += 1;
    } else if (argument.startsWith('--ecosystem=')) {
      const value = argument.slice('--ecosystem='.length);
      if (!value) throw new UsageError('--ecosystem needs an ecosystem id');
      options.ecosystem = value;
    } else if (argument === '--command') {
      const value = args[index + 1];
      if (value === undefined) throw new UsageError('--command needs a value');
      options.command = value;
      index += 1;
    } else if (argument.startsWith('--command=')) {
      const value = argument.slice('--command='.length);
      if (!value.trim()) throw new UsageError('--command needs a value');
      options.command = value;
    } else if (argument === '--') {
      positional.push(...args.slice(index + 1));
      break;
    } else if (argument.startsWith('-')) {
      throw new UsageError(`unknown option ${argument}`);
    } else {
      positional.push(argument);
    }
  }

  if (positional.length > 1) {
    throw new UsageError('init accepts at most one directory');
  }
  if (positional.length === 1) options.dir = positional[0];
  if (options.command !== undefined && !options.command.trim()) {
    throw new UsageError('--command needs a value');
  }

  return options;
}

function parseSimpleOptions(args, knownFlags, valueFlags = []) {
  const options = { dir: '.', help: false };
  for (const flag of knownFlags) options[flag] = false;
  for (const flag of valueFlags) options[flag] = null;
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const valueFlag = valueFlags.find(
      (flag) => argument === `--${flag}` || argument.startsWith(`--${flag}=`),
    );

    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--') {
      positional.push(...args.slice(index + 1));
      break;
    } else if (valueFlag !== undefined) {
      if (argument.startsWith(`--${valueFlag}=`)) {
        const value = argument.slice(`--${valueFlag}=`.length);
        if (!value.trim()) throw new UsageError(`--${valueFlag} needs a path`);
        options[valueFlag] = value;
      } else {
        const value = args[index + 1];
        if (value === undefined || value.startsWith('-')) {
          throw new UsageError(`--${valueFlag} needs a path`);
        }
        options[valueFlag] = value;
        index += 1;
      }
    } else if (argument.startsWith('-') && knownFlags.includes(argument.slice(2))) {
      options[argument.slice(2)] = true;
    } else if (argument.startsWith('-')) {
      throw new UsageError(`unknown option ${argument}`);
    } else {
      positional.push(argument);
    }
  }

  if (positional.length > 1) throw new UsageError('this command accepts at most one directory');
  if (positional.length === 1) options.dir = positional[0];
  return options;
}

function parsePruneOptions(args) {
  const options = { dir: '.', keep: null, help: false };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--keep' || argument === '-k') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError(`${argument} needs a count`);
      }
      options.keep = value;
      index += 1;
    } else if (argument.startsWith('--keep=')) {
      options.keep = argument.slice('--keep='.length);
    } else if (argument === '--') {
      positional.push(...args.slice(index + 1));
      break;
    } else if (argument.startsWith('-')) {
      throw new UsageError(`unknown option ${argument}`);
    } else {
      positional.push(argument);
    }
  }

  if (positional.length > 1) throw new UsageError('prune accepts at most one directory');
  if (positional.length === 1) options.dir = positional[0];
  if (options.help) return options;

  if (options.keep === null) throw new UsageError('prune needs --keep <n>');
  if (!/^\d+$/.test(String(options.keep))) {
    throw new UsageError('--keep needs a non-negative integer');
  }
  options.keep = Number(options.keep);
  return options;
}

function init(args) {
  const options = parseInitOptions(args);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (options.ecosystem !== null && !isSupportedEcosystem(options.ecosystem)) {
    throw new UsageError(
      `unsupported ecosystem "${options.ecosystem}"; choose one of: ${supportedEcosystemIds().join(', ')}`,
    );
  }

  const directory = resolveDirectory(options.dir);
  const detection = detectProject(directory, { ecosystem: options.ecosystem });
  const config = buildConfig(detection, options.command === undefined ? {} : { command: options.command });

  if (options.dryRun) {
    process.stdout.write(serializeConfig(config));
    return 0;
  }

  const target = writeConfig(directory, config, { force: options.force });
  const shown = path.relative(process.cwd(), target) || CONFIG_FILENAME;

  console.log(`Detected ${detection.displayName} from ${detection.detectedFrom.join(', ')}.`);
  console.log(`Wrote ${shown}.`);
  if (detection.alternatives.length > 0) {
    const alternatives = detection.alternatives.map((item) => item.ecosystem).join(', ');
    console.log(`Also detected: ${alternatives}. Use --ecosystem to choose one instead.`);
  }
  for (const note of config.notes ?? []) console.log(`note: ${note}`);
  console.log('Review "command", "inputs", and "cachePath" before sampling.');

  return 0;
}

function run(args) {
  const options = parseSimpleOptions(args, ['cold'], ['ledger']);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const directory = resolveDirectory(options.dir);
  const config = loadConfig(directory);
  const ledger = ledgerPath(directory, options.ledger);
  const sample = runSample(directory, { cold: options.cold, ledgerPath: ledger });
  console.log(formatRunSummary(sample, config));
  return 0;
}

function analyzeProject(directory, ledger) {
  const config = loadConfig(directory);
  const samples = readLedger(directory, ledger);
  const stats = storeStats(directory);
  return analyzeSamples(samples, {
    hasCachePaths: config.cachePath.length > 0,
    cachePaths: config.cachePath,
    storedKeys: stats.keys,
    storedSizeBytes: stats.sizeBytes,
  });
}

function report(args) {
  const options = parseSimpleOptions(args, ['json'], ['ledger']);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const directory = resolveDirectory(options.dir);
  const ledger = ledgerPath(directory, options.ledger);
  const analysis = analyzeProject(directory, ledger);
  if (options.json) {
    console.log(JSON.stringify(analysis, null, 2));
  } else {
    process.stdout.write(formatReport(analysis));
  }
  return 0;
}

function check(args) {
  const options = parseSimpleOptions(args, [], ['ledger']);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const directory = resolveDirectory(options.dir);
  const ledger = ledgerPath(directory, options.ledger);
  const analysis = analyzeProject(directory, ledger);
  process.stdout.write(formatReport(analysis));

  if (analysis.moreRunsNeeded) {
    process.stderr.write(
      `cache-verdict: not enough samples yet in ${ledger}; run the build again before gating CI\n`,
    );
    return 3;
  }
  if (analysis.verdict === 'cache-pays') return 0;

  process.stderr.write(`cache-verdict: ${analysis.verdict}; ${analysis.reason}\n`);
  return 2;
}

function prune(args) {
  const options = parsePruneOptions(args);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const directory = resolveDirectory(options.dir);
  loadConfig(directory);
  const result = pruneStore(directory, options.keep);
  console.log(
    `Kept ${result.kept.length} stored key${result.kept.length === 1 ? '' : 's'}; evicted ${result.evicted.length}.`,
  );
  return 0;
}

function main(argv) {
  if (argv.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }

  const [command, ...rest] = argv;

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return 0;
  }
  if (command === 'init') return init(rest);
  if (command === 'run') return run(rest);
  if (command === 'report') return report(rest);
  if (command === 'check') return check(rest);
  if (command === 'prune') return prune(rest);
  if (command.startsWith('-')) throw new UsageError(`unknown option ${command}`);
  throw new UsageError(`unknown command "${command}"`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`cache-verdict: ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`cache-verdict: ${error.message}\n`);
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  }
}
