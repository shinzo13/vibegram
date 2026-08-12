import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Event, EventKind, EventPayload } from '../../../protocol/src/index.ts';
import { nowIso } from '../db.ts';

/**
 * The core knows nothing about http or server-sent events: it writes to the
 * database and emits onto a bus. Transports subscribe themselves — so that an
 * A2A facade can be added later without touching the logic. See PLAN.md.
 */
export interface Ctx {
  db: DatabaseSync;
  bus: EventEmitter;
}

export function createCtx(db: DatabaseSync): Ctx {
  return { db, bus: new EventEmitter() };
}

export function newId(): string {
  return randomUUID();
}

interface EventRow {
  id: number;
  room_id: string;
  agent_id: string | null;
  nick: string | null;
  kind: string;
  payload: string;
  created_at: string;
}

export function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    roomId: row.room_id,
    agentId: row.agent_id,
    nick: row.nick,
    kind: row.kind as EventKind,
    payload: JSON.parse(row.payload) as EventPayload,
    createdAt: row.created_at,
  };
}

const SELECT_EVENT = `
  SELECT e.id, e.room_id, e.agent_id, a.nick AS nick,
         e.kind, e.payload, e.created_at
  FROM events e
  LEFT JOIN agents a ON a.id = e.agent_id
`;

export const SELECT_EVENT_SQL = SELECT_EVENT;

/** The single write path into the feed: everything that happens goes through here. */
export function emit(
  ctx: Ctx,
  input: {
    roomId: string;
    agentId: string | null;
    kind: EventKind;
    payload: EventPayload;
    mentions?: string[];
  },
): Event {
  const { lastInsertRowid } = ctx.db
    .prepare(
      `INSERT INTO events (room_id, agent_id, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.roomId,
      input.agentId,
      input.kind,
      JSON.stringify(input.payload),
      nowIso(),
    );

  const eventId = Number(lastInsertRowid);

  for (const agentId of input.mentions ?? []) {
    ctx.db
      .prepare('INSERT OR IGNORE INTO mentions (event_id, agent_id) VALUES (?, ?)')
      .run(eventId, agentId);
  }

  const row = ctx.db.prepare(`${SELECT_EVENT} WHERE e.id = ?`).get(eventId) as EventRow;
  const event = rowToEvent(row);
  ctx.bus.emit('event', event);
  return event;
}
