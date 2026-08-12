import type { Agent, Plan, PlanItem, PlanItemStatus, PlanNotes } from '../../../protocol/src/index.ts';
import { PLAN_ITEM_STATUSES } from '../../../protocol/src/index.ts';
import { nowIso } from '../db.ts';
import { type Ctx, emit, newId } from './ctx.ts';

interface PlanItemRow {
  id: string;
  room_id: string;
  text: string;
  status: string;
  owner_agent_id: string | null;
  owner_nick: string | null;
  note: string | null;
  position: number;
  updated_at: string;
}

const SELECT_ITEM = `
  SELECT p.id, p.room_id, p.text, p.status, p.owner_agent_id, a.nick AS owner_nick,
         p.note, p.position, p.updated_at
  FROM plan_items p LEFT JOIN agents a ON a.id = p.owner_agent_id
`;

function rowToItem(row: PlanItemRow): PlanItem {
  return {
    id: row.id,
    roomId: row.room_id,
    text: row.text,
    status: row.status as PlanItemStatus,
    ownerAgentId: row.owner_agent_id,
    ownerNick: row.owner_nick,
    note: row.note,
    position: row.position,
    updatedAt: row.updated_at,
  };
}

export function getPlan(ctx: Ctx, roomId: string): Plan {
  const items = (
    ctx.db.prepare(`${SELECT_ITEM} WHERE p.room_id = ? ORDER BY p.position`).all(roomId) as PlanItemRow[]
  ).map(rowToItem);

  const notesRow = ctx.db
    .prepare('SELECT body, version, updated_at FROM plan_notes WHERE room_id = ?')
    .get(roomId) as { body: string; version: number; updated_at: string } | undefined;

  const notes: PlanNotes = notesRow
    ? { body: notesRow.body, version: notesRow.version, updatedAt: notesRow.updated_at }
    : { body: '', version: 0, updatedAt: nowIso() };

  const state = ctx.db
    .prepare(
      `SELECT s.revision, a.nick AS proposed_by, s.proposed_at
       FROM plan_state s LEFT JOIN agents a ON a.id = s.proposed_by
       WHERE s.room_id = ?`,
    )
    .get(roomId) as { revision: number; proposed_by: string | null; proposed_at: string | null } | undefined;

  const acks = ctx.db
    .prepare(
      `SELECT a.nick, k.revision, k.created_at
       FROM plan_acks k JOIN agents a ON a.id = k.agent_id
       WHERE k.room_id = ? ORDER BY k.created_at`,
    )
    .all(roomId) as { nick: string; revision: number; created_at: string }[];

  return {
    items,
    notes,
    revision: state?.revision ?? 0,
    proposedBy: state?.proposed_by ?? null,
    proposedAt: state?.proposed_at ?? null,
    acks: acks.map((a) => ({ nick: a.nick, revision: a.revision, createdAt: a.created_at })),
  };
}

/** Any change to the plan moves the revision: agreement is always about one version. */
function bumpRevision(ctx: Ctx, roomId: string): number {
  ctx.db
    .prepare(
      `INSERT INTO plan_state (room_id, revision) VALUES (?, 1)
       ON CONFLICT (room_id) DO UPDATE SET revision = revision + 1`,
    )
    .run(roomId);
  const row = ctx.db
    .prepare('SELECT revision FROM plan_state WHERE room_id = ?')
    .get(roomId) as { revision: number };
  return row.revision;
}

function getItem(ctx: Ctx, itemId: string): PlanItem | null {
  const row = ctx.db.prepare(`${SELECT_ITEM} WHERE p.id = ?`).get(itemId) as PlanItemRow | undefined;
  return row ? rowToItem(row) : null;
}

function nextPosition(ctx: Ctx, roomId: string): number {
  const row = ctx.db
    .prepare('SELECT COALESCE(MAX(position), 0) AS max FROM plan_items WHERE room_id = ?')
    .get(roomId) as { max: number };
  return row.max + 10;
}

export type ProposeResult =
  | { ok: true; plan: Plan }
  | { ok: false; error: 'already_proposed'; plan: Plan };

/**
 * The first version of the plan is published by the first agent to connect,
 * not by a human.
 *
 * It succeeds exactly once: two agents may start simultaneously, and without an
 * atomic check the second would overwrite the first or leave a duplicate beside
 * it. The latecomer gets the published plan and moves on to agreeing or objecting.
 */
