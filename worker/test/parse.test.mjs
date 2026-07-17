// Run: node worker/test/parse.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseIcs } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const ics = readFileSync(join(here, 'fixture.ics'), 'utf8');

const result = parseIcs(ics, '2026-07-17');

const expected = [
  { start: '2026-08-01', end: '2026-08-03' }, // normal 2-night
  { start: '2026-08-10', end: '2026-08-11' }, // missing DTEND → 1 night
  { start: '2026-09-02', end: '2026-09-06' }, // dupe UID, last wins
  // past-event excluded
];

const pass = JSON.stringify(result) === JSON.stringify(expected);
console.log(pass ? 'PASS' : 'FAIL');
if (!pass) {
  console.log('expected:', JSON.stringify(expected, null, 2));
  console.log('actual:  ', JSON.stringify(result, null, 2));
  process.exit(1);
}
