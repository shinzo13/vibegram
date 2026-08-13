/**
 * The claimed scale: ten agents in one room, plus the races the design assumes
 * but that were never actually reproduced.
 *
 * Run: npm run test:load
 */
import { openDb } from '../src/db.ts';
import { createCtx } from '../src/core/index.ts';
import { createHttpServer } from '../src/transport/http.ts';

const ctx = createCtx(openDb(':memory:'));
const server = createHttpServer(ctx);
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as { port: number }).port}`;

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || detail === '' ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

async function call(method: string, path: string, body?: unknown, token?: string): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ─── ten agents ──────────────────────────────────────────────────────────────

const NICKS = [
  'claude-shinrei', 'claude-haikesan', 'chatgpt-nightshelf', 'chatgpt-vermillion',
  'cursor-obsidian', 'cursor-marlow', 'codex-quill', 'codex-fen',
  'claude-tessellate', 'chatgpt-larkspur',
];

const created = await call('POST', '/api/rooms', { name: 'load test' });
const room = created.body.room;
const joinCode = created.body.joinCode as string;

const started = Date.now();
const tokens = await Promise.all(
  NICKS.map(async (nick) => {
    const res = await call('POST', '/api/rooms/join', { joinCode, nick });
    return res.body.token as string;
  }),
);
check('ten agents joined', tokens.every((t) => typeof t === 'string'), tokens.filter((t) => !t).length);
check('joining under a second', Date.now() - started < 1000, `${Date.now() - started} ms`);

// ─── race for a single resource ──────────────────────────────────────────────

const claimRace = await Promise.all(
  tokens.map((token) => call('POST', '/api/claims', { resources: ['src/hot.ts'] }, token)),
);
const winners = claimRace.filter((r) => r.body.ok === true);
check('exactly one wins the file', winners.length === 1, `winners: ${winners.length}`);
check(
  'the rest are told who holds it',
  claimRace.filter((r) => r.body.ok === false).every((r) => typeof r.body.conflicts?.[0]?.heldBy === 'string'),
);

// ─── race to publish the plan ────────────────────────────────────────────────

const proposeRace = await Promise.all(
  tokens.map((token, i) => call('POST', '/api/plan/propose', { items: [`plan from agent ${i}`] }, token)),
);
const published = proposeRace.filter((r) => r.status === 200);
check('exactly one plan published', published.length === 1, `passed: ${published.length}`);

const plan = (await call('GET', `/api/plan?view=${room.viewToken}`)).body;
check('no duplicates from the race', plan.items.length === 1, plan.items.map((i: any) => i.text));
check('revision is one', plan.revision === 1, plan.revision);

// ─── overlapping directories ─────────────────────────────────────────────────

const holder = tokens[0]!;
const other = tokens[1]!;
await call('POST', '/api/claims', { resources: ['src/api/'] }, holder);
const nested = await Promise.all([
  call('POST', '/api/claims', { resources: ['src/api/routes.ts'] }, other),
  call('POST', '/api/claims', { resources: ['src/'] }, other),
  call('POST', '/api/claims', { resources: ['src/api/'] }, other),
]);
check(
  'nested file under a claimed directory is refused',
  nested.every((r) => r.body.ok === false),
  nested.map((r) => r.body.ok),
);

// ─── feed with ten agents talking ────────────────────────────────────────────

const chat = await Promise.all(
  tokens.map((token, i) => call('POST', '/api/messages', { body: `message ${i}` }, token)),
);
check(
  'all ten messages accepted',
  chat.every((r) => r.status === 200),
  chat.filter((r) => r.status !== 200).map((r) => r.body),
);

const pending = await call('GET', '/api/pending?limit=100', undefined, tokens[3]);
const events = pending.body.events as any[];
check('unread contains only other agents', events.every((e) => e.nick !== NICKS[3]));
check(
  'announcements reach everyone',
  events.filter((e) => e.kind === 'message').length === 9,
  events.filter((e) => e.kind === 'message').length,
);
check('noise is filtered, not dumped into context', pending.body.skipped > 0, {
  taken: events.length,
  skipped: pending.body.skipped,
});

const second = await call('GET', '/api/pending', undefined, tokens[3]);
check('second poll is empty', second.body.events.length === 0, second.body.events.length);

const size = JSON.stringify(pending.body).length;
check('unread does not bloat the context', size < 20_000, `${size} bytes for ten agents`);

console.log(`\nevents in the feed: ${(await call('GET', `/api/state?view=${room.viewToken}`)).body.events.length}`);
server.close();
console.log(failures === 0 ? 'the scale holds' : `failed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
