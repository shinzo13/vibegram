/**
 * Acceptance for the hub: claims, feed, plan, tree and cards over real http
 * rather than direct core calls.
 *
 * Run: npm run smoke
 */
import { openDb } from '../src/db.ts';
import { createCtx } from '../src/core/index.ts';
import { createHttpServer } from '../src/transport/http.ts';

const ctx = createCtx(openDb(':memory:'));
const server = createHttpServer(ctx);
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;
const base = `http://localhost:${port}`;

let failures = 0;

function check(name: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || detail === '' ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

interface Res {
  status: number;
  body: any;
}

async function call(method: string, path: string, body?: unknown, token?: string): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ─── rooms ───────────────────────────────────────────────────────────────────

const health = await call('GET', '/api/health');
check('health responds', health.body.ok === true);

const created = await call('POST', '/api/rooms', { name: 'hackathon' });
const room = created.body.room;
const joinCode = created.body.joinCode as string;
check('room created', created.status === 200 && typeof room.id === 'string', created.body);
check('join code issued once', typeof joinCode === 'string' && joinCode.includes('-'), joinCode);
check('view token differs from the join code', room.viewToken !== joinCode);

// The two are handed out together, so they must not look alike: mixing them up
// either locks the team out or hands the way in to whoever saw the screen.
check('join code is dashed, the view token is not', joinCode.includes('-') && !room.viewToken.includes('-'), {
  joinCode,
  viewToken: room.viewToken,
});
check(
  'the view token is short enough to retype but not guessable',
  room.viewToken.length === 8 && /^[a-z0-9]+$/.test(room.viewToken),
  room.viewToken,
);

const a = await call('POST', '/api/rooms/join', { joinCode, nick: 'claude-shinrei', fingerprint: 'repo1' });
const b = await call('POST', '/api/rooms/join', { joinCode, nick: 'codex-nightshelf', fingerprint: 'repo1' });
check('two agents joined', a.status === 200 && b.status === 200, [a.body, b.body]);
const tokenA = a.body.token as string;
const tokenB = b.body.token as string;

const badCode = await call('POST', '/api/rooms/join', { joinCode: 'zzzz-zzzz', nick: 'claude-x' });
check('a wrong join code is refused', badCode.status === 404 && badCode.body.error === 'bad_join_code', badCode.body);

const wrongRepo = await call('POST', '/api/rooms/join', { joinCode, nick: 'claude-y', fingerprint: 'other-repo' });
check(
  'joining from the wrong repository is caught',
  wrongRepo.status === 409 && wrongRepo.body.error === 'wrong_repository',
  wrongRepo.body,
);

const dup = await call('POST', '/api/rooms/join', { joinCode, nick: 'claude-shinrei', fingerprint: 'repo1' });
check('a taken nick is refused', dup.status === 409 && dup.body.error === 'nick_taken', dup.body);

const badNick = await call('POST', '/api/rooms/join', { joinCode, nick: 'Vasya', fingerprint: 'repo1' });
check('an invalid nick is refused', badNick.status === 409, badNick.body);

check('no access without a token', (await call('GET', '/api/pending')).status === 401);

const byId = await call('GET', `/api/state?view=${room.id}`);
check('the room id does not open the feed', byId.status === 404, byId.body);

const noView = await call('GET', '/api/state');
check('reading without a view token is refused', noView.status === 400, noView.body);

// ─── the web view reads the feed ─────────────────────────────────────────────

const streamed: any[] = [];
const streamCtl = new AbortController();
const streamReady = (async () => {
  const res = await fetch(`${base}/api/stream?view=${room.viewToken}`, { signal: streamCtl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const chunk of buffer.split('\n\n')) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line && chunk.includes('event: append')) streamed.push(JSON.parse(line.slice(6)));
    }
    buffer = '';
  }
})().catch(() => {});
await new Promise((r) => setTimeout(r, 50));

// ─── milestone one: a claim holds ────────────────────────────────────────────

const claimA = await call('POST', '/api/claims', { resources: ['./src/foo.ts'], note: 'doing the handlers' }, tokenA);
check('A claims src/foo.ts', claimA.body.ok === true, claimA.body);
check('the path is normalised', claimA.body.claims?.[0]?.resource === 'src/foo.ts', claimA.body.claims);

const claimB = await call('POST', '/api/claims', { resources: ['src/foo.ts'] }, tokenB);
check('B is refused', claimB.body.ok === false, claimB.body);
check(
  'the refusal names the holder and the time',
  claimB.body.conflicts?.[0]?.heldBy === 'claude-shinrei' && typeof claimB.body.conflicts?.[0]?.since === 'string',
  claimB.body.conflicts,
);

