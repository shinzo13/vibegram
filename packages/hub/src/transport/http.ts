import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, Event } from '../../../protocol/src/index.ts';
import { PROTOCOL_VERSION, isRelativeResource } from '../../../protocol/src/index.ts';
import * as core from '../core/index.ts';
import type { Ctx } from '../core/index.ts';

interface Req {
  ctx: Ctx;
  url: URL;
  body: unknown;
  agent: Agent | null;
}

type Handler = (req: Req) => unknown;

// No parameter properties: native type stripping does not support them.
class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

function requireAgent(req: Req): Agent {
  if (!req.agent) throw new HttpError(401, 'unauthorized', 'an agent token is required');
  return req.agent;
}

function field<T>(body: unknown, name: string): T | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  return (body as Record<string, T>)[name];
}

function requireString(body: unknown, name: string): string {
  const value = field<unknown>(body, name);
  if (typeof value !== 'string' || value === '') {
    throw new HttpError(400, 'bad_request', `field ${name} is required`);
  }
  return value;
}

/**
 * An absolute path is rejected rather than normalised: every agent has its own
 * clone, and a path from another machine would never match anything — the
 * protection would look like it works while protecting nothing. The client is
 * responsible for making paths relative.
 */
function requireResources(body: unknown): string[] {
  const raw = field<unknown>(body, 'resources');
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, 'bad_request', 'a non-empty resources list is required');
  }
  const bad = raw.filter((r) => typeof r !== 'string' || !isRelativeResource(r));
  if (bad.length > 0) {
    throw new HttpError(
      400,
      'absolute_resource',
      `paths must be relative to the repository root: ${bad.join(', ')}`,
    );
  }
  return raw as string[];
}


/**
 * Read access is resolved by the view token alone.
 *
 * The room id deliberately does not work here: it travels through logs and
 * error messages, and if it granted read access, a public hub would leak every
 * team's feed and file names to anyone who saw one. See PLAN.md.
 */
function requireRoomByView(req: Req) {
  const token = req.url.searchParams.get('view');
  if (!token) throw new HttpError(400, 'bad_request', 'a view token is required');
  const room = core.roomByViewToken(req.ctx, token);
  if (!room) throw new HttpError(404, 'not_found', 'no room matches that view token');
  return room;
}

