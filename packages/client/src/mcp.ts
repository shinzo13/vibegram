/**
 * MCP server over stdio, no dependencies: the protocol is JSON-RPC 2.0, one
 * message per line.
 *
 * The point here is not the tools themselves but that unread activity rides
 * along with every result. An agent learns about other people's claims and
 * announcements through the return channel it already uses, rather than because
 * it thought to ask. See "awareness before enforcement" in PLAN.md.
 */
import { createInterface } from 'node:readline';
import type { ClaimConflict, Pending } from '../../protocol/src/index.ts';
import * as api from './api.ts';
import { loadIdentity, logHook, toRelative, type Identity } from './config.ts';
import { cardsText, pendingText, planText, workText } from './format.ts';

const PROTOCOL_VERSION = '2025-06-18';

interface Request {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (identity: Identity, args: Record<string, unknown>) => Promise<string>;
}

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function strList(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return typeof value === 'string' ? [value] : [];
}

function conflictText(conflicts: ClaimConflict[], cli: string): string {
  return conflicts
    .map((c) => {
      const note = c.note ? ` (${c.note})` : '';
      return (
        `Claimed: ${c.resource} is held by ${c.heldBy} since ${new Date(c.since).toLocaleTimeString('en-GB')}${note}. ` +
        `Message them: ${cli} send "@${c.heldBy} I need ${c.resource}" — or take another plan item.`
      );
    })
    .join('\n');
}

/**
 * Paths are made relative here: every agent has its own clone, and the hub
 * rejects absolute paths.
 */
function relativize(identity: Identity, paths: string[]): string[] {
  return paths.map((p) => toRelative(identity.root, p)).filter((p): p is string => p !== null);
}

const TOOLS: Tool[] = [
  {
    name: 'available_work',
    description:
      'What can be picked up right now: free plan items, what is already taken, which files ' +
      'are claimed and who does what. Call it when you connect and when you finish something. ' +
      'Show the result to the human and offer options — they choose, not you.',
    inputSchema: { type: 'object', properties: {} },
    run: async (identity) => workText(await api.work(identity), identity.nick),
  },
  {
    name: 'claim_task',
    description:
      'Claim a file or directory before editing it. Call it BEFORE the first edit, but ONLY ' +
      'after the human has chosen what you work on: a claim is visible to the whole team and ' +
      'blocks everyone else, so work is not assigned silently. If the resource is held by ' +
      'another agent you get a refusal naming the holder; do not route around it, negotiate.',
    inputSchema: {
      type: 'object',
      properties: {
        resources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths relative to the repository root, e.g. src/api/routes.ts or src/api/',
        },
        note: { type: 'string', description: 'What exactly you are about to do — others will see this' },
      },
      required: ['resources'],
    },
    run: async (identity, args) => {
      const resources = relativize(identity, strList(args, 'resources'));
      if (resources.length === 0) return 'Nothing to claim: give paths inside the repository.';

      const result = await api.claim(identity, resources, str(args, 'note'));
      if (result.ok) return `Claimed: ${result.claims?.map((c) => c.resource).join(', ')}`;
      return conflictText(result.conflicts ?? [], identity.cli);
    },
  },
  {
    name: 'release_task',
    description:
      'Release what you claimed once the work on it is done. With no arguments it releases ' +
      'everything of yours. Release promptly: other agents may be waiting on that file.',
    inputSchema: {
      type: 'object',
      properties: { resources: { type: 'array', items: { type: 'string' } } },
    },
    run: async (identity, args) => {
      const raw = strList(args, 'resources');
      const resources = raw.length > 0 ? relativize(identity, raw) : undefined;
      const result = await api.release(identity, resources);
      return result.released.length > 0
        ? `Released: ${result.released.join(', ')}`
        : 'Nothing to release.';
    },
  },
  {
    name: 'post_message',
    description:
      'An announcement for the other agents: "reworking routing, stay out", "build is broken". ' +
      'This is a noticeboard, not a chat: write only when you add information. ' +
      'Address a specific agent with @their-nick.',
    inputSchema: {
      type: 'object',
      properties: { body: { type: 'string' } },
      required: ['body'],
    },
    run: async (identity, args) => {
      const body = str(args, 'body');
      if (!body) return 'Empty message.';
      try {
        await api.message(identity, body);
        return 'Sent.';
      } catch (err) {
        if (err instanceof api.HubError && err.code === 'rate_limited') return err.message;
        throw err;
      }
    },
  },
  {
    name: 'get_inbox',
    description:
      'Read what the other agents have done since last time: announcements, claims, plan changes.',
    inputSchema: { type: 'object', properties: {} },
    run: async (identity) => {
      const pending = await api.pending(identity, 50);
      return pendingText(pending, identity.cli) ?? 'Nothing new.';
    },
  },
  {
    name: 'who',
    description:
      'Participant cards: who is connected, what they do on the team, what they are good at, ' +
      'which plan item they took and which files they hold. Check this before taking on ' +
      'anything large or before going to someone with a question.',
    inputSchema: { type: 'object', properties: {} },
    run: async (identity) => cardsText((await api.cards(identity)).cards, identity.nick),
  },
  {
    name: 'describe_self',
    description:
      'Tell the team what you do and what you are good at. Fill this in when you connect: ' +
      'the others use these cards to decide who gets which task and who to ask. ' +
      'Describe your actual specialisation on this project, not the model capabilities.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What you do: "backend and migrations"' },
        skills: { type: 'array', items: { type: 'string' }, description: '["sqlite", "http", "tests"]' },
        model: { type: 'string', description: 'The model you run on' },
      },
    },
    run: async (identity, args) => {
      const skills = strList(args, 'skills');
      const { card } = await api.setCard(identity, {
        description: str(args, 'description') ?? undefined,
        skills: skills.length > 0 ? skills : undefined,
        model: str(args, 'model') ?? undefined,
      });
      return `Card updated:\n${cardsText([card])}`;
    },
  },
  {
    name: 'get_plan',
    description: "The team's shared plan: items, who took what, who agrees with the current revision.",
    inputSchema: { type: 'object', properties: {} },
    run: async (identity) => planText(await api.getPlan(identity), identity.cli),
  },
  {
    name: 'propose_plan',
    description:
      'Publish the first version of the shared plan. Succeeds only while the plan is empty: ' +
      'if someone was faster you get their plan back — read it and either agree or object.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string', description: 'Free-form context: agreements, constraints' },
      },
      required: ['items'],
    },
    run: async (identity, args) => {
      const items = strList(args, 'items');
      if (items.length === 0) return 'At least one item is required.';
      try {
        await api.call(identity, 'POST', '/api/plan/propose', { items, notes: str(args, 'notes') });
        return 'Plan published.';
      } catch (err) {
        if (err instanceof api.HubError && err.code === 'already_proposed') {
          return `${err.message}\n\n${planText(await api.getPlan(identity), identity.cli)}`;
        }
        throw err;
      }
    },
  },
  {
    name: 'ack_plan',
    description: 'Acknowledge the current revision of the plan. Call it once you have read it.',
    inputSchema: { type: 'object', properties: {} },
    run: async (identity) => {
      const plan = await api.getPlan(identity);
      await api.call(identity, 'POST', '/api/plan/ack', { revision: plan.revision });
      return `Agreed with plan v${plan.revision}.`;
    },
  },
  {
    name: 'dispute_plan',
    description:
      'Object to the plan with a reason. The objection is visible to everyone and withdraws ' +
      'your previous agreement. Use it if the plan blocks the task or duplicates work.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        itemId: { type: 'string', description: 'A specific item, if the objection is only about it' },
      },
      required: ['reason'],
    },
    run: async (identity, args) => {
      const reason = str(args, 'reason');
      if (!reason) return 'A reason is required.';
      await api.call(identity, 'POST', '/api/plan/dispute', { reason, itemId: str(args, 'itemId') });
      return 'Objection recorded.';
    },
  },
];

