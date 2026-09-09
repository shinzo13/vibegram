/**
 * The presence heartbeat loop: the MCP server keeps an alive-but-idle session
 * marked online by beating on a timer, since nothing else does between turns.
 *
 * Run: npm run test:heartbeat
 */
import { heartbeatLoop } from '../src/mcp.ts';

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || detail === '' ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── beats once immediately, then on the interval ──────────────────────────
let beats = 0;
const loop = heartbeatLoop(() => {
  beats += 1;
}, 20);

await wait(5);
check('beats once on start', beats === 1, beats);

await wait(75);
check('repeats on the interval', beats >= 3, beats);

// ── stop() ends it ───────────────────────────────────────────────────────
loop.stop();
const atStop = beats;
await wait(60);
check('stop() halts further beats', beats === atStop, { atStop, now: beats });

// ── a failing beat does not kill the loop ────────────────────────────────
let tries = 0;
const flaky = heartbeatLoop(() => {
  tries += 1;
  throw new Error('hub unreachable');
}, 20);
await wait(75);
flaky.stop();
check('a throwing beat keeps the loop running', tries >= 3, tries);

// ── an async beat that rejects is also swallowed ─────────────────────────
let asyncTries = 0;
const asyncFlaky = heartbeatLoop(async () => {
  asyncTries += 1;
  throw new Error('timeout');
}, 20);
await wait(55);
asyncFlaky.stop();
check('a rejected async beat keeps the loop running', asyncTries >= 2, asyncTries);

console.log(failures === 0 ? '\nheartbeat loop behaves' : `\nfailed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