const routes: Record<string, Handler> = {
  'GET /api/health': () => ({ ok: true, protocol: PROTOCOL_VERSION }),

  /**
   * The hub's own card, in the spirit of A2A. Groundwork for now: there is
   * nothing to swap our transport for yet, but an external agent needs some way
   * to learn what this service is and what it can do.
   */
  'GET /.well-known/agent-card.json': ({ url }) => ({
    name: 'vibegram',
    description:
      'Coordination for coding agents in one repository: claims on files, a shared plan, an event feed.',
    version: '0.1.0',
    url: `${url.protocol}//${url.host}/api`,
    protocolVersion: String(PROTOCOL_VERSION),
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      { id: 'claim', name: 'Resource claims', description: 'Claim a file or directory before editing', tags: ['locks'] },
      { id: 'plan', name: 'Shared plan', description: 'Publishing, agreement and objections on the team plan', tags: ['planning'] },
      { id: 'feed', name: 'Event feed', description: 'Announcements and coordination events', tags: ['messaging'] },
    ],
  }),

  /** Creating a room hands back its secrets once — the join code is stored hashed. */
  'POST /api/rooms': ({ ctx, body }) => {
    const name = field<string>(body, 'name') ?? '';
    const { room, joinCode } = core.createRoom(ctx, name);
    return { room, joinCode };
  },

  /**
   * Joining takes the code, not the room id. The id is not a credential: it
   * shows up in logs and error messages, and a room must not be enterable by
   * something people paste around casually.
   */
  'POST /api/rooms/join': ({ ctx, body }) => {
    const room = core.roomByJoinCode(ctx, requireString(body, 'joinCode'));
    if (!room) throw new HttpError(404, 'bad_join_code', 'no room matches that join code');

    const fingerprint = field<string>(body, 'fingerprint') ?? null;
    const check = core.checkFingerprint(ctx, room.id, fingerprint);
    if (!check.ok) {
      throw new HttpError(
        409,
        'wrong_repository',
        `room "${room.name}" belongs to a different repository — are you in the right directory?`,
      );
    }

    const nick = requireString(body, 'nick');
    const result = core.joinRoom(ctx, room.id, nick);
    if (!result.ok) {
      const message =
        result.error === 'nick_taken'
          ? `the nick ${nick} is already taken in this room — pick another codename`
          : 'a nick must look like claude-alice: platform, dash, callsign';
      throw new HttpError(409, result.error, message);
    }
    return { token: result.token, agent: result.agent, room };
  },

  /** A leaked code is survivable: the room stays, the old code stops working. */
  'POST /api/rooms/rotate': (req) => {
    const agent = requireAgent(req);
    return { joinCode: core.rotateJoinCode(req.ctx, agent.roomId) };
  },

  'GET /api/room': (req) => {
    const agent = requireAgent(req);
    return { room: core.getRoom(req.ctx, agent.roomId) };
  },

  'POST /api/heartbeat': (req) => {
    const agent = requireAgent(req);
    core.heartbeat(req.ctx, agent.id);
    // The branch changes as work goes on — refresh it along with liveness.
    const branch = field<string>(req.body, 'branch');
    if (branch) core.setCard(req.ctx, agent.id, { branch });
    return { ok: true };
  },

  'POST /api/leave': (req) => {
    const agent = requireAgent(req);
    core.releaseResources(req.ctx, agent);
    core.markOffline(req.ctx, agent.id);
    return { ok: true };
  },

  'GET /api/pending': (req) => {
    const agent = requireAgent(req);
    core.heartbeat(req.ctx, agent.id);
    if (req.url.searchParams.get('source') === 'hook') core.markHooksAlive(req.ctx, agent.id);

    const number = (name: string): number | undefined => {
      const raw = req.url.searchParams.get(name);
      if (raw === null) return undefined;
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new HttpError(400, 'bad_request', `${name} must be a number`);
      return value;
    };

    return core.pendingFor(
      req.ctx,
      agent,
      number('limit') ?? 50,
      number('since'),
      number('last'),
    );
  },

  'POST /api/messages': (req) => {
    const agent = requireAgent(req);
    const result = core.postMessage(req.ctx, agent, requireString(req.body, 'body'));
    if (!result.ok) {
      if (result.error === 'rate_limited') {
        throw new HttpError(
          429,
          'rate_limited',
          `at most one message per 10 seconds, wait ${Math.ceil(result.retryAfterMs / 1000)}s`,
        );
      }
      throw new HttpError(400, result.error, 'empty message');
    }
    return { event: result.event };
  },

  'POST /api/claims': (req) => {
    const agent = requireAgent(req);
    return core.claimResources(
      req.ctx,
      agent,
      requireResources(req.body),
      field<string>(req.body, 'note') ?? null,
      field<string>(req.body, 'planItemId') ?? null,
    );
  },

  'POST /api/claims/release': (req) => {
    const agent = requireAgent(req);
    const raw = field<unknown>(req.body, 'resources');
    const resources = Array.isArray(raw) ? requireResources(req.body) : undefined;
    return { released: core.releaseResources(req.ctx, agent, resources) };
  },

  /** The PreToolUse hot path: must answer in milliseconds, the hook freezes the agent. */
  'POST /api/check-write': (req) => {
    const agent = requireAgent(req);
    // Only a hook calls this, so it doubles as proof the hooks are wired up.
    core.markHooksAlive(req.ctx, agent.id);
    const resource = requireString(req.body, 'resource');
    if (!isRelativeResource(resource)) {
      throw new HttpError(400, 'absolute_resource', 'the path must be relative to the repository root');
    }
    const conflict = core.checkWrite(req.ctx, agent, resource);
    if (conflict) {
      const outcome = field<string>(req.body, 'outcome') === 'occurred' ? 'occurred' : 'blocked';
      core.reportViolation(
        req.ctx,
        agent,
        resource,
        conflict,
        outcome,
        field<string>(req.body, 'tool') ?? null,
      );
    }
    return { allow: conflict === null, conflict };
  },

  /** A light list of other agents' claims, for parsing shell commands in the hook. */
  'GET /api/claims': (req) => {
    const agent = requireAgent(req);
    return {
      claims: core.listClaims(req.ctx, agent.roomId).filter((claim) => claim.agentId !== agent.id),
    };
  },

  /**
   * A snapshot of paths from a client. The hub never clones a repository and
   * stores no tokens: the agent is already authenticated in its own copy and
   * sends nothing but file names.
   */
  'POST /api/tree': (req) => {
    const agent = requireAgent(req);
    const tracked = field<unknown>(req.body, 'tracked');
    const untracked = field<unknown>(req.body, 'untracked');
    const count = core.submitTree(
      req.ctx,
      agent.roomId,
      agent.id,
      Array.isArray(tracked) ? tracked.map(String) : [],
      Array.isArray(untracked) ? untracked.map(String) : [],
    );
    return { accepted: count, limit: core.MAX_PATHS };
  },

  'GET /api/tree': (req) => {
    const room = requireRoomByView(req);
    return { tree: core.getTree(req.ctx, room.id) };
  },

  /** An agent's card: who they are, what they can do, what they are busy with. */
  'POST /api/card': (req) => {
    const agent = requireAgent(req);
    const skills = field<unknown>(req.body, 'skills');
    core.setCard(req.ctx, agent.id, {
      description: field<string>(req.body, 'description'),
      skills: Array.isArray(skills) ? skills.map(String) : undefined,
      model: field<string>(req.body, 'model'),
      branch: field<string>(req.body, 'branch'),
    });
    return { card: core.getCard(req.ctx, agent.roomId, agent.nick) };
  },

  'GET /api/cards': (req) => {
    const agent = req.agent;
    const roomId = agent ? agent.roomId : requireRoomByView(req).id;
    return { cards: core.listCards(req.ctx, roomId) };
  },

  /**
   * "What can be picked up right now": free plan items, claimed areas and what
   * everyone else is doing. The agent shows this to the human and waits for a
   * choice — it does not assign work to itself. See PLAN.md.
   */
  'GET /api/work': (req) => {
    const agent = requireAgent(req);
    const plan = core.getPlan(req.ctx, agent.roomId);
    const claims = core.listClaims(req.ctx, agent.roomId);

    return {
      free: plan.items.filter((item) => item.ownerAgentId === null && item.status !== 'done'),
      taken: plan.items.filter((item) => item.ownerAgentId !== null && item.status !== 'done'),
      busy: claims.map((claim) => ({ resource: claim.resource, nick: claim.nick, note: claim.note })),
      cards: core.listCards(req.ctx, agent.roomId).filter((card) => card.nick !== agent.nick),
      planRevision: plan.revision,
    };
  },

  'GET /api/state': (req) => {
    const room = requireRoomByView(req);
    const after = req.url.searchParams.get('after');
    return {
      room: { id: room.id, name: room.name },
      // Cards rather than bare nicks: the web view and agents both need to know
      // who these agents are and what they are doing, not merely that they exist.
      agents: core.listCards(req.ctx, room.id),
      claims: core.listClaims(req.ctx, room.id),
      plan: core.getPlan(req.ctx, room.id),
      // Without `after` the viewer is opening the feed and wants its tail; with
      // it, cli and the watchdog page forward from the start 200 at a time.
      events: after === null ? core.latestEvents(req.ctx, room.id) : core.listEvents(req.ctx, room.id, Number(after)),
    };
  },

  'GET /api/plan': (req) => {
    const agent = req.agent;
    const roomId = agent ? agent.roomId : requireRoomByView(req).id;
    return core.getPlan(req.ctx, roomId);
  },

  /**
   * The first version of the plan is published by the first agent to connect.
   * The second gets a 409 carrying the published plan — not an error so much as
   * an invitation to agree or object.
   */
  'POST /api/plan/propose': (req) => {
    const agent = requireAgent(req);
    const raw = field<unknown>(req.body, 'items');
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new HttpError(400, 'bad_request', 'a non-empty items list is required');
    }
    const result = core.proposePlan(req.ctx, agent, raw.map(String), field<string>(req.body, 'notes') ?? null);
    if (!result.ok) {
      throw new HttpError(
        409,
        result.error,
        `${result.plan.proposedBy} already published a plan — read it, then either agree or object`,
      );
    }
    return result;
  },

  'POST /api/plan/ack': (req) => {
    const agent = requireAgent(req);
    const result = core.ackPlan(req.ctx, agent, Number(field<number>(req.body, 'revision') ?? -1));
    if (!result.ok) {
      throw new HttpError(
        409,
        result.error,
        `the plan has already moved to revision ${result.current} — re-read it and acknowledge again`,
      );
    }
    return result;
  },

  'POST /api/plan/dispute': (req) => {
    const agent = requireAgent(req);
    return core.disputePlan(
      req.ctx,
      agent,
      field<string>(req.body, 'itemId') ?? null,
      requireString(req.body, 'reason'),
    );
  },

  'POST /api/plan/items': (req) => {
    const agent = requireAgent(req);
    return {
      item: core.addItem(
        req.ctx,
        agent.roomId,
        agent,
        requireString(req.body, 'text'),
        field<string>(req.body, 'note') ?? null,
      ),
    };
  },

  'POST /api/plan/update': (req) => {
    const agent = requireAgent(req);
    const result = core.updateItem(req.ctx, agent, requireString(req.body, 'itemId'), {
      text: field<string>(req.body, 'text'),
      status: field<never>(req.body, 'status'),
      note: field<string>(req.body, 'note'),
      takeOwnership: field<boolean>(req.body, 'takeOwnership'),
    });
    if (!result.ok) {
      const message =
        result.error === 'owned_by_other'
          ? `${result.ownerNick} owns this item — ask them or take another`
          : result.error;
      throw new HttpError(result.error === 'not_found' ? 404 : 409, result.error, message);
    }
    return result;
  },

  'POST /api/plan/notes': (req) => {
    const agent = requireAgent(req);
    const result = core.setNotes(
      req.ctx,
      agent.roomId,
      agent,
      requireString(req.body, 'body'),
      Number(field<number>(req.body, 'version') ?? -1),
    );
    if (!result.ok) {
      throw new HttpError(
        409,
        result.error,
        `the notes have changed (version ${result.current.version}) — re-read them and reapply your edit`,
      );
    }
    return result;
  },
};

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) reject(new HttpError(413, 'too_large', 'request body is too large'));
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'bad_json', 'request body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * The feed reaches the web view over server-sent events rather than a websocket:
 * the channel is one-way (the page is read-only), SSE pulls in no dependencies,
 * and it survives tunnels and proxies better.
 */
