// Every CI job on the tagged commit must have a verdict before anything ships.
//
// 2026-11-11: flake-ledger 0.6.0 was published from a commit whose four Windows
// jobs were failing, because publish.yml only ran its own ubuntu job and never
// asked GitHub about the commit. "Tests pass here" is not "the release works".
//
// Rules:
//   - no check run on the commit at all          -> refuse (nothing verified it)
//   - any check still queued or in progress      -> refuse (no verdict yet)
//   - any check failed / timed out               -> refuse
//   - any check cancelled after its job started  -> refuse
//   - cancelled with no runner ever acquired     -> warn (GitHub capacity)
// A skipped check is a deliberate matrix decision, not a failure.
import process from 'node:process';

const REPO = process.env.GITHUB_REPOSITORY;
const SHA = process.env.GITHUB_SHA;
const SELF = String(process.env.GITHUB_RUN_ID ?? '');
const TOKEN = process.env.GH_TOKEN;
const API = 'https://api.github.com';

const FAILING = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const PASSING = new Set(['success', 'neutral', 'skipped']);

async function api(path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}`);
  return res.json();
}

function runIdOf(run) {
  const match = /\/actions\/runs\/(\d+)/u.exec(String(run.html_url ?? run.details_url ?? ''));
  return match === null ? null : match[1];
}

async function capacityCancelled(run) {
  const id = runIdOf(run);
  if (id === null) return false;
  try {
    const jobs = await api(`/repos/${REPO}/actions/runs/${id}/jobs?per_page=100`);
    const job = (jobs.jobs ?? []).find((item) => item.name === run.name);
    if (job === undefined) return false;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    return steps.length === 0 && (job.runner_name === '' || job.runner_name == null);
  } catch {
    return false;
  }
}

const runs = [];
for (let page = 1; page <= 20; page += 1) {
  const data = await api(`/repos/${REPO}/commits/${SHA}/check-runs?per_page=100&page=${page}`);
  runs.push(...(data.check_runs ?? []));
  if (runs.length >= (data.total_count ?? 0) || (data.check_runs ?? []).length === 0) break;
}

const foreign = runs.filter((run) => SELF === '' || runIdOf(run) !== SELF);
if (foreign.length === 0) {
  console.error(`publish gate: no check run has looked at ${SHA}; refusing to publish`);
  process.exit(1);
}

const pending = [];
const blocking = [];
const capacity = [];
const green = [];

for (const run of foreign) {
  if (run.conclusion == null) {
    pending.push(run.name);
    continue;
  }
  if (FAILING.has(run.conclusion)) {
    blocking.push(`${run.name}: ${run.conclusion}`);
    continue;
  }
  if (run.conclusion === 'cancelled') {
    if (await capacityCancelled(run)) capacity.push(run.name);
    else blocking.push(`${run.name}: cancelled after it started`);
    continue;
  }
  if (PASSING.has(run.conclusion)) green.push(run.name);
  else blocking.push(`${run.name}: ${run.conclusion}`);
}

if (blocking.length > 0) {
  console.error(`publish gate: the commit is not green: ${blocking.join(', ')}`);
  process.exit(1);
}
if (pending.length > 0) {
  console.error(`publish gate: still being checked: ${pending.join(', ')}`);
  process.exit(1);
}
console.log(`publish gate: ${green.length} check(s) green on ${SHA.slice(0, 8)}${capacity.length > 0 ? `, ${capacity.length} skipped for runner capacity (${capacity.join(', ')})` : ''}`);
