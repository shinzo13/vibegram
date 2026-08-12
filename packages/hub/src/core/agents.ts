import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Agent, AgentStatus, Platform } from '../../../protocol/src/index.ts';
import { isValidNick, platformFromNick } from '../../../protocol/src/index.ts';
import { nowIso } from '../db.ts';
import { type Ctx, emit, newId } from './ctx.ts';

interface AgentRow {
  id: string;
  room_id: string;
  nick: string;
  platform: string;
  status: string;
  last_seen_at: string;
}

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    roomId: row.room_id,
    nick: row.nick,
    platform: row.platform as Platform,
    status: row.status as AgentStatus,
    lastSeenAt: row.last_seen_at,
  };
}

const AGENT_COLS = 'id, room_id, nick, platform, status, last_seen_at';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function ensureProject(ctx: Ctx, id: string, name: string): void {
  ctx.db
    .prepare(
      `INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(id, name, nowIso());
  ctx.db
    .prepare(
      `INSERT INTO plan_notes (room_id, body, version, updated_at) VALUES (?, '', 0, ?)
       ON CONFLICT (room_id) DO NOTHING`,
    )
    .run(id, nowIso());
}

export type JoinResult =
  | { ok: true; agent: Agent; token: string }
  | { ok: false; error: 'invalid_nick' | 'nick_taken' };

/**
 * The codename is chosen by a human during `vibegram init`, so a taken nick is
 * a refusal rather than a silent reuse: two agents under one name would make
 * the feed unreadable.
 */
export function joinRoom(ctx: Ctx, roomId: string, nick: string): JoinResult {
  if (!isValidNick(nick)) return { ok: false, error: 'invalid_nick' };

  const existing = ctx.db
    .prepare('SELECT id FROM agents WHERE room_id = ? AND nick = ?')
    .get(roomId, nick);
  if (existing) return { ok: false, error: 'nick_taken' };

  const token = randomBytes(24).toString('hex');
  const id = newId();
  const now = nowIso();

  ctx.db
    .prepare(
      `INSERT INTO agents (id, room_id, nick, platform, token_hash, status, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'online', ?, ?)`,
    )
    .run(id, roomId, nick, platformFromNick(nick), hashToken(token), now, now);

  // The cursor starts at the current end of the feed: a fresh agent must not
  // get the entire room history dumped into its context at once.
  const head = ctx.db
    .prepare('SELECT COALESCE(MAX(id), 0) AS head FROM events WHERE room_id = ?')
    .get(roomId) as { head: number };
  ctx.db.prepare('INSERT INTO cursors (agent_id, last_event_id) VALUES (?, ?)').run(id, head.head);

  const agent = rowToAgent(
    ctx.db.prepare(`SELECT ${AGENT_COLS} FROM agents WHERE id = ?`).get(id) as AgentRow,
  );
  emit(ctx, { roomId, agentId: id, kind: 'agent_join', payload: {} });
  return { ok: true, agent, token };
}

export function authAgent(ctx: Ctx, token: string): Agent | null {
  const hash = hashToken(token);
  const row = ctx.db
    .prepare(`SELECT ${AGENT_COLS}, token_hash FROM agents WHERE token_hash = ?`)
    .get(hash) as (AgentRow & { token_hash: string }) | undefined;
  if (!row) return null;

  // Constant-time anyway: both hashes have the same length.
  const a = Buffer.from(row.token_hash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return rowToAgent(row);
}

/**
 * A hook called in, so this agent's write interception is actually wired up.
 *
 * Recorded separately from presence: an agent can be perfectly alive over the
 * CLI while its hooks never load — which is exactly the case that looks safe
 * and protects nothing. See PLAN.md.
 */
export function markHooksAlive(ctx: Ctx, agentId: string): void {
  ctx.db.prepare('UPDATE agents SET hooks_seen_at = ? WHERE id = ?').run(nowIso(), agentId);
}

export function heartbeat(ctx: Ctx, agentId: string): void {
  ctx.db
    .prepare("UPDATE agents SET last_seen_at = ?, status = 'online' WHERE id = ?")
    .run(nowIso(), agentId);
}

export function getAgent(ctx: Ctx, agentId: string): Agent | null {
  const row = ctx.db.prepare(`SELECT ${AGENT_COLS} FROM agents WHERE id = ?`).get(agentId) as
    | AgentRow
    | undefined;
  return row ? rowToAgent(row) : null;
}

export function findAgentByNick(ctx: Ctx, roomId: string, nick: string): Agent | null {
  const row = ctx.db
    .prepare(`SELECT ${AGENT_COLS} FROM agents WHERE room_id = ? AND nick = ?`)
    .get(roomId, nick) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

export function listAgents(ctx: Ctx, roomId: string): Agent[] {
  const rows = ctx.db
    .prepare(`SELECT ${AGENT_COLS} FROM agents WHERE room_id = ? ORDER BY nick`)
    .all(roomId) as AgentRow[];
  return rows.map(rowToAgent);
}

export function markOffline(ctx: Ctx, agentId: string): void {
  ctx.db.prepare("UPDATE agents SET status = 'offline' WHERE id = ?").run(agentId);
  const agent = getAgent(ctx, agentId);
  if (agent) emit(ctx, { roomId: agent.roomId, agentId, kind: 'agent_leave', payload: {} });
}