export function proposePlan(
  ctx: Ctx,
  agent: Agent,
  texts: string[],
  notesBody: string | null = null,
): ProposeResult {
  ctx.db.exec('BEGIN IMMEDIATE');
  try {
    const existing = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM plan_items WHERE room_id = ?')
      .get(agent.roomId) as { n: number };

    if (existing.n > 0) {
      ctx.db.exec('COMMIT');
      return { ok: false, error: 'already_proposed', plan: getPlan(ctx, agent.roomId) };
    }

    const now = nowIso();
    let position = 10;
    for (const text of texts) {
      if (text.trim() === '') continue;
      ctx.db
        .prepare(
          `INSERT INTO plan_items (id, room_id, text, status, position, created_at, updated_at)
           VALUES (?, ?, ?, 'todo', ?, ?, ?)`,
        )
        .run(newId(), agent.roomId, text.trim(), position, now, now);
      position += 10;
    }

    if (notesBody !== null) {
      ctx.db
        .prepare(
          `INSERT INTO plan_notes (room_id, body, version, updated_at) VALUES (?, ?, 1, ?)
           ON CONFLICT (room_id) DO UPDATE SET body = excluded.body,
                                                  version = plan_notes.version + 1,
                                                  updated_at = excluded.updated_at`,
        )
        .run(agent.roomId, notesBody, now);
    }

    ctx.db
      .prepare(
        `INSERT INTO plan_state (room_id, revision, proposed_by, proposed_at) VALUES (?, 1, ?, ?)
         ON CONFLICT (room_id) DO UPDATE SET revision = 1, proposed_by = excluded.proposed_by,
                                                proposed_at = excluded.proposed_at`,
      )
      .run(agent.roomId, agent.id, now);
    ctx.db.exec('COMMIT');
  } catch (err) {
    ctx.db.exec('ROLLBACK');
    throw err;
  }

  // The author agrees with their own plan by default — otherwise the web view
  // would show them as disagreeing with themselves.
  ctx.db
    .prepare(
      `INSERT INTO plan_acks (room_id, agent_id, revision, created_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (room_id, agent_id) DO UPDATE SET revision = 1, created_at = excluded.created_at`,
    )
    .run(agent.roomId, agent.id, nowIso());

  emit(ctx, {
    roomId: agent.roomId,
    agentId: agent.id,
    kind: 'plan_change',
    payload: {
      action: 'propose',
      itemId: null,
      summary: `published a plan of ${texts.length} items`,
      revision: 1,
    },
  });
  return { ok: true, plan: getPlan(ctx, agent.roomId) };
}

export type PlanUpdateResult =
  | { ok: true; item: PlanItem }
  | { ok: false; error: 'not_found' | 'owned_by_other' | 'bad_status'; ownerNick?: string };

/**
 * Ownership works like claims: an item is changed by its owner, or by anyone
 * while it is free. Otherwise agents overwrite each other's statuses. See PLAN.md.
 */
export function updateItem(
  ctx: Ctx,
  agent: Agent,
  itemId: string,
  patch: { text?: string; status?: PlanItemStatus; note?: string | null; takeOwnership?: boolean },
): PlanUpdateResult {
  const item = getItem(ctx, itemId);
  if (!item || item.roomId !== agent.roomId) return { ok: false, error: 'not_found' };

  if (item.ownerAgentId !== null && item.ownerAgentId !== agent.id) {
    return { ok: false, error: 'owned_by_other', ownerNick: item.ownerNick ?? undefined };
  }
  if (patch.status !== undefined && !PLAN_ITEM_STATUSES.includes(patch.status)) {
    return { ok: false, error: 'bad_status' };
  }

  const text = patch.text ?? item.text;
  const status = patch.status ?? item.status;
  const note = patch.note === undefined ? item.note : patch.note;
  // Taking a free item makes you its owner: "doing" with no owner is meaningless.
  const owner =
    patch.takeOwnership || item.ownerAgentId !== null || status === 'doing'
      ? (item.ownerAgentId ?? agent.id)
      : null;

  ctx.db
    .prepare(
      `UPDATE plan_items SET text = ?, status = ?, note = ?, owner_agent_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(text, status, note, owner, nowIso(), itemId);

  const updated = getItem(ctx, itemId)!;
  // Only a change of intent moves the revision. Status and ownership are the
  // plan being executed: bumping on those would expire every acknowledgement
  // every few minutes and drown the agents in re-confirmations.
  const meaningChanged = patch.text !== undefined && patch.text !== item.text;

  emit(ctx, {
    roomId: agent.roomId,
    agentId: agent.id,
    kind: 'plan_change',
    payload: {
      action: 'update',
      itemId,
      summary: `${status}: ${text}`,
      ...(meaningChanged ? { revision: bumpRevision(ctx, agent.roomId) } : {}),
    },
  });
  return { ok: true, item: updated };
}

/** `actor === null` is a human from the CLI. */
export function addItem(
  ctx: Ctx,
  roomId: string,
  actor: Agent | null,
  text: string,
  note: string | null = null,
): PlanItem {
  const id = newId();
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO plan_items (id, room_id, text, status, note, position, created_at, updated_at)
       VALUES (?, ?, ?, 'todo', ?, ?, ?, ?)`,
    )
    .run(id, roomId, text, note, nextPosition(ctx, roomId), now, now);

  emit(ctx, {
    roomId,
    agentId: actor?.id ?? null,
    kind: 'plan_change',
    payload: { action: 'add', itemId: id, summary: text, revision: bumpRevision(ctx, roomId) },
  });
  return getItem(ctx, id)!;
}

