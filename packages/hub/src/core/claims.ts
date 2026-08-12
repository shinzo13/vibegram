import type { Agent, Claim, ClaimConflict, ClaimResult } from '../../../protocol/src/index.ts';
import { normalizeResource, resourcesConflict } from '../../../protocol/src/index.ts';
import { nowIso } from '../db.ts';
import { type Ctx, emit, newId } from './ctx.ts';

interface ClaimRow {
  id: string;
  room_id: string;
  agent_id: string;
  nick: string;
  resource: string;
  note: string | null;
  plan_item_id: string | null;
  status: string;
  created_at: string;
  released_at: string | null;
}

const SELECT_CLAIM = `
  SELECT c.id, c.room_id, c.agent_id, a.nick AS nick, c.resource, c.note,
         c.plan_item_id, c.status, c.created_at, c.released_at
  FROM claims c JOIN agents a ON a.id = c.agent_id
`;

function rowToClaim(row: ClaimRow): Claim {
  return {
    id: row.id,
    roomId: row.room_id,
    agentId: row.agent_id,
    nick: row.nick,
    resource: row.resource,
    note: row.note,
    planItemId: row.plan_item_id,
    status: row.status as Claim['status'],
    createdAt: row.created_at,
    releasedAt: row.released_at,
  };
}

export function listClaims(ctx: Ctx, roomId: string, activeOnly = true): Claim[] {
  const sql = activeOnly
    ? `${SELECT_CLAIM} WHERE c.room_id = ? AND c.status = 'active' ORDER BY c.created_at`
    : `${SELECT_CLAIM} WHERE c.room_id = ? ORDER BY c.created_at`;
  return (ctx.db.prepare(sql).all(roomId) as ClaimRow[]).map(rowToClaim);
}

function toConflict(claim: Claim): ClaimConflict {
  return {
    resource: claim.resource,
    heldBy: claim.nick,
    since: claim.createdAt,
    note: claim.note,
    planItemId: claim.planItemId,
  };
}

/**
 * Claiming resources. Either all requested ones are taken or none: a partial
 * claim would leave an agent believing it owns the whole task.
 */
export function claimResources(
  ctx: Ctx,
  agent: Agent,
  resources: string[],
  note: string | null = null,
  planItemId: string | null = null,
): ClaimResult {
  const wanted = [...new Set(resources.map(normalizeResource))].filter((r) => r !== '');
  if (wanted.length === 0) return { ok: true, claims: [] };

  ctx.db.exec('BEGIN IMMEDIATE');
  try {
    const active = listClaims(ctx, agent.roomId);

    const conflicts: ClaimConflict[] = [];
    for (const resource of wanted) {
      for (const held of active) {
        if (held.agentId === agent.id) continue;
        if (resourcesConflict(resource, held.resource)) conflicts.push(toConflict(held));
      }
    }

    if (conflicts.length > 0) {
      ctx.db.exec('COMMIT');
      // A refusal is an event too: the feed should show that coordination worked.
      emit(ctx, {
        roomId: agent.roomId,
        agentId: agent.id,
        kind: 'claim_denied',
        payload: { requested: wanted, conflicts },
      });
      return { ok: false, conflicts };
    }

    const mine = new Set(active.filter((c) => c.agentId === agent.id).map((c) => c.resource));
    const created: string[] = [];
    const now = nowIso();

    for (const resource of wanted) {
      if (mine.has(resource)) continue;
      ctx.db
        .prepare(
          `INSERT INTO claims (id, room_id, agent_id, resource, note, plan_item_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(newId(), agent.roomId, agent.id, resource, note, planItemId, now);
      created.push(resource);
    }
    ctx.db.exec('COMMIT');

    if (created.length > 0) {
      emit(ctx, {
        roomId: agent.roomId,
        agentId: agent.id,
        kind: 'claim',
        payload: { resources: created, note, planItemId },
      });
    }

    const claims = listClaims(ctx, agent.roomId).filter(
      (c) => c.agentId === agent.id && wanted.includes(c.resource),
    );
    return { ok: true, claims };
  } catch (err) {
    ctx.db.exec('ROLLBACK');
    throw err;
  }
}

/** With no resource list this releases everything the agent holds — that is what SessionEnd does. */
export function releaseResources(ctx: Ctx, agent: Agent, resources?: string[]): string[] {
  const mine = listClaims(ctx, agent.roomId).filter((c) => c.agentId === agent.id);
  const targets =
    resources === undefined
      ? mine
      : (() => {
          const wanted = resources.map(normalizeResource);
          return mine.filter((c) => wanted.some((w) => resourcesConflict(w, c.resource)));
        })();

  if (targets.length === 0) return [];

  const now = nowIso();
  for (const claim of targets) {
    ctx.db
      .prepare("UPDATE claims SET status = 'released', released_at = ? WHERE id = ?")
      .run(now, claim.id);
  }

  const released = targets.map((c) => c.resource);
  emit(ctx, {
    roomId: agent.roomId,
    agentId: agent.id,
    kind: 'release',
    payload: { resources: released },
  });
  return released;
}

/**
 * The check a PreToolUse hook performs before a write. An unclaimed path is not
 * forbidden: claiming is voluntary, and a claim only protects what someone
 * explicitly took.
 */
export function checkWrite(ctx: Ctx, agent: Agent, resource: string): ClaimConflict | null {
  const target = normalizeResource(resource);
  for (const held of listClaims(ctx, agent.roomId)) {
    if (held.agentId === agent.id) continue;
    if (resourcesConflict(target, held.resource)) return toConflict(held);
  }
  return null;
}

/**
 * A write into someone else's resource: `blocked` — stopped (claude code),
 * `occurred` — already happened and caught after the fact (cursor, codex).
 */
export function reportViolation(
  ctx: Ctx,
  agent: Agent,
  resource: string,
  conflict: ClaimConflict,
  outcome: 'blocked' | 'occurred',
  tool: string | null = null,
): void {
  emit(ctx, {
    roomId: agent.roomId,
    agentId: agent.id,
    kind: 'violation',
    payload: { resource: normalizeResource(resource), heldBy: conflict.heldBy, outcome, tool },
  });
}

export const STALE_MS = 10 * 60 * 1000;

/**
 * A dead agent must not hold a file forever. SessionEnd never fires on a crash,
 * so auto-release is mandatory rather than a nice-to-have. See PLAN.md.
 */
export function reapStale(ctx: Ctx, staleMs: number = STALE_MS): number {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const stale = ctx.db
    .prepare(`SELECT id, room_id FROM agents WHERE status = 'online' AND last_seen_at < ?`)
    .all(cutoff) as { id: string; room_id: string }[];

  let reaped = 0;
  for (const row of stale) {
    ctx.db.prepare("UPDATE agents SET status = 'offline' WHERE id = ?").run(row.id);
    const claims = listClaims(ctx, row.room_id).filter((c) => c.agentId === row.id);
    if (claims.length > 0) {
      const now = nowIso();
      for (const claim of claims) {
        ctx.db
          .prepare("UPDATE claims SET status = 'released', released_at = ? WHERE id = ?")
          .run(now, claim.id);
      }
      emit(ctx, {
        roomId: row.room_id,
        agentId: row.id,
        kind: 'release',
        payload: { resources: claims.map((c) => c.resource) },
      });
      reaped += claims.length;
    }
    emit(ctx, { roomId: row.room_id, agentId: row.id, kind: 'agent_leave', payload: {} });
  }
  return reaped;
}
