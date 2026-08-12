import type {
  Agent,
  ClaimDeniedPayload,
  ClaimPayload,
  Event,
  MessagePayload,
  Pending,
  ReleasePayload,
  ViolationPayload,
} from '../../../protocol/src/index.ts';
import { resourcesConflict } from '../../../protocol/src/index.ts';
import { type Ctx, emit, rowToEvent, SELECT_EVENT_SQL } from './ctx.ts';
import { listClaims } from './claims.ts';
import { planAckNeeded } from './plan.ts';

export const MESSAGE_INTERVAL_MS = 10_000;

export type PostMessageResult =
  | { ok: true; event: Event }
  | { ok: false; error: 'rate_limited'; retryAfterMs: number }
  | { ok: false; error: 'empty' };

const MENTION_RE = /@([a-z0-9]+(?:-[a-z0-9]+)+)/g;

/**
 * The feed is a noticeboard, not a conversation: "reworking routing, stay out".
 * Hence the rate limit — chatter burns context for every participant at once.
 */
export function postMessage(ctx: Ctx, agent: Agent, body: string): PostMessageResult {
  const text = body.trim();
  if (text === '') return { ok: false, error: 'empty' };

  const last = ctx.db
    .prepare(
      `SELECT created_at FROM events
       WHERE agent_id = ? AND kind = 'message'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(agent.id) as { created_at: string } | undefined;

  if (last) {
    const elapsed = Date.now() - new Date(last.created_at).getTime();
    if (elapsed < MESSAGE_INTERVAL_MS) {
      return { ok: false, error: 'rate_limited', retryAfterMs: MESSAGE_INTERVAL_MS - elapsed };
    }
  }

  const nicks = [...new Set(Array.from(text.matchAll(MENTION_RE), (m) => m[1]))];
  const mentionIds: string[] = [];
  const mentioned: string[] = [];
  for (const nick of nicks) {
    const row = ctx.db
      .prepare('SELECT id FROM agents WHERE room_id = ? AND nick = ?')
      .get(agent.roomId, nick) as { id: string } | undefined;
    if (row) {
      mentionIds.push(row.id);
      mentioned.push(nick);
    }
  }

  const payload: MessagePayload = { body: text, mentions: mentioned };
  const event = emit(ctx, {
    roomId: agent.roomId,
    agentId: agent.id,
    kind: 'message',
    payload,
    mentions: mentionIds,
  });
  return { ok: true, event };
}

export function listEvents(ctx: Ctx, roomId: string, after = 0, limit = 200): Event[] {
  const rows = ctx.db
    .prepare(`${SELECT_EVENT_SQL} WHERE e.room_id = ? AND e.id > ? ORDER BY e.id LIMIT ?`)
    .all(roomId, after, limit);
  return (rows as Parameters<typeof rowToEvent>[0][]).map(rowToEvent);
}

/**
 * Whether an event is relevant to a particular agent.
 *
 * The filter is on from the start rather than "once it gets noisy": with ten
 * agents a shared feed in everyone's context is a tenfold token cost across the
 * whole team. See PLAN.md.
 */
function isRelevant(ctx: Ctx, agent: Agent, event: Event, myResources: string[]): boolean {
  switch (event.kind) {
    // Announcements and changes to the shared plan concern everyone by definition.
    case 'message':
    case 'plan_change':
    case 'agent_join':
    case 'agent_leave':
      return true;

    // Someone else's claims matter only when they touch what I hold.
    case 'claim':
    case 'release': {
      const payload = event.payload as ClaimPayload | ReleasePayload;
      return payload.resources.some((r) => myResources.some((mine) => resourcesConflict(r, mine)));
    }

    // Someone was refused because of my claim — they are waiting on me.
    case 'claim_denied': {
      const payload = event.payload as ClaimDeniedPayload;
      return payload.conflicts.some((c) => c.heldBy === agent.nick);
    }

    // Someone went into my resource.
    case 'violation':
      return (event.payload as ViolationPayload).heldBy === agent.nick;

    default:
      return false;
  }
}

/**
 * Unread activity for an agent. The cursor moves to the end of the inspected
 * window, filtered items included — otherwise skipped events would be
 * re-examined forever.
 */
export function pendingFor(ctx: Ctx, agent: Agent, limit = 50): Pending {
  const row = ctx.db
    .prepare('SELECT last_event_id FROM cursors WHERE agent_id = ?')
    .get(agent.id) as { last_event_id: number } | undefined;
  const cursor = row?.last_event_id ?? 0;

  const ackNeeded = planAckNeeded(ctx, agent);
  const window = listEvents(ctx, agent.roomId, cursor, limit);
  if (window.length === 0) {
    return { events: [], cursor, skipped: 0, planAckNeeded: ackNeeded };
  }

  const myResources = listClaims(ctx, agent.roomId)
    .filter((c) => c.agentId === agent.id)
    .map((c) => c.resource);

  const events: Event[] = [];
  let skipped = 0;
  for (const event of window) {
    // An agent's own events are of no use to it and do not count as skipped.
    if (event.agentId === agent.id) continue;
    if (isRelevant(ctx, agent, event, myResources)) events.push(event);
    else skipped += 1;
  }

  const newCursor = window[window.length - 1]!.id;
  ctx.db.prepare('UPDATE cursors SET last_event_id = ? WHERE agent_id = ?').run(newCursor, agent.id);

  return { events, cursor: newCursor, skipped, planAckNeeded: ackNeeded };
}
