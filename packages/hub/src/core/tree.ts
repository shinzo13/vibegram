import type { Claim } from '../../../protocol/src/index.ts';
import { normalizeResource, resourcesConflict } from '../../../protocol/src/index.ts';
import { nowIso } from '../db.ts';
import type { Ctx } from './ctx.ts';
import { listClaims } from './claims.ts';

/** A cap on one snapshot: the tree is an overview, not a monorepo index. */
export const MAX_PATHS = 5000;

export interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  /** Present on someone's disk only; git does not track it. */
  tracked: boolean;
  /** Who holds this path, or the directory it sits in. */
  heldBy: string | null;
  heldNote: string | null;
  /** The claim is on this very node rather than inherited from a parent. */
  heldHere: boolean;
}

/**
 * A snapshot from one agent. It fully replaces that agent's previous
 * contribution: files it deleted or switched away from must disappear.
 */
export function submitTree(
  ctx: Ctx,
  roomId: string,
  agentId: string,
  tracked: string[],
  untracked: string[],
): number {
  const seen = nowIso();
  const rows: { path: string; tracked: number }[] = [];

  for (const raw of tracked.slice(0, MAX_PATHS)) {
    const path = normalizeResource(raw);
    if (path !== '/' && path !== '') rows.push({ path, tracked: 1 });
  }
  for (const raw of untracked.slice(0, MAX_PATHS)) {
    const path = normalizeResource(raw);
    if (path !== '/' && path !== '') rows.push({ path, tracked: 0 });
  }

  ctx.db.exec('BEGIN IMMEDIATE');
  try {
    ctx.db.prepare('DELETE FROM tree_paths WHERE room_id = ? AND agent_id = ?').run(roomId, agentId);
    const insert = ctx.db.prepare(
      `INSERT INTO tree_paths (room_id, path, agent_id, tracked, seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (room_id, path) DO UPDATE SET agent_id = excluded.agent_id,
                                                    tracked = MAX(tree_paths.tracked, excluded.tracked),
                                                    seen_at = excluded.seen_at`,
    );
    for (const row of rows) insert.run(roomId, row.path, agentId, row.tracked, seen);
    ctx.db.exec('COMMIT');
  } catch (err) {
    ctx.db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

function holderFor(claims: Claim[], path: string): { claim: Claim; here: boolean } | null {
  for (const claim of claims) {
    if (claim.resource === path) return { claim, here: true };
    // A claim on a directory covers everything beneath it.
    if (claim.resource.endsWith('/') && resourcesConflict(path, claim.resource)) {
      return { claim, here: false };
    }
  }
  return null;
}

/**
 * The tree with claims applied. Rebuilt per request: there are few paths, and
 * storing derived state is a way to get it out of sync.
 */
export function getTree(ctx: Ctx, roomId: string): TreeNode[] {
  const rows = ctx.db
    .prepare('SELECT path, tracked FROM tree_paths WHERE room_id = ? ORDER BY path')
    .all(roomId) as { path: string; tracked: number }[];

  const claims = listClaims(ctx, roomId);
  const root: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();

  const ensureDir = (path: string): TreeNode => {
    const existing = dirs.get(path);
    if (existing) return existing;

    const parts = path.split('/').filter(Boolean);
    const name = parts[parts.length - 1] ?? path;
    const holder = holderFor(claims, `${path}/`);
    const node: TreeNode = {
      name,
      path: `${path}/`,
      children: [],
      tracked: true,
      heldBy: holder?.claim.nick ?? null,
      heldNote: holder?.claim.note ?? null,
      heldHere: holder?.claim.resource === `${path}/`,
    };
    dirs.set(path, node);

    const parentPath = parts.slice(0, -1).join('/');
    if (parentPath === '') root.push(node);
    else ensureDir(parentPath).children.push(node);
    return node;
  };

  for (const row of rows) {
    const parts = row.path.split('/').filter(Boolean);
    const name = parts[parts.length - 1]!;
    const holder = holderFor(claims, row.path);

    const node: TreeNode = {
      name,
      path: row.path,
      children: [],
      tracked: row.tracked === 1,
      heldBy: holder?.claim.nick ?? null,
      heldNote: holder?.claim.note ?? null,
      heldHere: holder?.here ?? false,
    };

    const parentPath = parts.slice(0, -1).join('/');
    if (parentPath === '') root.push(node);
    else ensureDir(parentPath).children.push(node);
  }

  // A claim can name a directory the tree has not heard of yet: an agent took
  // src/api/ before anyone sent a snapshot. Show those nodes anyway.
  for (const claim of claims) {
    if (!claim.resource.endsWith('/')) continue;
    const path = claim.resource.slice(0, -1);
    if (!dirs.has(path)) ensureDir(path);
  }

  const sort = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      const aDir = a.children.length > 0 || a.path.endsWith('/');
      const bDir = b.children.length > 0 || b.path.endsWith('/');
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) sort(node.children);
    return nodes;
  };

  return sort(root);
}
