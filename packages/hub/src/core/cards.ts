import type { AgentCard, AgentFocus, CardPatch, Platform } from '../../../protocol/src/index.ts';
import { nowIso } from '../db.ts';
import type { Ctx } from './ctx.ts';

interface CardRow {
  nick: string;
  platform: string;
  status: string;
  last_seen_at: string;
  hooks_seen_at: string | null;
  description: string | null;
  skills: string | null;
  model: string | null;
  branch: string | null;
}

const SELECT_CARD = `
  SELECT a.id, a.nick, a.platform, a.status, a.last_seen_at, a.hooks_seen_at,
         c.description, c.skills, c.model, c.branch
  FROM agents a LEFT JOIN agent_cards c ON c.agent_id = a.id
`;

/**
 * An agent's live focus: what it holds and which plan item it took.
 *
 * This is what a static card lacks — without it "bob does backend" does
 * not help decide whether to approach them now or leave them alone.
 */
function focusOf(ctx: Ctx, agentId: string): AgentFocus {
  const holding = (
    ctx.db
      .prepare("SELECT resource FROM claims WHERE agent_id = ? AND status = 'active' ORDER BY created_at")
      .all(agentId) as { resource: string }[]
  ).map((row) => row.resource);

  const item = ctx.db
    .prepare("SELECT id, text FROM plan_items WHERE owner_agent_id = ? AND status = 'doing' LIMIT 1")
    .get(agentId) as { id: string; text: string } | undefined;

  return { holding, planItem: item ?? null };
}

function rowToCard(ctx: Ctx, row: CardRow & { id: string }): AgentCard {
  let skills: string[] = [];
  try {
    skills = row.skills ? (JSON.parse(row.skills) as string[]) : [];
  } catch {
    // Malformed JSON in one card is no reason to drop the whole roster.
    skills = [];
  }

  return {
    nick: row.nick,
    platform: row.platform as Platform,
    status: row.status as AgentCard['status'],
    description: row.description,
    skills,
    model: row.model,
    branch: row.branch,
    lastSeenAt: row.last_seen_at,
    // Never heard from a hook: this agent coordinates by hand and nothing stops
    // it from writing into a claimed file.
    hooksAlive: row.hooks_seen_at !== null,
    focus: focusOf(ctx, row.id),
  };
}

export function listCards(ctx: Ctx, roomId: string): AgentCard[] {
  const rows = ctx.db
    .prepare(`${SELECT_CARD} WHERE a.room_id = ? ORDER BY a.nick`)
    .all(roomId) as (CardRow & { id: string })[];
  return rows.map((row) => rowToCard(ctx, row));
}

export function getCard(ctx: Ctx, roomId: string, nick: string): AgentCard | null {
  const row = ctx.db
    .prepare(`${SELECT_CARD} WHERE a.room_id = ? AND a.nick = ?`)
    .get(roomId, nick) as (CardRow & { id: string }) | undefined;
  return row ? rowToCard(ctx, row) : null;
}

/** A patch, not a replace: the branch is refreshed on every heartbeat, the description rarely. */
export function setCard(ctx: Ctx, agentId: string, patch: CardPatch): void {
  const existing = ctx.db
    .prepare('SELECT description, skills, model, branch FROM agent_cards WHERE agent_id = ?')
    .get(agentId) as
    | { description: string | null; skills: string; model: string | null; branch: string | null }
    | undefined;

  const description = patch.description === undefined ? (existing?.description ?? null) : patch.description;
  const skills = patch.skills === undefined ? (existing?.skills ?? '[]') : JSON.stringify(patch.skills);
  const model = patch.model === undefined ? (existing?.model ?? null) : patch.model;
  const branch = patch.branch === undefined ? (existing?.branch ?? null) : patch.branch;

  ctx.db
    .prepare(
      `INSERT INTO agent_cards (agent_id, description, skills, model, branch, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET description = excluded.description,
                                            skills = excluded.skills,
                                            model = excluded.model,
                                            branch = excluded.branch,
                                            updated_at = excluded.updated_at`,
    )
    .run(agentId, description, skills, model, branch, nowIso());
}
