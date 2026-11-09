import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cache-verdict.mjs');

function makeProject(t, files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cache-verdict-init-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return dir;
}

function runInit(cwd, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [bin, 'init', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
    };
  }
}

function readConfig(dir) {
  return JSON.parse(readFileSync(path.join(dir, '.cache-verdict.json'), 'utf8'));
}

function configPath(dir) {
  return path.join(dir, '.cache-verdict.json');
}

test('init describes a Cargo project and writes reviewable JSON', (t) => {
  const dir = makeProject(t, {
    'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\n',
    'Cargo.lock': '# lockfile\n',
    'build.rs': 'fn main() {}\n',
    'src/main.rs': 'fn main() {}\n',
  });

  const result = runInit(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(configPath(dir)));

  const config = readConfig(dir);
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.ecosystem, 'cargo');
  assert.equal(config.command, 'cargo build');
  assert.deepEqual(config.cachePath, ['target']);
  assert.deepEqual(config.detectedFrom, ['Cargo.toml']);
  assert.ok(config.inputs.includes('Cargo.toml'));
  assert.ok(config.inputs.includes('Cargo.lock'));
  assert.ok(config.inputs.includes('build.rs'));
  assert.ok(config.inputs.includes('src/**'));

  const text = readFileSync(configPath(dir), 'utf8');
  assert.ok(text.endsWith('\n'), 'config should end with a newline');
  assert.deepEqual(config, JSON.parse(text));
});

test('init prefers Next.js over the generic npm detector', (t) => {
  const dir = makeProject(t, {
    'package.json': JSON.stringify({
      name: 'site',
      scripts: { build: 'next build' },
      dependencies: { next: '15.0.0', react: '19.0.0' },
    }),
    'next.config.mjs': 'export default {};\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'app/page.tsx': 'export default function Page() { return null; }\n',
  });

  const result = runInit(dir);
  assert.equal(result.status, 0, result.stderr);

  const config = readConfig(dir);
  assert.equal(config.ecosystem, 'nextjs');
  assert.equal(config.displayName, 'Next.js');
  assert.equal(config.command, 'npm run build');
  assert.deepEqual(config.cachePath, ['.next/cache']);
  assert.ok(config.inputs.includes('app/**'));
  assert.ok(config.inputs.includes('next.config.mjs'));
  assert.ok(config.inputs.includes('package-lock.json'));
  assert.match(result.stdout, /Also detected: npm/);
});

