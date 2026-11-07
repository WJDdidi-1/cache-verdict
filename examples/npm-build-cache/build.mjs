// A deliberately simple build: derive an artifact from src/input.txt, keep it
// in node_modules/.cache, and spend 700 ms of "compile" time only on a cold
// cache. That gap is what cache-verdict measures.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync('src/input.txt', 'utf8');
const digest = createHash('sha256').update(source).digest('hex').slice(0, 12);
const cached = `node_modules/.cache/${digest}.txt`;

if (existsSync(cached)) {
  console.log(`warm build: reusing cached artifact ${digest}`);
} else {
  console.log(`cold build: computing ${digest} (this is the slow part)`);
  const until = Date.now() + 700;
  while (Date.now() < until) {
    // Stand-in for real compilation work.
  }
  mkdirSync('node_modules/.cache', { recursive: true });
  writeFileSync(cached, `${digest}: ${source.trim().length} characters of input\n`);
}

mkdirSync('dist', { recursive: true });
writeFileSync('dist/result.txt', readFileSync(cached));
console.log('wrote dist/result.txt');
