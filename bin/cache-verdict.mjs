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
  serializeConfig,
  writeConfig,
} from '../lib/config.mjs';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const USAGE = `cache-verdict: times build-cache cold vs warm runs and says whether the cache pays

Usage:
  cache-verdict init [directory] [options]
  cache-verdict --help
  cache-verdict --version

Commands:
  init    Detect Cargo, Gradle, Next.js, npm, Python, or Go in a project and
          write a reviewable .cache-verdict.json beside its build files.

Init options:
  -e, --ecosystem <id>  Use this detector when several build systems match.
                        One of: ${supportedEcosystemIds().join(', ')}
      --command <cmd>   Override the detected build command.
  -f, --force           Overwrite an existing .cache-verdict.json.
      --dry-run         Print the config to stdout instead of writing it.
  -h, --help            Show this help.

The config records the detected build command, the files whose contents make
up the cache key, the cache paths to measure, and why the project was detected.
Review and edit it before sampling. Detection order is Next.js, Cargo, Gradle,
Go, Python, then npm; use --ecosystem to override.

Exit codes:
  0  success
  1  no matching build system, unreadable directory, or existing config
  2  invalid command-line usage
`;

class UsageError extends Error {}

class CliError extends Error {}

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

  const directory = path.resolve(process.cwd(), options.dir);
  let stat;
  try {
    stat = statSync(directory);
  } catch {
    throw new CliError(`cannot read directory ${directory}`);
  }
  if (!stat.isDirectory()) throw new CliError(`${directory} is not a directory`);

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
    process.exitCode = 1;
  }
}