const claimDir = await call('POST', '/api/claims', { resources: ['src/'] }, tokenB);
check('a directory over a claimed file is refused', claimDir.body.ok === false, claimDir.body);

const claimOther = await call('POST', '/api/claims', { resources: ['web/app.svelte'] }, tokenB);
check('a neighbouring resource is free to take', claimOther.body.ok === true, claimOther.body);

// ─── the hook hot path ───────────────────────────────────────────────────────

const write = await call('POST', '/api/check-write', { resource: 'src/foo.ts', tool: 'Edit' }, tokenB);
check(
  'writing into someone else\'s file is refused',
  write.body.allow === false && write.body.conflict.heldBy === 'claude-shinrei',
  write.body,
);

const writeOwn = await call('POST', '/api/check-write', { resource: 'src/foo.ts', tool: 'Edit' }, tokenA);
check('the holder writes freely', writeOwn.body.allow === true, writeOwn.body);

const writeFree = await call('POST', '/api/check-write', { resource: 'readme.md' }, tokenB);
check('an unclaimed file is free to write', writeFree.body.allow === true, writeFree.body);

const abs = await call('POST', '/api/check-write', { resource: '/Users/x/proj/src/foo.ts' }, tokenB);
check(
  'an absolute path is refused rather than silently allowed',
  abs.status === 400 && abs.body.error === 'absolute_resource',
  abs.body,
);

// ─── the feed ────────────────────────────────────────────────────────────────

const msg = await call('POST', '/api/messages', { body: 'stay out of routing @codex-nightshelf' }, tokenA);
check('announcement sent', msg.status === 200, msg.body);

const msg2 = await call('POST', '/api/messages', { body: 'again' }, tokenA);
check('rapid messages are rate limited', msg2.status === 429, msg2.body);

// ─── unread ──────────────────────────────────────────────────────────────────

const pending = await call('GET', '/api/pending', undefined, tokenB);
const kinds = (pending.body.events as any[]).map((e) => e.kind);
check('B sees the announcement', kinds.includes('message'), kinds);
check(
  'own events are not returned',
  !(pending.body.events as any[]).some((e) => e.nick === 'codex-nightshelf'),
  kinds,
);
check('irrelevant events are filtered out', pending.body.skipped > 0, pending.body.skipped);

const pendingAgain = await call('GET', '/api/pending', undefined, tokenB);
check('the cursor moved', pendingAgain.body.events.length === 0, pendingAgain.body.events);

// ─── rewinding ───────────────────────────────────────────────────────────────
// The cursor advances when the hub answers, not when the answer arrives: a
// consumer that dies mid-delivery, or a second one sharing the token, used to
// lose those events with no way to ask again.

const cursorAtRewind = pendingAgain.body.cursor;
const rewound = await call('GET', '/api/pending?last=20', undefined, tokenB);
check('history comes back after it was read', rewound.body.events.length > 0, rewound.body.events.length);
check('rewinding leaves the unread mark alone', rewound.body.cursor === cursorAtRewind, rewound.body.cursor);

const afterRewind = await call('GET', '/api/pending', undefined, tokenB);
check('and the feed is still empty afterwards', afterRewind.body.events.length === 0, afterRewind.body.events);

const firstId = (rewound.body.events as any[])[0].id;
const sinceFirst = await call(`GET`, `/api/pending?since=${firstId}`, undefined, tokenB);
check(
  'since returns what follows that event',
  (sinceFirst.body.events as any[]).every((e) => e.id > firstId),
  (sinceFirst.body.events as any[]).map((e) => e.id),
);

const badSince = await call('GET', '/api/pending?since=nope', undefined, tokenB);
check('a nonsense since is refused', badSince.status === 400, badSince.body);

const pendingA = await call('GET', '/api/pending', undefined, tokenA);
const kindsA = (pendingA.body.events as any[]).map((e) => e.kind);
check('the holder sees that someone is waiting', kindsA.includes('claim_denied'), kindsA);
check('the holder sees the intrusion into their file', kindsA.includes('violation'), kindsA);

// ─── file tree ───────────────────────────────────────────────────────────────

await call(
  'POST',
  '/api/tree',
  { tracked: ['src/foo.ts', 'src/bar.ts', 'README.md'], untracked: ['src/draft.ts'] },
  tokenA,
);
await call('POST', '/api/tree', { tracked: ['web/app.svelte', 'README.md'], untracked: [] }, tokenB);

