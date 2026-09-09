import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Room, RoomSecrets } from '../../../protocol/src/index.ts';
import { nowIso } from '../db.ts';
import type { Ctx } from './ctx.ts';

/**
 * Alphabet without look-alikes: a join code gets read aloud and retyped, and
 * confusing 0 with O costs more than the four characters it saves.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** The view token uses plain uppercase + digits: it reads as a code, not a word. */
const VIEW_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomCode(length: number, alphabet: string = ALPHABET): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The view token ends up in a link that gets shown on a projector and retyped
 * by hand, so it is kept short: six characters of `A-Z0-9`, ~2.2 billion
 * combinations.
 *
 * This is a deliberate trade. Eight characters put a brute-force scan decades
 * out; six brings it back to weeks at a thousand requests per second, and the
 * prize is a team's file names and agent chatter. The bet is that a leaked
 * link is handled by rotation (`vibegram room rotate`), and that a link nobody
 * minds typing is worth more day to day than the extra scan resistance.
 *
 * Uppercase and no dash, so it is never confused with the lowercase dashed
 * join code it is handed out alongside — mixing them up either locks the team
 * out or hands the way in to an audience.
 */
function randomViewToken(): string {
  return randomCode(6, VIEW_ALPHABET);
}

interface RoomRow {
  id: string;
  name: string;
  view_token: string;
  repo_fingerprint: string | null;
  created_at: string;
}

function rowToRoom(row: RoomRow): Room {
  return {
    id: row.id,
    name: row.name,
    viewToken: row.view_token,
    repoFingerprint: row.repo_fingerprint,
    createdAt: row.created_at,
  };
}

const ROOM_COLS = 'id, name, view_token, repo_fingerprint, created_at';

/**
 * Creates a room and returns its secrets once.
 *
 * The join code is stored hashed: a hub database that leaks must not hand out
 * the way into every room with it.
 */
export function createRoom(ctx: Ctx, name: string): RoomSecrets {
  // Short id: it is quoted in error messages and logs, and never used as a
  // credential — the join code and the view token are.
  const id = randomCode(8);
  const joinCode = `${randomCode(4)}-${randomCode(4)}`;
  const viewToken = randomViewToken();

  ctx.db
    .prepare(
      `INSERT INTO rooms (id, name, join_code_hash, view_token, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, name.trim() === '' ? id : name.trim(), hash(joinCode), viewToken, nowIso());

  ctx.db
    .prepare(`INSERT INTO plan_notes (room_id, body, version, updated_at) VALUES (?, '', 0, ?)`)
    .run(id, nowIso());

  return { room: getRoom(ctx, id)!, joinCode };
}

export function getRoom(ctx: Ctx, id: string): Room | null {
  const row = ctx.db.prepare(`SELECT ${ROOM_COLS} FROM rooms WHERE id = ?`).get(id) as RoomRow | undefined;
  return row ? rowToRoom(row) : null;
}

/** The web view resolves a room by its read-only token and nothing else. */
export function roomByViewToken(ctx: Ctx, token: string): Room | null {
  const row = ctx.db.prepare(`SELECT ${ROOM_COLS} FROM rooms WHERE view_token = ?`).get(token) as
    | RoomRow
    | undefined;
  return row ? rowToRoom(row) : null;
}

export function roomByJoinCode(ctx: Ctx, code: string): Room | null {
  const digest = hash(code.trim().toLowerCase());
  const rows = ctx.db.prepare(`SELECT ${ROOM_COLS}, join_code_hash FROM rooms`).all() as (RoomRow & {
    join_code_hash: string;
  })[];

  for (const row of rows) {
    const a = Buffer.from(row.join_code_hash, 'hex');
    const b = Buffer.from(digest, 'hex');
    if (a.length === b.length && timingSafeEqual(a, b)) return rowToRoom(row);
  }
  return null;
}

/** Rotation is the answer to a leaked code: the room survives, the old code dies. */
export function rotateJoinCode(ctx: Ctx, roomId: string): string {
  const joinCode = `${randomCode(4)}-${randomCode(4)}`;
  ctx.db.prepare('UPDATE rooms SET join_code_hash = ? WHERE id = ?').run(hash(joinCode), roomId);
  return joinCode;
}

export type FingerprintResult = { ok: true } | { ok: false; expected: string };

/**
 * The repository fingerprint is recorded by the first agent to join and checked
 * for everyone after.
 *
 * It grants nothing — it only catches the most common mistake there is: running
 * join from the wrong directory, and finding out half an hour later when the
 * agents cannot see each other.
 */
export function checkFingerprint(ctx: Ctx, roomId: string, fingerprint: string | null): FingerprintResult {
  if (!fingerprint) return { ok: true };

  const room = getRoom(ctx, roomId);
  if (!room) return { ok: true };

  if (room.repoFingerprint === null) {
    ctx.db.prepare('UPDATE rooms SET repo_fingerprint = ? WHERE id = ?').run(fingerprint, roomId);
    return { ok: true };
  }
  return room.repoFingerprint === fingerprint ? { ok: true } : { ok: false, expected: room.repoFingerprint };
}
