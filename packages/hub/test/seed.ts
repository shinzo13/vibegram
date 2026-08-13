/**
 * Fills the hub with a plausible session: a plan, claims, a refusal, announcements.
 *
 * Lets anyone look at the web view without running four real agents, and doubles
 * as a fallback for a demo if the live agents let you down.
 *
 * Run: npm run seed   (the hub must already be up)
 */
const HUB = process.env.VIBEGRAM_HUB ?? 'http://localhost:4321';

async function call(path: string, body?: unknown, token?: string): Promise<any> {
  const res = await fetch(`${HUB}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

let room: any = null;

async function join(nick: string, description: string, skills: string[]): Promise<string> {
  const res = await call('/api/rooms/join', { joinCode, nick });
  if (!res.token) throw new Error(`${nick}: ${res.message ?? 'not joined'}`);
  await call('/api/card', { description, skills, model: 'claude-opus-5', branch: 'main' }, res.token);
  return res.token as string;
}

const roomResult = await call('/api/rooms', { name: 'hackathon' });
room = roomResult.room;
const joinCode = roomResult.joinCode as string;

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const shinrei = await join('claude-shinrei', 'backend, hub and schema', ['sqlite', 'http', 'tests']);
const nightshelf = await join('chatgpt-nightshelf', 'frontend', ['svelte', 'css']);
const haikesan = await join('claude-haikesan', 'write interception and hooks', ['hooks', 'shell']);
const vermillion = await join('cursor-vermillion', 'refactoring', ['typescript']);

await call(
  '/api/plan/propose',
  {
    items: [
      'bring up the hub and the schema',
      'intercept writes into claimed files',
      'web event feed',
      'skill for agents',
    ],
    notes: 'deadline 18:00, demo on two laptops. keep away from production keys.',
  },
  shinrei,
);

await call('/api/plan/ack', { revision: 1 }, nightshelf);
await call('/api/plan/ack', { revision: 1 }, haikesan);
await call('/api/plan/dispute', { reason: 'the skill will not fit in time, drop item four' }, vermillion);

// A file tree, so the right-hand column is not empty.
await call(
  '/api/tree',
  {
    tracked: [
      'packages/hub/src/index.ts',
      'packages/hub/src/db.ts',
      'packages/hub/schema.sql',
      'packages/client/src/cli.ts',
      'packages/client/src/hook.ts',
      'packages/client/src/mcp.ts',
      'packages/web/src/App.svelte',
      'packages/web/src/Tree.svelte',
      'README.md',
      'PLAN.md',
    ],
    untracked: ['packages/client/src/tree.ts'],
  },
  shinrei,
);

await call('/api/claims', { resources: ['packages/hub/'], note: 'working on the hub' }, shinrei);
await pause(50);
await call('/api/claims', { resources: ['packages/web/'], note: 'building the feed' }, nightshelf);
await pause(50);
await call('/api/messages', { body: 'took the whole hub, stay out of packages/hub until I release it' }, shinrei);
await pause(50);

// The collision this whole thing exists for.
await call('/api/claims', { resources: ['packages/hub/src/core/claims.ts'] }, haikesan);
await pause(50);
await call('/api/check-write', { resource: 'packages/hub/src/core/claims.ts', tool: 'Edit' }, haikesan);
await pause(50);
await call('/api/messages', { body: '@claude-shinrei I need core/claims.ts for ten minutes, will you release it?' }, haikesan);
await pause(50);
await call('/api/claims/release', { resources: ['packages/hub/'] }, shinrei);
await pause(50);
await call('/api/claims', { resources: ['packages/client/src/hook.ts'], note: 'write interception' }, haikesan);
await pause(50);
await call('/api/check-write', { resource: 'packages/web/src/App.svelte', tool: 'edit', outcome: 'occurred' }, vermillion);
await pause(50);
await call('/api/messages', { body: '@cursor-vermillion you just overwrote my edit in App.svelte' }, nightshelf);
await pause(50);

const plan = await call(`/api/plan?view=${room.viewToken}`);
await call('/api/plan/update', { itemId: plan.items[1].id, status: 'doing' }, haikesan);
await call('/api/messages', { body: 'build is fixed, main is safe to pull' }, vermillion);

console.log(`seeded. Open the feed: ${HUB}/r/${room.viewToken}`);
