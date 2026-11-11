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
  assertConfigWritable,
  buildConfig,
  configExists,
  loadConfig,
  serializeConfig,
  writeConfig,
} from '../lib/config.mjs';
import { ledgerPath, pruneStore, readLedger, storeStats } from '../lib/ledger.mjs';
import { resolvePolicy } from '../lib/policy.mjs';
import { analyzeSamples, formatReport } from '../lib/report.mjs';
import { formatRunSummary, runSample } from '../lib/run.mjs';
import {
  WORKFLOW_PATH,
  assertWorkflowWritable,
  renderGithubWorkflow,
  writeWorkflow,
} from '../lib/workflow.mjs';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const USAGE = `cache-verdict: times build-cache cold vs warm runs and says whether the cache pays

Usage:
  cache-verdict init [directory] [options]
  cache-verdict run [directory] [--cold] [--ledger <path>]
  cache-verdict report [directory] [--history] [--json] [--ledger <path>]
  cache-verdict check [directory] [--json] [--ledger <path>]
                      [--min-net-ms <ms>] [--max-restore-ms <ms>]
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
          per hit, cache size, and one verdict. --history adds one row per
          sample and the regression point.
  check   Compare the report with the savings policy in .cache-verdict.json
          (or the --min-net-ms/--max-restore-ms overrides). Exit 0 for
          cache-pays, 2 for cache-costs, cache-churns, cache-never-hits, or
          cache-unobserved, 3 when more runs are needed before a verdict is
          possible, and 4 when a policy threshold is missed.
  prune   Evict least-recently-used stored cache keys.

Init options:
  -e, --ecosystem <id>  Use this detector when several build systems match.
                        One of: ${supportedEcosystemIds().join(', ')}
      --command <cmd>   Override the detected build command.
      --github-action   Also write ${WORKFLOW_PATH}: a workflow that restores
                        the ledger and stored cache with actions/cache, runs
                        cache-verdict run, and gates on cache-verdict check.
  -f, --force           Overwrite an existing .cache-verdict.json or workflow.
      --dry-run         Print the config (and generated workflow) to stdout
                        instead of writing either file.
  -h, --help            Show this help.

Run options:
      --cold            Force a cold baseline sample. A stored cache is kept
                        for the next normal run, so it does not prevent a hit.
  -h, --help            Show this help.

Report options:
      --history         Print one row per sample (index, timestamp, hit/miss,
                        total ms, net ms) and the regression point. Net ms is
                        the median cold total minus that sample's total.
      --json            Print the analysis as JSON. The JSON always includes
                        the sample history and regressedAt.
  -h, --help            Show this help.

Check options:
      --json            Print the analysis, policy, and policy failures as JSON.
      --min-net-ms <ms> Fail unless at least this many milliseconds are saved
                        per hit; overrides policy.minNetMsPerHit.
      --max-restore-ms <ms>
                        Fail when the median restore takes more than this many
                        milliseconds; overrides policy.maxRestoreMs.
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
Review and edit it before sampling. Add an optional "policy" object with
"minNetMsPerHit" and/or "maxRestoreMs" to make check gate on measured savings
instead of the verdict alone. Detection order is Next.js, Cargo, Gradle, Go,
Python, then npm; use --ecosystem to override.

Measured files live under .cache-verdict/ in the project: ledger.jsonl is the
append-only sample history and store/ holds one content-addressed cache per
key. Add .cache-verdict/ to .gitignore. To carry samples between CI builds, put
the ledger on a persisted path with --ledger or CACHE_VERDICT_LEDGER; keep
store/ too so later builds can still restore a cache for the same key.

init --github-action writes .github/workflows/cache-verdict.yml next to the
config. The workflow restores and saves the ledger plus store/ with
actions/cache, appends a sample with run, and gates with check.

Exit codes:
  0  success; check found that the cache pays
  1  no matching build system, unreadable directory, existing config or
     workflow, or a failed build command
  2  invalid command-line usage; check found a losing, churning, unobserved,
     or never-hitting cache
  3  check needs more runs before it can decide
  4  check missed a threshold in the configured savings policy
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
    githubAction: false,
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
    } else if (argument === '--github-action') {
      options.githubAction = true;
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

function parseSimpleOptions(args, knownFlags, valueFlags = [], numericFlags = []) {
  const options = { dir: '.', help: false };
  for (const flag of knownFlags) options[flag] = false;
  for (const flag of [...valueFlags, ...numericFlags]) options[flag] = null;
  const positional = [];
  const allValueFlags = [...valueFlags, ...numericFlags];

  function parseValue(flag, value) {
    if (numericFlags.includes(flag)) {
      const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
      if (!Number.isFinite(number) || number < 0) {
        throw new UsageError(`--${flag} needs a non-negative number of milliseconds`);
      }
      return number;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new UsageError(`--${flag} needs a path`);
    }
    return value;
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const valueFlag = allValueFlags.find(
      (flag) => argument === `--${flag}` || argument.startsWith(`--${flag}=`),
    );

    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--') {
      positional.push(...args.slice(index + 1));
      break;
    } else if (valueFlag !== undefined) {
      if (argument.startsWith(`--${valueFlag}=`)) {
        options[valueFlag] = parseValue(
          valueFlag,
          argument.slice(`--${valueFlag}=`.length),
        );
      } else {
        const value = args[index + 1];
        if (value === undefined) {
          throw new UsageError(
            numericFlags.includes(valueFlag)
              ? `--${valueFlag} needs a non-negative number of milliseconds`
              : `--${valueFlag} needs a path`,
          );
        }
        if (!numericFlags.includes(valueFlag) && value.startsWith('-')) {
          throw new UsageError(`--${valueFlag} needs a path`);
        }
        options[valueFlag] = parseValue(valueFlag, value);
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
  const hasConfig = configExists(directory);
  // Adding a workflow to an existing project must not require --force: that
  // would replace the reviewed config as a side effect.
  const keepConfig =
    options.githubAction === true && hasConfig && options.force !== true && options.dryRun !== true;
  const workflow =
    options.githubAction === true
      ? renderGithubWorkflow(directory, detection, {
          version: VERSION,
          command: keepConfig ? loadConfig(directory).command : config.command,
        })
      : null;

  if (options.dryRun) {
    process.stdout.write(serializeConfig(config));
    if (workflow !== null) {
      process.stdout.write(`\n# ${WORKFLOW_PATH}\n`);
      process.stdout.write(workflow);
    }
    return 0;
  }

  if (workflow !== null) {
    // Check both targets before writing either, so a refused overwrite cannot
    // leave a half-applied init behind.
    if (!keepConfig) assertConfigWritable(directory, { force: options.force });
    assertWorkflowWritable(directory, { force: options.force });
  }

  const target = keepConfig
    ? path.join(directory, CONFIG_FILENAME)
    : writeConfig(directory, config, { force: options.force });
  const shown = path.relative(process.cwd(), target) || CONFIG_FILENAME;

  console.log(`Detected ${detection.displayName} from ${detection.detectedFrom.join(', ')}.`);
  console.log(`${keepConfig ? 'Kept' : 'Wrote'} ${shown}.`);

  if (workflow !== null) {
    const writtenWorkflow = writeWorkflow(directory, workflow, { force: options.force });
    const shownWorkflow = path.relative(process.cwd(), writtenWorkflow) || WORKFLOW_PATH;
    console.log(`Wrote ${shownWorkflow}.`);
    console.log(
      'Review the install step, then commit the config and workflow so CI restores the same ledger.',
    );
  }

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

