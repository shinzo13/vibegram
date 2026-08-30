import type { AgentCard, CardPatch, Claim, ClaimConflict, Pending, Plan } from '../../protocol/src/index.ts';
import type { Identity } from './config.ts';

/**
 * A hook is synchronous and freezes the agent, so its request to the hub is
 * hard-capped, and an unreachable hub must not paralyse work. See PLAN.md.
 */
export const HOOK_TIMEOUT_MS = 2000;

/**
 * Regular commands wait longer than a hook, but not forever: a hung hub should
 * not hang the agent outright — it cannot wait it out or intervene anyway.
 */
export const CLI_TIMEOUT_MS = 10_000;

export class HubError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function call<T>(
  identity: Pick<Identity, 'hub' | 'token'>,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs: number = CLI_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${identity.hub}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(identity.token ? { authorization: `Bearer ${identity.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new HubError(
        res.status,
        String(payload.error ?? 'error'),
        String(payload.message ?? payload.error ?? 'hub error'),
      );
    }
    return payload as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new HubError(0, 'hub_timeout', `hub ${identity.hub} is not responding`);
    }
    if (err instanceof TypeError) {
      throw new HubError(0, 'hub_unreachable', `hub ${identity.hub} is unreachable — is it running?`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function createRoom(hub: string, name: string): Promise<{ room: any; joinCode: string }> {
  return call({ hub, token: '' }, 'POST', '/api/rooms', { name });
}

export function joinRoom(
  hub: string,
  joinCode: string,
  nick: string,
  fingerprint: string | null,
): Promise<{ token: string; agent: any; room: any }> {
  return call({ hub, token: '' }, 'POST', '/api/rooms/join', { joinCode, nick, fingerprint });
}

export function rotateJoinCode(identity: Identity): Promise<{ joinCode: string }> {
  return call(identity, 'POST', '/api/rooms/rotate', {});
}

export function checkWrite(
  identity: Identity,
  resource: string,
  tool: string,
  outcome: 'blocked' | 'occurred' = 'blocked',
): Promise<{ allow: boolean; conflict: ClaimConflict | null }> {
  return call(identity, 'POST', '/api/check-write', { resource, tool, outcome }, HOOK_TIMEOUT_MS);
}

/** Other agents' claims — for parsing shell commands inside the hook. */
export function othersClaims(identity: Identity): Promise<{ claims: Claim[] }> {
  return call(identity, 'GET', '/api/claims', undefined, HOOK_TIMEOUT_MS);
}

export interface Rewind {
  /** Everything after this event id. */
  since?: number;
  /** Or simply the last N, wherever the feed happens to end. */
  last?: number;
}

export function pending(
  identity: Identity,
  limit = 30,
  fromHook = false,
  rewind: Rewind = {},
): Promise<Pending> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (rewind.since !== undefined) params.set('since', String(rewind.since));
  if (rewind.last !== undefined) params.set('last', String(rewind.last));
  // The hook flag marks this agent's interception as alive; a human rewinding
  // history is not evidence of that.
  if (fromHook) params.set('source', 'hook');

  return call(identity, 'GET', `/api/pending?${params}`, undefined, HOOK_TIMEOUT_MS);
}

export function claim(
  identity: Identity,
  resources: string[],
  note: string | null,
): Promise<{ ok: boolean; claims?: Claim[]; conflicts?: ClaimConflict[] }> {
  return call(identity, 'POST', '/api/claims', { resources, note });
}

export function release(identity: Identity, resources?: string[]): Promise<{ released: string[] }> {
  return call(identity, 'POST', '/api/claims/release', resources ? { resources } : {});
}

export function leave(identity: Identity): Promise<{ ok: boolean }> {
  return call(identity, 'POST', '/api/leave', {}, HOOK_TIMEOUT_MS);
}

export function message(identity: Identity, body: string): Promise<unknown> {
  return call(identity, 'POST', '/api/messages', { body });
}

export function getPlan(identity: Identity): Promise<Plan> {
  return call(identity, 'GET', '/api/plan');
}

export function state(identity: Identity): Promise<{ agents: AgentCard[]; claims: Claim[]; plan: Plan }> {
  return call(identity, 'GET', `/api/state?view=${encodeURIComponent(identity.viewToken)}`);
}

/** Only file names: contents never leave, and the hub needs no tokens. */
export function submitTree(
  identity: Identity,
  tracked: string[],
  untracked: string[],
): Promise<{ accepted: number; limit: number }> {
  return call(identity, 'POST', '/api/tree', { tracked, untracked });
}

export function work(identity: Identity): Promise<any> {
  return call(identity, 'GET', '/api/work');
}

export function cards(identity: Identity): Promise<{ cards: AgentCard[] }> {
  return call(identity, 'GET', '/api/cards');
}

export function setCard(identity: Identity, patch: CardPatch): Promise<{ card: AgentCard }> {
  return call(identity, 'POST', '/api/card', patch);
}