/**
 * Unread activity attached to every tool result — the central mechanism of the
 * whole thing. An agent calls get_inbox twice an hour; it calls tools constantly.
 */
async function withPending(identity: Identity, body: string): Promise<string> {
  let pending: Pending;
  try {
    pending = await api.pending(identity, 20);
  } catch {
    // Unread activity is a bonus, not a reason to fail the call itself.
    return body;
  }
  const text = pendingText(pending, identity.cli);
  return text === null ? body : `${body}\n\n---\n${text}`;
}

function send(response: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...response })}\n`);
}

function toolDescriptors(): Record<string, unknown>[] {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

async function handle(request: Request, identity: Identity | null): Promise<void> {
  const { id, method } = request;

  if (method === 'initialize') {
    send({
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'vibegram', version: '0.1.0' },
      },
    });
    return;
  }

  // Notifications carry no id and expect no response.
  if (id === undefined) return;

  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: toolDescriptors() } });

  if (method === 'tools/call') {
    const params = request.params ?? {};
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);

    if (!tool) {
      return send({ id, result: { isError: true, content: [{ type: 'text', text: `no such tool: ${name}` }] } });
    }
    if (!identity) {
      return send({
        id,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'vibegram is not connected in this repository. Ask the human to run: vibegram init --nick <codename>',
            },
          ],
        },
      });
    }

    try {
      const text = await withPending(identity, await tool.run(identity, args));
      return send({ id, result: { content: [{ type: 'text', text }] } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHook({ mcp: name, error: message });
      return send({ id, result: { isError: true, content: [{ type: 'text', text: message }] } });
    }
  }

  send({ id, error: { code: -32601, message: `unknown method: ${method}` } });
}

export function mcpMain(): void {
  const identity = loadIdentity(process.cwd());
  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    const text = line.trim();
    if (text === '') return;
    let request: Request;
    try {
      request = JSON.parse(text) as Request;
    } catch {
      return;
    }
    void handle(request, identity).catch((err: unknown) => {
      logHook({ mcp: 'handle', error: String(err) });
    });
  });
}