function analyzeProject(directory, ledger, policyOverrides) {
  const config = loadConfig(directory);
  const policy = resolvePolicy(config.policy, policyOverrides);
  const samples = readLedger(directory, ledger);
  const stats = storeStats(directory);
  return analyzeSamples(samples, {
    hasCachePaths: config.cachePath.length > 0,
    cachePaths: config.cachePath,
    storedKeys: stats.keys,
    storedSizeBytes: stats.sizeBytes,
    policy,
  });
}

function report(args) {
  const options = parseSimpleOptions(args, ['history', 'json'], ['ledger']);
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
    process.stdout.write(formatReport(analysis, { history: options.history === true }));
  }
  return 0;
}

function check(args) {
  const options = parseSimpleOptions(
    args,
    ['json'],
    ['ledger'],
    ['min-net-ms', 'max-restore-ms'],
  );
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const directory = resolveDirectory(options.dir);
  const ledger = ledgerPath(directory, options.ledger);
  const analysis = analyzeProject(directory, ledger, {
    minNetMsPerHit: options['min-net-ms'],
    maxRestoreMs: options['max-restore-ms'],
  });

  if (options.json) {
    console.log(JSON.stringify(analysis, null, 2));
  } else {
    process.stdout.write(formatReport(analysis));
  }

  if (analysis.moreRunsNeeded) {
    process.stderr.write(
      `cache-verdict: not enough samples yet in ${ledger}; run the build again before gating CI\n`,
    );
    return 3;
  }
  if (analysis.policyFailures.length > 0) {
    for (const failure of analysis.policyFailures) {
      process.stderr.write(`cache-verdict: ${failure.message}\n`);
    }
    return 4;
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