test('init describes a plain npm project using its lockfile package manager', (t) => {
  const dir = makeProject(t, {
    'package.json': JSON.stringify({
      name: 'lib',
      scripts: { build: 'tsc -p tsconfig.json' },
    }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'tsconfig.json': '{}\n',
    'src/index.ts': 'export const answer = 42;\n',
  });

  const result = runInit(dir);
  assert.equal(result.status, 0, result.stderr);

  const config = readConfig(dir);
  assert.equal(config.ecosystem, 'npm');
  assert.equal(config.command, 'pnpm run build');
  assert.deepEqual(config.cachePath, ['node_modules/.cache']);
  assert.ok(config.inputs.includes('pnpm-lock.yaml'));
  assert.ok(config.inputs.includes('tsconfig.json'));
  assert.ok(config.inputs.includes('src/**'));
});

test('init describes a Python project and its local caches', (t) => {
  const dir = makeProject(t, {
    'pyproject.toml': '[build-system]\nrequires = ["setuptools"]\n',
    'src/demo/__init__.py': '',
    'tests/test_demo.py': 'def test_it(): pass\n',
  });

  const result = runInit(dir);
  assert.equal(result.status, 0, result.stderr);

  const config = readConfig(dir);
  assert.equal(config.ecosystem, 'python');
  assert.equal(config.command, 'python -m build');
  assert.ok(config.cachePath.includes('.venv'));
  assert.ok(config.cachePath.includes('**/__pycache__'));
  assert.ok(config.inputs.includes('pyproject.toml'));
  assert.ok(config.inputs.includes('src/**'));
  assert.ok(config.inputs.includes('tests/**'));
  assert.ok(config.notes.some((note) => note.includes('"build" package')));
});

test('init falls back to compileall for requirements-only Python projects', (t) => {
  const dir = makeProject(t, {
    'requirements-dev.txt': 'pytest\n',
    'app.py': 'print("hi")\n',
  });

  const result = runInit(dir);
  assert.equal(result.status, 0, result.stderr);

  const config = readConfig(dir);
  assert.equal(config.ecosystem, 'python');
  assert.equal(config.command, 'python -m compileall -q .');
  assert.ok(config.inputs.includes('requirements-dev.txt'));
  assert.ok(config.inputs.includes('*.py'));
});

test('init describes a Go project and flags the shared build cache', (t) => {
  const dir = makeProject(t, {
    'go.mod': 'module example.com/demo\n\ngo 1.22\n',
    'go.sum': '',
    'main.go': 'package main\n\nfunc main() {}\n',
    'cmd/server/main.go': 'package main\n\nfunc main() {}\n',
  });

  const result = runInit(dir);
  assert.equal(result.status, 0, result.stderr);

  const config = readConfig(dir);
  assert.equal(config.ecosystem, 'go');
  assert.equal(config.command, 'go build ./...');
  assert.deepEqual(config.cachePath, ['$GOCACHE']);
  assert.ok(config.inputs.includes('go.sum'));
  assert.ok(config.inputs.includes('*.go'));
  assert.ok(config.inputs.includes('cmd/**'));
  assert.ok(config.notes.some((note) => note.includes('$GOCACHE')));
});

test('init uses the Gradle wrapper and lists subproject build directories', (t) => {
  const dir = makeProject(t, {
    'settings.gradle.kts': 'rootProject.name = "demo"\n',
    'build.gradle.kts': 'plugins {}\n',
    'gradlew': '#!/bin/sh\n',
    'gradlew.bat': '@echo off\r\n',
    'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=https://example.invalid/gradle.zip\n',
    'app/build.gradle.kts': 'plugins {}\n',
  });

  const result = runInit(dir);
  assert.equal(result.status, 0, result.stderr);

  const config = readConfig(dir);
  assert.equal(config.ecosystem, 'gradle');
  assert.equal(config.command, process.platform === 'win32' ? 'gradlew.bat build' : './gradlew build');
  assert.ok(config.cachePath.includes('.gradle'));
  assert.ok(config.cachePath.includes('build'));
  assert.ok(config.cachePath.includes('app/build'));
  assert.ok(config.inputs.includes('app/**'));
  assert.ok(config.inputs.includes('gradle/**'));
});

test('init picks Cargo over npm when both are present and reports the alternative', (t) => {
  const dir = makeProject(t, {
    'Cargo.toml': '[package]\nname = "tauri-app"\n',
    'src/lib.rs': '',
    'package.json': JSON.stringify({ scripts: { build: 'vite build' } }),
  });

  const result = runInit(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readConfig(dir).ecosystem, 'cargo');
  assert.match(result.stdout, /Also detected: npm/);
});

test('--ecosystem overrides detection priority', (t) => {
  const dir = makeProject(t, {
    'go.mod': 'module example.com/demo\n',
    'main.go': 'package main\n',
    'package.json': JSON.stringify({ scripts: { build: 'node build.js' } }),
  });

  assert.equal(runInit(dir).status, 0);
  assert.equal(readConfig(dir).ecosystem, 'go');

  const result = runInit(dir, ['--ecosystem', 'npm', '--force']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readConfig(dir).ecosystem, 'npm');
  assert.equal(readConfig(dir).command, 'npm run build');
});

test('init refuses to overwrite an existing config without --force', (t) => {
  const dir = makeProject(t, {
    'Cargo.toml': '[package]\nname = "demo"\n',
  });
  const original = '{"keep":"me"}\n';
  writeFileSync(configPath(dir), original);

  const refused = runInit(dir);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--force/);
  assert.equal(readFileSync(configPath(dir), 'utf8'), original);

  const forced = runInit(dir, ['--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(readConfig(dir).ecosystem, 'cargo');
});

test('--dry-run prints the config without writing it', (t) => {
  const dir = makeProject(t, {
    'Cargo.toml': '[package]\nname = "demo"\n',
  });

  const result = runInit(dir, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(configPath(dir)), false);

  const config = JSON.parse(result.stdout);
  assert.equal(config.ecosystem, 'cargo');
  assert.equal(config.command, 'cargo build');
});

test('--command overrides the detected command', (t) => {
  const dir = makeProject(t, {
    'Cargo.toml': '[package]\nname = "demo"\n',
  });

  const result = runInit(dir, ['--command', 'cargo build --release']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readConfig(dir).command, 'cargo build --release');
});

test('init reports an empty directory clearly and writes nothing', (t) => {
  const dir = makeProject(t, {});

  const result = runInit(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no supported build system found/);
  assert.equal(existsSync(configPath(dir)), false);
});

test('init rejects an unknown --ecosystem without writing a config', (t) => {
  const dir = makeProject(t, {
    'Cargo.toml': '[package]\nname = "demo"\n',
  });

  const result = runInit(dir, ['--ecosystem', 'rust']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsupported ecosystem/);
  assert.equal(existsSync(configPath(dir)), false);
});

function workflowPath(dir) {
  return path.join(dir, '.github', 'workflows', 'cache-verdict.yml');
}

test('init --github-action writes a workflow that persists and gates on the ledger', (t) => {
  const dir = makeProject(t, {
    'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\n',
  });

  const result = runInit(dir, ['--github-action']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(configPath(dir)), 'the config should still be written');

  const workflow = readFileSync(workflowPath(dir), 'utf8');
  assert.match(workflow, /uses: actions\/cache@v4/);
  assert.match(workflow, /CACHE_VERDICT_LEDGER: \.ci\/cache-verdict\/ledger\.jsonl/);
  assert.match(workflow, /\.ci\/cache-verdict\/ledger\.jsonl/);
  assert.match(workflow, /\.cache-verdict\/store/);
  assert.match(workflow, /name: cache-verdict run/);
  assert.match(workflow, /npx --yes cache-verdict@\d+\.\d+\.\d+ run/);
  assert.match(workflow, /name: cache-verdict check/);
  assert.match(workflow, /npx --yes cache-verdict@\d+\.\d+\.\d+ check/);
  assert.match(workflow, /if \[ "\$status" -eq 3 \]/);
  assert.match(result.stdout, /cache-verdict\.yml/);
});

test('init without --github-action writes no workflow', (t) => {
  const dir = makeProject(t, {
    'Cargo.toml': '[package]\nname = "demo"\n',
  });

  const result = runInit(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(configPath(dir)));
  assert.equal(existsSync(workflowPath(dir)), false);
});

test('init --github-action adds the detected package manager install step', (t) => {
  const dir = makeProject(t, {
    'package.json': JSON.stringify({
      name: 'site',
      scripts: { build: 'next build' },
      dependencies: { next: '15.0.0' },
    }),
    'package-lock.json': '{"lockfileVersion":3}\n',
    'app/page.tsx': 'export default function Page() { return null; }\n',
  });

  const result = runInit(dir, ['--github-action']);
  assert.equal(result.status, 0, result.stderr);

  const workflow = readFileSync(workflowPath(dir), 'utf8');
  assert.match(workflow, /name: Install project dependencies/);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /uses: actions\/setup-node@v4/);
});

test('init --github-action refuses to overwrite a workflow without --force', (t) => {
  const dir = makeProject(t, {
    'Cargo.toml': '[package]\nname = "demo"\n',
  });
  const target = workflowPath(dir);
  mkdirSync(path.dirname(target), { recursive: true });
  const original = '# reviewed workflow\n';
  writeFileSync(target, original);

  const refused = runInit(dir, ['--github-action']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--force/);
  assert.equal(readFileSync(target, 'utf8'), original);
  assert.equal(existsSync(configPath(dir)), false, 'a refused run must not write the config');

  const forced = runInit(dir, ['--github-action', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(readFileSync(target, 'utf8'), /actions\/cache@v4/);
});

test('init --github-action --dry-run prints both files and writes neither', (t) => {
  const dir = makeProject(t, {
    'Cargo.toml': '[package]\nname = "demo"\n',
  });

  const result = runInit(dir, ['--github-action', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(configPath(dir)), false);
  assert.equal(existsSync(workflowPath(dir)), false);
  assert.match(result.stdout, /"ecosystem": "cargo"/);
  assert.match(result.stdout, /actions\/cache@v4/);
});

test('init --github-action keeps an existing reviewed config and adds the workflow', (t) => {
  const dir = makeProject(t, {
    'Cargo.toml': '[package]\nname = "demo"\n',
  });
  assert.equal(runInit(dir).status, 0);
  const reviewed = readFileSync(configPath(dir), 'utf8');

  const result = runInit(dir, ['--github-action']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(configPath(dir), 'utf8'), reviewed);
  assert.ok(existsSync(workflowPath(dir)));
  assert.match(result.stdout, /Kept .*\.cache-verdict\.json/);
});