const tree = (await call('GET', `/api/tree?view=${room.viewToken}`)).body.tree as any[];
const src = tree.find((n) => n.path === 'src/');
const web = tree.find((n) => n.path === 'web/');
check('the tree merges snapshots from different clones', src !== undefined && web !== undefined, tree.map((n) => n.path));
check(
  'an uncommitted file is visible — a server with a clone would never see it',
  src?.children?.some((c: any) => c.path === 'src/draft.ts' && c.tracked === false),
  src?.children?.map((c: any) => `${c.path}:${c.tracked}`),
);

const foo = src?.children?.find((c: any) => c.path === 'src/foo.ts');
check('the claim lands on the file in the tree', foo?.heldBy === 'claude-shinrei', foo);
check('a claim on the file itself is not marked inherited', foo?.heldHere === true, foo?.heldHere);

// A separate free directory: web/ is already partly claimed by another agent.
// A snapshot is always complete — it replaces the agent's previous one entirely.
await call(
  'POST',
  '/api/tree',
  { tracked: ['src/foo.ts', 'src/bar.ts', 'README.md', 'docs/intro.md', 'docs/api.md'], untracked: ['src/draft.ts'] },
  tokenA,
);
await call('POST', '/api/claims', { resources: ['docs/'], note: 'writing the docs' }, tokenA);
const treeDir = (await call('GET', `/api/tree?view=${room.viewToken}`)).body.tree as any[];
const intro = treeDir.find((n) => n.path === 'docs/')?.children?.[0];
check(
  'a directory claim is inherited downwards',
  intro?.heldBy === 'claude-shinrei' && intro?.heldHere === false,
  intro,
);

await call('POST', '/api/tree', { tracked: ['web/app.svelte'], untracked: [] }, tokenB);
const afterResync = (await call('GET', `/api/tree?view=${room.viewToken}`)).body.tree as any[];
check(
  'a snapshot replaces the previous one rather than adding to it',
  afterResync.find((n) => n.path === 'src/')?.children?.length === 3,
  afterResync.find((n) => n.path === 'src/')?.children?.map((c: any) => c.path),
);

// ─── agent card ──────────────────────────────────────────────────────────────

const card = await call(
  'POST',
  '/api/card',
  { description: 'backend and migrations', skills: ['sqlite', 'http'], model: 'claude-opus-5', branch: 'feat/hub' },
  tokenA,
);
check('card saved', card.body.card?.description === 'backend and migrations', card.body);
check('skills saved', card.body.card?.skills?.join(',') === 'sqlite,http', card.body.card?.skills);

const cards = await call('GET', `/api/cards?view=${room.viewToken}`);
const cardA = (cards.body.cards as any[]).find((c) => c.nick === 'claude-shinrei');
check('the card is visible to others', cardA?.model === 'claude-opus-5', cardA);
check(
  'the card shows the current focus',
  Array.isArray(cardA?.focus?.holding) && cardA.focus.holding.includes('src/foo.ts'),
  cardA?.focus,
);

const patch = await call('POST', '/api/card', { description: 'frontend now' }, tokenA);
check(
  'a partial update does not wipe the skills',
  patch.body.card?.skills?.length === 2 && patch.body.card?.description === 'frontend now',
  patch.body.card,
);

const wellKnown = await call('GET', '/.well-known/agent-card.json');
check(
  'the hub serves its own A2A card',
  wellKnown.body.name === 'vibegram' && Array.isArray(wellKnown.body.skills),
  wellKnown.body,
);

// ─── plan ────────────────────────────────────────────────────────────────────

const propose = await call(
  'POST',
  '/api/plan/propose',
  { items: ['rework routing', 'wire up the database'], notes: 'coordinating agents' },
  tokenA,
);
check('the first agent publishes the plan', propose.body.ok === true && propose.body.plan.revision === 1, propose.body);
check('the author agrees with their own plan', propose.body.plan.acks?.[0]?.nick === 'claude-shinrei', propose.body.plan.acks);

const proposeAgain = await call('POST', '/api/plan/propose', { items: ['my own plan'] }, tokenB);
check(
  'the second publisher is refused rather than duplicated',
  proposeAgain.status === 409 && proposeAgain.body.error === 'already_proposed',
  proposeAgain.body,
);

const planForB = await call('GET', `/api/plan?view=${room.viewToken}`);
check('the plan is visible to everyone', planForB.body.items.length === 2, planForB.body.items?.length);

const ackStale = await call('POST', '/api/plan/ack', { revision: 99 }, tokenB);
check('agreement with a nonexistent revision is refused', ackStale.status === 409, ackStale.body);