export function claimItem(ctx: Ctx, agent: Agent, itemId: string): PlanUpdateResult {
  return updateItem(ctx, agent, itemId, { status: 'doing', takeOwnership: true });
}

export function releaseItem(ctx: Ctx, agent: Agent, itemId: string): PlanUpdateResult {
  const item = getItem(ctx, itemId);
  if (!item || item.roomId !== agent.roomId) return { ok: false, error: 'not_found' };
  if (item.ownerAgentId !== null && item.ownerAgentId !== agent.id) {
    return { ok: false, error: 'owned_by_other', ownerNick: item.ownerNick ?? undefined };
  }

  ctx.db
    .prepare(`UPDATE plan_items SET owner_agent_id = NULL, status = 'todo', updated_at = ? WHERE id = ?`)
    .run(nowIso(), itemId);

  emit(ctx, {
    roomId: agent.roomId,
    agentId: agent.id,
    kind: 'plan_change',
    payload: { action: 'update', itemId, summary: `released: ${item.text}` },
  });
  return { ok: true, item: getItem(ctx, itemId)! };
}

export type AckResult =
  | { ok: true; revision: number }
  | { ok: false; error: 'stale_revision'; current: number };

/** Agreement is about one revision: a stale acknowledgement is not accepted. */
export function ackPlan(ctx: Ctx, agent: Agent, revision: number): AckResult {
  const current = getPlan(ctx, agent.roomId).revision;
  if (revision !== current) return { ok: false, error: 'stale_revision', current };

  ctx.db
    .prepare(
      `INSERT INTO plan_acks (room_id, agent_id, revision, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (room_id, agent_id) DO UPDATE SET revision = excluded.revision,
                                                        created_at = excluded.created_at`,
    )
    .run(agent.roomId, agent.id, revision, nowIso());

  emit(ctx, {
    roomId: agent.roomId,
    agentId: agent.id,
    kind: 'plan_change',
    payload: { action: 'ack', itemId: null, summary: `agreed with plan v${revision}`, revision },
  });
  return { ok: true, revision };
}

/**
 * An objection is an explicit primitive rather than a remark in the feed:
 * otherwise disagreement dissolves into the stream and the web view cannot tell
 * whether the team agreed or simply said nothing.
 */
export function disputePlan(
  ctx: Ctx,
  agent: Agent,
  itemId: string | null,
  reason: string,
): { ok: true } {
  const revision = getPlan(ctx, agent.roomId).revision;
  ctx.db.prepare('DELETE FROM plan_acks WHERE room_id = ? AND agent_id = ?').run(agent.roomId, agent.id);

  emit(ctx, {
    roomId: agent.roomId,
    agentId: agent.id,
    kind: 'plan_change',
    payload: { action: 'dispute', itemId, summary: reason, revision },
  });
  return { ok: true };
}

export type NotesResult =
  | { ok: true; notes: PlanNotes }
  | { ok: false; error: 'version_mismatch'; current: PlanNotes };

/**
 * Free-form notes are replaced wholesale, so only with a version check:
 * otherwise two agents silently overwrite each other.
 */
export function setNotes(
  ctx: Ctx,
  roomId: string,
  actor: Agent | null,
  body: string,
  expectedVersion: number,
): NotesResult {
  const current = getPlan(ctx, roomId).notes;
  if (current.version !== expectedVersion) return { ok: false, error: 'version_mismatch', current };

  const next = current.version + 1;
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO plan_notes (room_id, body, version, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (room_id) DO UPDATE SET body = excluded.body,
                                              version = excluded.version,
                                              updated_at = excluded.updated_at`,
    )
    .run(roomId, body, next, now);

  emit(ctx, {
    roomId,
    agentId: actor?.id ?? null,
    kind: 'plan_change',
    payload: {
      action: 'notes',
      itemId: null,
      summary: 'updated the shared notes',
      revision: bumpRevision(ctx, roomId),
    },
  });
  return { ok: true, notes: { body, version: next, updatedAt: now } };
}

/** The revision this agent has not acknowledged yet, or null. */
export function planAckNeeded(ctx: Ctx, agent: Agent): number | null {
  const state = ctx.db
    .prepare('SELECT revision FROM plan_state WHERE room_id = ?')
    .get(agent.roomId) as { revision: number } | undefined;
  if (!state || state.revision === 0) return null;

  const ack = ctx.db
    .prepare('SELECT revision FROM plan_acks WHERE room_id = ? AND agent_id = ?')
    .get(agent.roomId, agent.id) as { revision: number } | undefined;

  return ack?.revision === state.revision ? null : state.revision;
}
