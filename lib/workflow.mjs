import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const WORKFLOW_DIRECTORY = '.github/workflows';
export const WORKFLOW_FILENAME = 'cache-verdict.yml';
export const WORKFLOW_PATH = `${WORKFLOW_DIRECTORY}/${WORKFLOW_FILENAME}`;
export const WORKFLOW_LEDGER = '.ci/cache-verdict/ledger.jsonl';
export const WORKFLOW_STORE = '.cache-verdict/store';

function hasFile(directory, names) {
  return names.some((name) => {
    try {
      return statSync(path.join(directory, name)).isFile();
    } catch {
      return false;
    }
  });
}

function packageManager(directory) {
  if (hasFile(directory, ['bun.lock', 'bun.lockb'])) return 'bun';
  if (hasFile(directory, ['pnpm-lock.yaml'])) return 'pnpm';
  if (hasFile(directory, ['yarn.lock'])) return 'yarn';
  return 'npm';
}

function nodeInstallSteps(directory, command) {
  const manager = packageManager(directory);

  if (manager === 'npm') {
    const install = hasFile(directory, ['package-lock.json', 'npm-shrinkwrap.json'])
      ? 'npm ci'
      : 'npm install';
    // If the measured command is the install itself, installing first would
    // hide the work the sample is meant to time.
    if (command.trim() === install) return [];
    return [{ name: 'Install project dependencies', run: install }];
  }

  if (manager === 'pnpm') {
    return [
      {
        name: 'Install project dependencies',
        run: 'corepack enable\npnpm install --frozen-lockfile',
      },
    ];
  }

  if (manager === 'yarn') {
    return [
      {
        name: 'Install project dependencies',
        run: 'corepack enable\nyarn install --frozen-lockfile',
      },
    ];
  }

  return [
    { uses: 'oven-sh/setup-bun@v2' },
    { name: 'Install project dependencies', run: 'bun install --frozen-lockfile' },
  ];
}

function ecosystemSetupSteps(directory, detection, options) {
  if (detection.ecosystem === 'nextjs' || detection.ecosystem === 'npm') {
    return nodeInstallSteps(directory, options.command);
  }
  if (detection.ecosystem === 'python') {
    return [{ uses: 'actions/setup-python@v5', with: { 'python-version': '3.x' } }];
  }
  if (detection.ecosystem === 'go') {
    return [{ uses: 'actions/setup-go@v5', with: { 'go-version': 'stable' } }];
  }
  // Cargo, Gradle, and Java are preinstalled on GitHub-hosted runners. A
  // project-specific toolchain action can be added by hand after review.
  return [];
}

function renderWith(entries, indent) {
  const lines = [`${indent}with:`];
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      lines.push(`${indent}  ${key}: |`);
      for (const line of value) lines.push(`${indent}    ${line}`);
    } else {
      lines.push(`${indent}  ${key}: ${value}`);
    }
  }
  return lines;
}

function renderStep(step, indent) {
  const lines = [];
  if (step.name) {
    lines.push(`${indent}- name: ${step.name}`);
    if (step.uses) lines.push(`${indent}  uses: ${step.uses}`);
  } else {
    lines.push(`${indent}- uses: ${step.uses}`);
  }
  if (step.with) lines.push(...renderWith(step.with, `${indent}  `));
  if (step.run) {
    const runLines = String(step.run).split('\n');
    lines.push(`${indent}  run: ${runLines.length === 1 ? runLines[0] : '|'}`);
    if (runLines.length > 1) {
      for (const line of runLines) lines.push(`${indent}    ${line}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render the GitHub Actions workflow that carries the ledger and stored cache
 * between runs. The workflow is generated from the same detection result as
 * `.cache-verdict.json`, so an npm project gets its lockfile-aware install
 * step while Cargo, Gradle, and Go use the runner's preinstalled toolchains.
 *
 * @param {string} directory absolute project directory
 * @param {ReturnType<import('./detect.mjs').detectProject>} detection
 * @param {{ version: string, command: string }} options
 */
export function renderGithubWorkflow(directory, detection, options) {
  if (typeof options?.version !== 'string' || options.version.trim() === '') {
    throw new Error('cannot render a workflow without a cache-verdict version');
  }
  if (typeof options.command !== 'string' || options.command.trim() === '') {
    throw new Error('cannot render a workflow without a build command');
  }
  const version = options.version.trim();
  const setupSteps = ecosystemSetupSteps(directory, detection, options);

  const steps = [
    { uses: 'actions/checkout@v4' },
    { uses: 'actions/setup-node@v4', with: { 'node-version': 22 } },
    ...setupSteps,
    {
      name: 'Restore the cache-verdict ledger and stored cache',
      uses: 'actions/cache@v4',
      with: {
        path: [WORKFLOW_LEDGER, WORKFLOW_STORE],
        key: 'cache-verdict-${{ github.ref_name }}-${{ github.run_id }}-${{ github.run_attempt }}',
        'restore-keys': ['cache-verdict-${{ github.ref_name }}-'],
      },
    },
    {
      name: 'cache-verdict run',
      run: `npx --yes cache-verdict@${version} run`,
    },
    {
      name: 'cache-verdict check',
      run: [
        'set +e',
        `npx --yes cache-verdict@${version} check`,
        'status=$?',
        'set -e',
        'if [ "$status" -eq 3 ]; then',
        '  echo "::notice::cache-verdict needs another build before it can decide"',
        '  exit 0',
        'fi',
        'exit "$status"',
      ].join('\n'),
    },
  ];

  const rendered = steps.map((step) => renderStep(step, '      ')).join('\n\n');

  return `# Generated by \`cache-verdict init --github-action\`.
# Review the install and build steps, then commit this file with
# .cache-verdict.json. The ledger lives at ${WORKFLOW_LEDGER} so it
# survives between builds; the local default is .cache-verdict/ledger.jsonl.
name: cache-verdict gate

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  cache-verdict:
    runs-on: ubuntu-latest
    env:
      CACHE_VERDICT_LEDGER: ${WORKFLOW_LEDGER}
    steps:
${rendered}
`;
}

export function workflowTarget(directory) {
  return path.join(directory, ...WORKFLOW_DIRECTORY.split('/'), WORKFLOW_FILENAME);
}

function inspectTarget(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`cannot inspect ${target}: ${error.message}`);
  }
}

/**
 * Fail before either generated file is written when the workflow already
 * exists and --force was not passed.
 *
 * @param {string} directory
 * @param {{ force?: boolean }} [options]
 */
export function assertWorkflowWritable(directory, options = {}) {
  const target = workflowTarget(directory);
  const existing = inspectTarget(target);
  if (existing === undefined) return target;

  if (existing.isDirectory()) {
    throw new Error(`cannot overwrite ${target}: it is a directory`);
  }
  if (options.force !== true) {
    throw new Error(
      `refusing to overwrite existing ${WORKFLOW_PATH} in ${directory}; use --force to replace it`,
    );
  }
  return target;
}

/**
 * Write the generated workflow atomically so a partial file is never left
 * behind. The target directory is created for the first workflow.
 *
 * @param {string} directory
 * @param {string} contents
 * @param {{ force?: boolean }} [options]
 * @returns {string} the path that was written
 */
export function writeWorkflow(directory, contents, options = {}) {
  const target = assertWorkflowWritable(directory, options);
  const temp = path.join(
    path.dirname(target),
    `.${WORKFLOW_FILENAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(temp, contents, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
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
