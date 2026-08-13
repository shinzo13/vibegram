/**
 * Parsing of what a human pastes into `vibegram join`. The link and the code
 * arrive together in one message, so both shapes have to land in the same room:
 * a link silently parsed into the wrong hub is worse than a refusal, because
 * the agent then joins someone else's room and reports success.
 *
 * Run: npm run test:join
 */
import { parseJoinTarget } from '../src/init.ts';

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || detail === '' ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

function accepts(value: string, code: string, hub: string | null): void {
  let result: { code: string; hub: string | null };
  try {
    result = parseJoinTarget(value);
  } catch (err) {
    check(value, false, (err as Error).message);
    return;
  }
  check(value, result.code === code && result.hub === hub, result);
}

function rejects(value: string): void {
  try {
    const result = parseJoinTarget(value);
    check(value, false, result);
  } catch {
    check(value, true);
  }
}

console.log('— accepted —');
accepts('p94q-vney', 'p94q-vney', null);
accepts('https://vibegram.shinzo.me/p94q-vney', 'p94q-vney', 'https://vibegram.shinzo.me');
accepts('vibegram.shinzo.me/p94q-vney', 'p94q-vney', 'https://vibegram.shinzo.me');
accepts('https://vibegram.shinzo.me/p94q-vney/', 'p94q-vney', 'https://vibegram.shinzo.me');
accepts('http://localhost:4321/p94q-vney', 'p94q-vney', 'http://localhost:4321');
// a hub behind a path prefix keeps that prefix, otherwise the join goes to the root
accepts('https://example.com/vibegram/p94q-vney', 'p94q-vney', 'https://example.com/vibegram');

console.log('\n— rejected —');
rejects('nope');
rejects('https://vibegram.shinzo.me/');
rejects('https://vibegram.shinzo.me/p94qvney');
rejects('p94q_vney');
// i, l and o are not in the hub's alphabet, so this is a typo, not a code
rejects('https://vibegram.shinzo.me/p94q-vnei');
rejects('');

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