function streamEvents(ctx: Ctx, roomId: string, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ protocol: PROTOCOL_VERSION, roomId })}\n\n`);

  const onEvent = (event: Event): void => {
    if (event.roomId !== roomId) return;
    res.write(`event: append\ndata: ${JSON.stringify(event)}\n\n`);
  };
  ctx.bus.on('event', onEvent);

  // Tunnels and proxies drop silent connections — keep it awake.
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);

  res.on('close', () => {
    clearInterval(keepAlive);
    ctx.bus.off('event', onEvent);
  });
}

const INSTALLER = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/install.sh');

/** The address the caller actually used: behind the tunnel that is https, on a
 * developer machine it is plain http, and guessing wrong hands out a command
 * that fails to connect. */
function publicOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  const forwarded = req.headers['x-forwarded-proto'];
  const proto =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() ??
    (/^(localhost|127\.0\.0\.1|\[::1])(:|$)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * The installer names the hub that served it.
 *
 * Written this way round because the address is the one thing a copied command
 * gets wrong: the script is fetched from the hub the team actually runs, so it
 * can fill that in itself instead of asking the human to keep it in sync.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * The client, straight from the hub.
 *
 * Not a git clone: a private repository is the normal case, and an installer
 * that needs repository access is an installer nobody outside the team can run.
 * The hub already carries this code and everyone can reach the hub — so it
 * hands out the two packages the client is made of and asks nothing of github.
 */
function sendClientArchive(res: ServerResponse): void {
  const tar = spawn('tar', ['-czf', '-', '-C', REPO_ROOT, 'packages/client', 'packages/protocol']);

  res.writeHead(200, {
    'content-type': 'application/gzip',
    'cache-control': 'no-cache',
    'content-disposition': 'attachment; filename="vibegram-client.tar.gz"',
  });
  tar.stdout.pipe(res);
  tar.on('error', (err) => {
    console.error('[hub] client archive failed', err);
    res.destroy();
  });
}

function sendInstaller(res: ServerResponse, origin: string): void {
  let script: string;
  try {
    script = readFileSync(INSTALLER, 'utf8');
  } catch {
    return send(res, 404, { error: 'not_found', message: 'installer is not bundled with this hub' });
  }
  const body = script.split('__HUB__').join(origin);
  res.writeHead(200, {
    'content-type': 'text/x-shellscript; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.end(body);
}

export function createHttpServer(
  ctx: Ctx,
  serveStatic?: (req: IncomingMessage, res: ServerResponse) => boolean,
) {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/api/stream') {
        const token = url.searchParams.get('view');
        const room = token ? core.roomByViewToken(ctx, token) : null;
        if (!room) return send(res, 404, { error: 'not_found' });
        return streamEvents(ctx, room.id, res);
      }

      if (req.method === 'GET' && url.pathname === '/install.sh') {
        return sendInstaller(res, publicOrigin(req));
      }

      if (req.method === 'GET' && url.pathname === '/client.tar.gz') {
        return sendClientArchive(res);
      }

      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key];

      if (!handler) {
        // A miss under /api/* must be an honest JSON 404. Otherwise the SPA
        // fallback serves index.html and the client dies on "Unexpected token '<'",
        // turning a version mismatch into a mystery.
        if (!url.pathname.startsWith('/api/') && serveStatic?.(req, res)) return;
        return send(res, 404, { error: 'not_found', message: `no route for ${key}` });
      }

      try {
        const body = req.method === 'GET' ? {} : await readBody(req);
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        const agent = token ? core.authAgent(ctx, token) : null;
        send(res, 200, handler({ ctx, url, body, agent }));
      } catch (err) {
        if (err instanceof HttpError) {
          return send(res, err.status, { error: err.code, message: err.message });
        }
        console.error('[hub] unhandled', err);
        send(res, 500, { error: 'internal' });
      }
    })();
  });
}
