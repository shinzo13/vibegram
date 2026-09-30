/**
 * Shared vibegram protocol: the types and pure helpers that the hub and the
 * client must agree on.
 *
 * Imported by relative path rather than as a package: node does not strip types
 * inside node_modules, which is where workspaces symlink packages. See PLAN.md.
 *
 * No `enum` and no `namespace` here — native type stripping rejects both.
 */

export const PROTOCOL_VERSION = 1;

// ─── rooms ───────────────────────────────────────────────────────────────────

/**
 * A room is where a team coordinates. It has an identity of its own rather than
 * being derived from the repository: two teams can work on the same public repo,
 * and a commit hash is known to anyone who cloned it — it separates nothing and
 * protects nothing.
 */
export interface Room {
  id: string;
  name: string;
  /** Read-only token. Safe to show on stage or paste into a group chat. */
  viewToken: string;
  /** Hash of the first commit, recorded when the first agent joins. */
  repoFingerprint: string | null;
  createdAt: string;
}

/** Returned once, at creation and after a rotation: the join code is never stored in clear. */
export interface RoomSecrets {
  room: Room;
  joinCode: string;
}

// ─── participants ────────────────────────────────────────────────────────────

/** Platform is derived from the nick prefix: claude-alice -> claude. */
export type Platform = 'claude' | 'chatgpt' | 'cursor' | 'codex' | 'human' | 'other';

export const PLATFORMS: readonly Platform[] = ['claude', 'chatgpt', 'cursor', 'codex', 'human', 'other'];

export type AgentStatus = 'online' | 'offline';

export interface Agent {
  id: string;
  nick: string;
  platform: Platform;
  roomId: string;
  status: AgentStatus;
  lastSeenAt: string;
}

// ─── agent card ──────────────────────────────────────────────────────────────

/**
 * Who an agent is and what it does — in the spirit of an A2A agent card, with
 * two additions without which coordination does not work:
 *
 *  - `focus` — what it is busy with right now (what it holds, which plan item
 *    it took). A2A describes static service capabilities; picking whether to
 *    approach someone needs live state.
 *  - `branch` — every agent works in its own clone.
 *
 * The point is that on a conflict an agent knows not just "bob holds this
 * file", but who bob is, what they are doing, and whether to go there.
 */
export interface AgentCard {
  nick: string;
  platform: Platform;
  status: AgentStatus;
  /** What this agent does on the team: "backend and migrations". */
  description: string | null;
  /** What it picks up most readily: ['svelte', 'css', 'layout']. */
  skills: string[];
  model: string | null;
  branch: string | null;
  lastSeenAt: string;
  /**
   * Whether a hook has ever reported in for this agent. False means it works
   * without write interception — visible to everyone, so the team knows who
   * the automation covers and who is coordinating by hand.
   */
  hooksAlive: boolean;
  focus: AgentFocus;
}

export interface AgentFocus {
  /** What the agent holds right now. */
  holding: string[];
  /** The plan item it took, if any. */
  planItem: { id: string; text: string } | null;
}

export interface CardPatch {
  description?: string | null;
  skills?: string[];
  model?: string | null;
  branch?: string | null;
}

// ─── claims ──────────────────────────────────────────────────────────────────

export type ClaimStatus = 'active' | 'released';

export interface Claim {
  id: string;
  roomId: string;
  agentId: string;
  /** Denormalised for the feed and the web: every view of a claim needs it. */
  nick: string;
  /** Normalised path or directory prefix. See normalizeResource. */
  resource: string;
  note: string | null;
  planItemId: string | null;
  status: ClaimStatus;
  createdAt: string;
  releasedAt: string | null;
}

/** A refusal carries enough for the agent to know who to talk to. */
export interface ClaimConflict {
  resource: string;
  heldBy: string;
  since: string;
  note: string | null;
  planItemId: string | null;
}

export type ClaimResult =
  | { ok: true; claims: Claim[] }
  | { ok: false; conflicts: ClaimConflict[] };

// ─── feed ────────────────────────────────────────────────────────────────────

export type EventKind =
  | 'message'
  | 'agent_join'
  | 'agent_leave'
  | 'claim'
  | 'release'
  | 'claim_denied'
  | 'violation'
  | 'plan_change';

export const EVENT_KINDS: readonly EventKind[] = [
  'message',
  'agent_join',
  'agent_leave',
  'claim',
  'release',
  'claim_denied',
  'violation',
  'plan_change',
];

export interface MessagePayload {
  body: string;
  mentions: string[];
}

export interface ClaimPayload {
  resources: string[];
  note: string | null;
  planItemId: string | null;
}

export interface ReleasePayload {
  resources: string[];
}

/** An agent was refused a claim: someone already holds the resource. */
export interface ClaimDeniedPayload {
  requested: string[];
  conflicts: ClaimConflict[];
}

