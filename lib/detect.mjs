import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Canonical ids are the ones written to .cache-verdict.json. The aliases exist
 * because people reasonably type "next", "rust", or "node" at the prompt.
 */
const ECOSYSTEM_ALIASES = new Map([
  ['nextjs', 'nextjs'],
  ['next', 'nextjs'],
  ['next.js', 'nextjs'],
  ['cargo', 'cargo'],
  ['gradle', 'gradle'],
  ['go', 'go'],
  ['golang', 'go'],
  ['python', 'python'],
  ['py', 'python'],
  ['pip', 'python'],
  ['npm', 'npm'],
  ['node', 'npm'],
  ['nodejs', 'npm'],
  ['node.js', 'npm'],
]);

const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];

function statIsFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function unique(values) {
  return values.filter(
    (value, index) =>
      typeof value === 'string' && value.length > 0 && values.indexOf(value) === index,
  );
}

function present(ctx, names) {
  return names.filter((name) => ctx.exists(name));
}

function createContext(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read directory ${directory}: ${error.message}`);
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  let packageState;

  const ctx = {
    directory,

    has(name) {
      return byName.has(name);
    },

    isFile(name) {
      const entry = byName.get(name);
      if (!entry) return false;
      if (entry.isFile()) return true;
      // Follow symlinks only when we can prove they point at a regular file.
      if (entry.isSymbolicLink()) return statIsFile(path.join(directory, name));
      return false;
    },

    isDirectory(name) {
      const entry = byName.get(name);
      return entry !== undefined && entry.isDirectory();
    },

    exists(relativePath) {
      return statIsFile(path.join(directory, ...relativePath.split('/')));
    },

    list() {
      return [...byName.keys()].sort();
    },

    packageJson() {
      if (packageState !== undefined) return packageState.value;
      packageState = { value: null, error: null };

      if (!ctx.isFile('package.json')) return null;

      try {
        const text = readFileSync(path.join(directory, 'package.json'), 'utf8').replace(
          /^\uFEFF/,
          '',
        );
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('package.json must contain a JSON object');
        }
        packageState = { value: parsed, error: null };
      } catch (error) {
        packageState = { value: null, error };
      }

      return packageState.value;
    },

    packageJsonError() {
      ctx.packageJson();
      return packageState.error;
    },
  };

  return ctx;
}

function packageManager(ctx) {
  if (ctx.exists('bun.lock') || ctx.exists('bun.lockb')) return 'bun';
  if (ctx.exists('pnpm-lock.yaml')) return 'pnpm';
  if (ctx.exists('yarn.lock')) return 'yarn';
  return 'npm';
}

function installCommand(ctx, manager) {
  if (manager === 'npm') {
    return ctx.exists('package-lock.json') || ctx.exists('npm-shrinkwrap.json')
      ? 'npm ci'
      : 'npm install';
  }
  if (manager === 'pnpm') {
    return ctx.exists('pnpm-lock.yaml') ? 'pnpm install --frozen-lockfile' : 'pnpm install';
  }
  if (manager === 'yarn') {
    return ctx.exists('yarn.lock') ? 'yarn install --frozen-lockfile' : 'yarn install';
  }
  return ctx.exists('bun.lock') || ctx.exists('bun.lockb')
    ? 'bun install --frozen-lockfile'
    : 'bun install';
}

function hasBuildScript(pkg) {
  return typeof pkg?.scripts?.build === 'string' && pkg.scripts.build.trim().length > 0;
}

function nextBuildCommand(ctx, pkg) {
  const manager = packageManager(ctx);
  if (hasBuildScript(pkg)) {
    return `${manager} run build`;
  }

  if (manager === 'pnpm') return 'pnpm exec next build';
  if (manager === 'yarn') return 'yarn next build';
  if (manager === 'bun') return 'bunx next build';
  return 'npx next build';
}

/**
 * Find Gradle subprojects below the root. Multi-module builds keep each
 * module's output in its own build/ directory, so a single top-level
 * "build" path would miss most of the artifacts being measured.
 */
function gradleSubprojectDirs(root, maxDepth = 3) {
  const skip = new Set([
    'node_modules',
    '.git',
    '.gradle',
    '.idea',
    '.vscode',
    'build',
    'out',
    'target',
  ]);
  const found = new Set();

  function walk(relative, depth) {
    let entries;
    try {
      entries = readdirSync(path.join(root, ...relative.split('/').filter(Boolean)), {
        withFileTypes: true,
      });
    } catch {
      return;
    }

    if (relative !== '') {
      const names = new Set(entries.map((entry) => entry.name));
      if (names.has('build.gradle') || names.has('build.gradle.kts')) {
        found.add(relative);
      }
    }

    if (depth >= maxDepth) return;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      walk(child, depth + 1);
    }
  }

  walk('', 0);
  return [...found].sort();
}

const PACKAGE_MANAGER_NOTES = {
  npm: "npm's download cache defaults to ~/.npm; set npm_config_cache=.npm in CI to keep it project-local and measurable.",
  pnpm: 'pnpm keeps its content-addressable store outside node_modules; set the store directory inside .pnpm-store if restores should be measured.',
  yarn: 'Yarn keeps its cache under .yarn/cache when global caching is disabled; configure that to make restores measurable.',
  bun: 'Bun caches packages globally by default; point its cache inside the project if restores should be measured.',
};

const ECOSYSTEMS = [
  {
    id: 'nextjs',
    displayName: 'Next.js',
    markers: ['package.json with a next dependency or build script', 'next.config.js'],
    detect(ctx) {
      const pkg = ctx.packageJson();
      const configFiles = ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts'].filter(
        (name) => ctx.isFile(name),
      );

      const dependencyFields = [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ];
      const hasNextDependency = dependencyFields.some(
        (field) =>
          pkg !== null &&
          pkg[field] !== null &&
          typeof pkg[field] === 'object' &&
          Object.prototype.hasOwnProperty.call(pkg[field], 'next'),
      );

      const scripts = pkg?.scripts ?? {};
      const usesNextScript =
        (typeof scripts.build === 'string' && /\bnext\s+build\b/.test(scripts.build)) ||
        (typeof scripts.dev === 'string' && /\bnext\s+dev\b/.test(scripts.dev));

      if (!hasNextDependency && configFiles.length === 0 && !usesNextScript) return null;

      const manager = packageManager(ctx);
      const notes = [
        'Next.js stores build output in .next/cache; this path is measured.',
      ];
      if (manager !== 'npm') {
        notes.push(`Detected a ${manager} lockfile; the command uses ${manager}.`);
      }
      if (!hasBuildScript(pkg)) {
        notes.push(
          'No usable "build" script was found; the command invokes Next.js directly. Edit it if the project builds differently.',
        );
      }
      const packageError = ctx.packageJsonError();
      if (packageError) {
        notes.push(`Could not parse package.json (${packageError.message}); review command and inputs.`);
      }

      const detectedFrom = unique([
        ...(ctx.isFile('package.json') ? ['package.json'] : []),
        ...configFiles,
      ]);

      return {
        command: nextBuildCommand(ctx, pkg),
        inputs: unique([
          ...present(ctx, [
            'package.json',
            ...LOCKFILES,
            ...configFiles,
            'tsconfig.json',
            'jsconfig.json',
            'middleware.ts',
            'middleware.js',
            'postcss.config.js',
            'postcss.config.mjs',
            'tailwind.config.js',
            'tailwind.config.ts',
            'babel.config.js',
            '.babelrc',
          ]),
          'app/**',
          'pages/**',
          'src/**',
          'public/**',
        ]),
        cachePath: ['.next/cache'],
        detectedFrom,
        notes,
      };
    },
  },
  {
    id: 'cargo',
    displayName: 'Cargo',
    markers: ['Cargo.toml'],
    detect(ctx) {
      if (!ctx.isFile('Cargo.toml')) return null;

      return {
        command: 'cargo build',
        inputs: unique([
          ...present(ctx, [
            'Cargo.toml',
            'Cargo.lock',
            'rust-toolchain',
            'rust-toolchain.toml',
            'build.rs',
            '.cargo/config.toml',
            '.cargo/config',
          ]),
          'src/**',
          'tests/**',
          'benches/**',
          'examples/**',
        ]),
        cachePath: ['target'],
        detectedFrom: ['Cargo.toml'],
        notes: [
          'Cargo writes build artifacts to target/. Keep CARGO_TARGET_DIR unset so this path is measured.',
        ],
      };
    },
  },
  {
    id: 'gradle',
    displayName: 'Gradle',
    markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
    detect(ctx) {
      const buildFiles = [
        'build.gradle',
        'build.gradle.kts',
        'settings.gradle',
        'settings.gradle.kts',
      ].filter((name) => ctx.isFile(name));
      if (buildFiles.length === 0) return null;

      const hasWrapper = ctx.exists('gradlew') || ctx.exists('gradlew.bat');
      const command = hasWrapper
        ? process.platform === 'win32'
          ? 'gradlew.bat build'
          : './gradlew build'
        : 'gradle build';

      const notes = [
        'Gradle keeps dependency caches in GRADLE_USER_HOME (~/.gradle by default); set it inside the project if those restores should be measured.',
      ];
      if (!hasWrapper) {
        notes.push('No Gradle wrapper was found; ensure "gradle" is on PATH before sampling.');
      }

      const subprojects = gradleSubprojectDirs(ctx.directory);
      if (subprojects.length > 0) {
        notes.push(
          `Measured subproject build directories: ${subprojects.map((dir) => `${dir}/build`).join(', ')}.`,
        );
      }

      return {
        command,
        inputs: unique([
          ...present(ctx, [
            ...buildFiles,
            'gradle.properties',
            'gradle.lockfile',
            'gradle/libs.versions.toml',
            'gradle/wrapper/gradle-wrapper.properties',
            'gradlew',
            'gradlew.bat',
          ]),
          'buildSrc/**/*',
          'gradle/**',
          'src/**/*.java',
          'src/**/*.kt',
          'src/**/*.kts',
          'src/**/*.groovy',
          ...subprojects.map((dir) => `${dir}/**`),
        ]),
        cachePath: unique([
          '.gradle',
          'build',
          ...subprojects.map((dir) => `${dir}/build`),
        ]),
        detectedFrom: buildFiles,
        notes,
      };
    },
  },
  {
    id: 'go',
    displayName: 'Go',
    markers: ['go.mod', 'go.work'],
    detect(ctx) {
      const detectedFrom = present(ctx, ['go.mod', 'go.work']);
      if (detectedFrom.length === 0) return null;

      return {
        command: 'go build ./...',
        inputs: unique([
          ...present(ctx, ['go.mod', 'go.sum', 'go.work', 'go.work.sum', 'vendor/modules.txt']),
          '*.go',
          'cmd/**',
          'internal/**',
          'pkg/**',
          '**/*.go',
        ]),
        cachePath: ['$GOCACHE'],
        detectedFrom,
        notes: [
          'Go stores build artifacts in $GOCACHE, which defaults outside the project. Set $GOCACHE to an absolute path inside .cache/go-build before sampling.',
        ],
      };
    },
  },
  {
    id: 'python',
    displayName: 'Python',
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile', 'manage.py'],
    detect(ctx) {
      const markerFiles = [
        'pyproject.toml',
        'requirements.txt',
        'setup.py',
        'setup.cfg',
        'Pipfile',
        'manage.py',
      ];
      const requirementFiles = ctx
        .list()
        .filter((name) => /^requirements.*\.txt$/.test(name) && ctx.isFile(name));
      const detectedFrom = unique([...present(ctx, markerFiles), ...requirementFiles]);
      if (detectedFrom.length === 0) return null;

      let command;
      const notes = [];
      if (ctx.exists('pyproject.toml') || ctx.exists('setup.py') || ctx.exists('setup.cfg')) {
        command = 'python -m build';
        notes.push(
          'The "build" package is required for python -m build (pip install build); edit the command if the project uses Poetry, PDM, uv, or Hatch.',
        );
      } else if (ctx.exists('Pipfile')) {
        command = 'pipenv install --dev';
        notes.push(
          'Pipenv creates a project-local virtualenv; review .venv below if it uses a different location.',
        );
      } else if (requirementFiles.length > 0) {
        command = 'python -m compileall -q .';
        notes.push(
          'No packaging metadata was found; compile sources with compileall so samples are comparable without installing dependencies. Use --command to time the real build instead.',
        );
      } else {
        command = 'python -m pip install .';
        notes.push(
          'Only manage.py was found; review the command and add the dependency manifest for this project.',
        );
      }

      return {
        command,
        inputs: unique([
          ...present(ctx, [
            ...markerFiles,
            'Pipfile.lock',
            'poetry.lock',
            'pdm.lock',
            'uv.lock',
            'requirements-dev.txt',
            'requirements-test.txt',
            'tox.ini',
          ]),
          'requirements*.txt',
          '*.py',
          'src/**',
          'app/**',
          'tests/**',
        ]),
        cachePath: [
          '.venv',
          'build',
          'dist',
          '.pytest_cache',
          '.mypy_cache',
          '.ruff_cache',
          '**/__pycache__',
        ],
        detectedFrom,
        notes,
      };
    },
  },
  {
    id: 'npm',
    displayName: 'npm',
    markers: ['package.json'],
    detect(ctx) {
      if (!ctx.isFile('package.json')) return null;

      const manager = packageManager(ctx);
      const pkg = ctx.packageJson();
      const notes = [PACKAGE_MANAGER_NOTES[manager]];
      const packageError = ctx.packageJsonError();
      if (packageError) {
        notes.push(`Could not parse package.json (${packageError.message}); review command and inputs.`);
      }
      if (!hasBuildScript(pkg)) {
        notes.push(
          'No usable "build" script was found; the command installs dependencies instead. Use --command to time the real build.',
        );
      }

      return {
        command: hasBuildScript(pkg) ? `${manager} run build` : installCommand(ctx, manager),
        inputs: unique([
          ...present(ctx, [
            'package.json',
            ...LOCKFILES,
            '.npmrc',
            '.yarnrc.yml',
            'pnpm-workspace.yaml',
            'tsconfig.json',
            'jsconfig.json',
            'vite.config.js',
            'vite.config.mjs',
            'vite.config.ts',
            'webpack.config.js',
            'webpack.config.mjs',
            'webpack.config.ts',
            'rollup.config.js',
            'rollup.config.mjs',
            'rollup.config.ts',
          ]),
          '*.js',
          '*.mjs',
          '*.cjs',
          '*.ts',
          '*.tsx',
          '*.jsx',
          'src/**',
          'lib/**',
          'bin/**',
          'scripts/**',
        ]),
        cachePath: ['node_modules/.cache'],
        detectedFrom: ['package.json'],
        notes,
      };
    },
  },
];