const ack = await call('POST', '/api/plan/ack', { revision: planForB.body.revision }, tokenB);
check('B agrees with the plan', ack.body.ok === true, ack.body);

const pendingAfterAck = await call('GET', '/api/pending', undefined, tokenB);
check('an agent that agreed is not nagged', pendingAfterAck.body.planAckNeeded === null, pendingAfterAck.body.planAckNeeded);

const dispute = await call('POST', '/api/plan/dispute', { reason: 'no database needed, files are enough' }, tokenB);
check('objection accepted', dispute.body.ok === true, dispute.body);

const afterDispute = await call('GET', `/api/plan?view=${room.viewToken}`);
check(
  'an objection withdraws the agreement',
  !afterDispute.body.acks.some((a: any) => a.nick === 'codex-nightshelf'),
  afterDispute.body.acks,
);

const item = await call('POST', '/api/plan/items', { text: 'one more item' }, tokenA);
const itemId = item.body.item.id as string;
check('plan item added', item.status === 200 && item.body.item.status === 'todo', item.body);

const bumped = await call('GET', `/api/plan?view=${room.viewToken}`);
check('changing the composition moves the revision', bumped.body.revision > 1, bumped.body.revision);

const beforeStatus = bumped.body.revision;
await call('POST', '/api/plan/update', { itemId, status: 'doing' }, tokenA);
const afterStatus = await call('GET', `/api/plan?view=${room.viewToken}`);
check('a status change does NOT move the revision', afterStatus.body.revision === beforeStatus, {
  before: beforeStatus,
  after: afterStatus.body.revision,
});

const pendingAckA = await call('GET', '/api/pending', undefined, tokenB);
check(
  'a changed plan asks for fresh agreement',
  pendingAckA.body.planAckNeeded === afterStatus.body.revision,
  pendingAckA.body.planAckNeeded,
);

const take = await call('POST', '/api/plan/update', { itemId, status: 'doing' }, tokenA);
check('A owns the item', take.body.ok === true && take.body.item.ownerNick === 'claude-shinrei', take.body);

const steal = await call('POST', '/api/plan/update', { itemId, status: 'done' }, tokenB);
check("someone else's item is not overwritten", steal.status === 409 && steal.body.error === 'owned_by_other', steal.body);

// propose already wrote the notes, so the current version has to be re-read —
// exactly what an agent would have to do.
const notesVersion = (await call('GET', `/api/plan?view=${room.viewToken}`)).body.notes.version as number;
const notes1 = await call('POST', '/api/plan/notes', { body: 'shared context', version: notesVersion }, tokenA);
check('notes written', notes1.body.ok === true, notes1.body);

const notes2 = await call('POST', '/api/plan/notes', { body: 'overwrite', version: notesVersion }, tokenB);
check('a stale overwrite is rejected', notes2.status === 409 && notes2.body.error === 'version_mismatch', notes2.body);

// ─── work digest ─────────────────────────────────────────────────────────────

const work = await call('GET', '/api/work', undefined, tokenB);
check('work digest lists free items', Array.isArray(work.body.free), work.body);
check('work digest shows who is busy', Array.isArray(work.body.busy) && work.body.busy.length > 0, work.body.busy?.length);
check('work digest excludes the caller', !(work.body.cards as any[]).some((c) => c.nick === 'codex-nightshelf'));

// ─── release ─────────────────────────────────────────────────────────────────

const release = await call('POST', '/api/claims/release', { resources: ['src/foo.ts'] }, tokenA);
check('A releases the file', release.body.released?.includes('src/foo.ts'), release.body);

const claimBAgain = await call('POST', '/api/claims', { resources: ['src/foo.ts'] }, tokenB);
check('a released file can be taken', claimBAgain.body.ok === true, claimBAgain.body);

// ─── the feed reached the web view ───────────────────────────────────────────

await new Promise((r) => setTimeout(r, 100));
const streamedKinds = streamed.map((e) => e.kind);
check('the web view received events over SSE', streamed.length > 0, streamedKinds);
check('a claim refusal is in the feed', streamedKinds.includes('claim_denied'), streamedKinds);

const state = await call('GET', `/api/state?view=${room.viewToken}`);
check(
  'state is served whole',
  Array.isArray(state.body.agents) && Array.isArray(state.body.claims),
  Object.keys(state.body),
);

const missing = await call('GET', '/api/nonexistent');
check(
  'an /api miss is an honest 404, not the SPA fallback',
  missing.status === 404 && missing.body.error === 'not_found',
  missing.body,
);

streamCtl.abort();
await streamReady;
server.close();

console.log(failures === 0 ? '\nall green' : `\nfailed checks: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