/** A write into someone else's resource — where blocking is impossible (cursor, codex). */
export interface ViolationPayload {
  resource: string;
  heldBy: string;
  /** blocked — the write was stopped; occurred — it already happened. */
  outcome: 'blocked' | 'occurred';
  tool: string | null;
}

export interface PlanChangePayload {
  action: 'propose' | 'add' | 'update' | 'remove' | 'notes' | 'ack' | 'dispute';
  itemId: string | null;
  summary: string;
  revision?: number;
}

export type EventPayload =
  | MessagePayload
  | ClaimPayload
  | ReleasePayload
  | ClaimDeniedPayload
  | ViolationPayload
  | PlanChangePayload
  | Record<string, never>;

export interface Event {
  /** A monotonic autoincrement, which doubles as the unread cursor. */
  id: number;
  roomId: string;
  agentId: string | null;
  nick: string | null;
  kind: EventKind;
  payload: EventPayload;
  createdAt: string;
}

// ─── plan ────────────────────────────────────────────────────────────────────

export type PlanItemStatus = 'todo' | 'doing' | 'done' | 'blocked';

export const PLAN_ITEM_STATUSES: readonly PlanItemStatus[] = ['todo', 'doing', 'done', 'blocked'];

export interface PlanItem {
  id: string;
  roomId: string;
  text: string;
  status: PlanItemStatus;
  ownerAgentId: string | null;
  ownerNick: string | null;
  note: string | null;
  position: number;
  updatedAt: string;
}

export interface PlanNotes {
  body: string;
  /** Optimistic locking: a write against a stale version is rejected. */
  version: number;
  updatedAt: string;
}

export interface PlanAck {
  nick: string;
  revision: number;
  createdAt: string;
}

export interface Plan {
  items: PlanItem[];
  notes: PlanNotes;
  /** Bumped by any change to the plan; agreement is always about one revision. */
  revision: number;
  /** Who published the first version. */
  proposedBy: string | null;
  proposedAt: string | null;
  acks: PlanAck[];
}

// ─── unread ──────────────────────────────────────────────────────────────────

/**
 * Rides along with the result of every MCP tool. The cursor lives on the server
 * keyed by agent id; the client remembers nothing.
 */
export interface Pending {
  events: Event[];
  cursor: number;
  /** How much was filtered out as irrelevant, so the agent knows the feed is alive. */
  skipped: number;
  /**
   * The plan revision this agent has not acknowledged yet, or null.
   * Carried on every response: an agent should learn that the shared intent
   * changed without having to ask. See PLAN.md.
   */
  planAckNeeded: number | null;
}

// ─── resources ───────────────────────────────────────────────────────────────

/**
 * Canonicalises a resource: posix separators, no leading slash, no `./`,
 * a mandatory trailing `/` on directories.
 *
 * Storing them unnormalised is not an option: the resource hierarchy would not
 * work later, and fixing it would mean rewriting stored data. See PLAN.md.
 */
export function normalizeResource(raw: string): string {
  let r = raw.trim().replace(/\\/g, '/');
  const isDir = r.endsWith('/');

  const parts: string[] = [];
  for (const segment of r.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Escaping the project root is collapsed rather than rejected: a hook may
      // send a path from someone else's clone, and that is no reason to fail.
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  r = parts.join('/');
  if (r === '') return '/';
  return isDir ? `${r}/` : r;
}

/**
 * Resources are always relative to the repository root: every agent has its own
 * clone, and absolute paths from different machines are not comparable.
 *
 * The client does the conversion — it knows the root; the hub rejects absolute
 * paths. Silently normalising one is worse than refusing it: `/Users/a/proj/src/x.ts`
 * would become `Users/a/proj/src/x.ts`, never match anything, and the protection
 * would look like it works while protecting nothing.
 */
export function isRelativeResource(raw: string): boolean {
  const r = raw.trim().replace(/\\/g, '/');
  return r !== '' && !r.startsWith('/') && !/^[a-zA-Z]:\//.test(r);
}

/**
 * Whether two resources overlap. The single place where claim granularity is
 * defined: with ten agents a directory prefix will start colliding too often
 * and this will have to go down to files — change it here. See PLAN.md.
 */
export function resourcesConflict(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === '/' || b === '/') return true;
  const aDir = a.endsWith('/') ? a : `${a}/`;
  const bDir = b.endsWith('/') ? b : `${b}/`;
  return aDir.startsWith(bDir) || bDir.startsWith(aDir);
}

/** claude-alice -> claude, chatgpt-carol -> chatgpt. */
export function platformFromNick(nick: string): Platform {
  const prefix = nick.split('-')[0]?.toLowerCase() ?? '';
  return (PLATFORMS as readonly string[]).includes(prefix) ? (prefix as Platform) : 'other';
}

const NICK_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;

/** A nick is a codename like `claude-alice`: platform, dash, callsign. */
export function isValidNick(nick: string): boolean {
  return NICK_RE.test(nick) && nick.length <= 48;
}