export function supportedEcosystemIds() {
  return ECOSYSTEMS.map((ecosystem) => ecosystem.id);
}

export function normalizeEcosystem(value) {
  if (typeof value !== 'string') return null;
  return ECOSYSTEM_ALIASES.get(value.trim().toLowerCase()) ?? null;
}

export function isSupportedEcosystem(value) {
  return normalizeEcosystem(value) !== null;
}

/**
 * Detect the build systems present in a directory.
 *
 * @param {string} directory absolute or relative directory to inspect
 * @param {{ ecosystem?: string | null }} [options] force one detector by id/alias
 * @returns {{
 *   ecosystem: string,
 *   displayName: string,
 *   command: string,
 *   inputs: string[],
 *   cachePath: string[],
 *   detectedFrom: string[],
 *   notes: string[],
 *   alternatives: Array<{ ecosystem: string, displayName: string, command: string, detectedFrom: string[] }>,
 * }}
 */
export function detectProject(directory, options = {}) {
  const ctx = createContext(directory);
  const matches = [];

  for (const ecosystem of ECOSYSTEMS) {
    const details = ecosystem.detect(ctx);
    if (details !== null) {
      matches.push({
        ecosystem: ecosystem.id,
        displayName: ecosystem.displayName,
        command: details.command,
        inputs: details.inputs,
        cachePath: details.cachePath,
        detectedFrom: details.detectedFrom,
        notes: details.notes,
      });
    }
  }

  let selected;
  const requested = options.ecosystem;

  if (requested !== undefined && requested !== null) {
    const ecosystemId = normalizeEcosystem(requested);
    if (ecosystemId === null) {
      throw new Error(
        `unsupported ecosystem "${requested}"; choose one of: ${supportedEcosystemIds().join(', ')}`,
      );
    }

    selected = matches.find((match) => match.ecosystem === ecosystemId);
    if (selected === undefined) {
      const definition = ECOSYSTEMS.find((ecosystem) => ecosystem.id === ecosystemId);
      throw new Error(
        `no ${definition.displayName} project detected in ${directory} (looked for ${definition.markers.join(', ')})`,
      );
    }
  } else {
    selected = matches[0];
    if (selected === undefined) {
      throw new Error(
        `no supported build system found in ${directory}; looked for Cargo, Gradle, Next.js, npm, Python, and Go manifests`,
      );
    }
  }

  const alternatives = matches
    .filter((match) => match !== selected)
    .map((match) => ({
      ecosystem: match.ecosystem,
      displayName: match.displayName,
      command: match.command,
      detectedFrom: match.detectedFrom,
    }));

  return { ...selected, alternatives };
}
