#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

const USAGE = `cache-verdict: a small developer tool

Usage:
  cache-verdict --help
  cache-verdict --version

MVP features:
  - cache-verdict init detects Cargo, Gradle, Next.js, npm, Python, or Go and writes a reviewable .cache-verdict.json.
  - cache-verdict run content-addresses the declared inputs, moves declared cache dirs aside, times the build from a known state, and records key, hit/miss, cold/warm, size, and restore cost in a JSONL ledger.
  - cache-verdict report prints hit rate, median cold vs warm totals, restore cost, net ms per hit, cache size, and one verdict: cache-pays, cache-costs, cache-churns, cache-never-hits, or cache-unobserved.
  - cache-verdict check exits 2 on a losing, churning, or unobserved cache and 3 when more runs are needed, so CI can gate on the verdict.
  - cache-verdict prune --keep N evicts least-recently-used stored keys; run --cold adds a baseline sample without wedging the next hit.
`;

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
} else {
  console.log(USAGE);
}
