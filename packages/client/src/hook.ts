import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as api from './api.ts';
import {
  HOME_DIR,
  ambiguityText,
  collectPaths,
  logHook,
  resolveIdentity,
  toRelative,
  type Identity,
} from './config.ts';
import { denyText, pendingText, planText } from './format.ts';
import { looksLikeWrite, writeTargets } from './shell.ts';

export type Dialect = 'claude' | 'cursor' | 'codex';

/** Tools that write to files directly. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** More often than this is pointless: an agent makes dozens of tool calls a minute. */
const POLL_INTERVAL_MS = 20_000;

/** The tree moves slowly, and `git ls-files` on a large repo is not free. */
const TREE_INTERVAL_MS = 5 * 60_000;

function throttlePath(key: string): string {
  return resolve(HOME_DIR, `poll-${key.replace(/[^a-z0-9]/gi, '_')}`);
}

function shouldPoll(key: string, intervalMs: number = POLL_INTERVAL_MS): boolean {
  const path = throttlePath(key);
  try {
    const last = Number(readFileSync(path, 'utf8'));
    if (Date.now() - last < intervalMs) return false;
  } catch {
    // No marker file yet — poll.
  }
  try {
    writeFileSync(path, String(Date.now()));
  } catch {
    // Failing to record the timestamp is no reason to skip the poll.
  }
  return true;
}

const SESSIONS_PATH = resolve(HOME_DIR, 'sessions.json');

function readSessions(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSIONS_PATH, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Which agent a session is, learned from the session itself.
 *
 * When several agents share a copy, the hook cannot tell them apart by
 * directory. But the agent names itself in its own commands — `vibegram --as
 * <nick> ...` — and the hook sees those commands go by, together with the
 * session id. One such command is enough to bind the session for good.
 */
export function learnSession(session: string | null, command: string | undefined): void {
  if (!session || !command?.includes('vibegram')) return;
  const nick = /(?:--as\s+|VIBEGRAM_AS=)([a-z0-9]+(?:-[a-z0-9]+)+)/.exec(command)?.[1];
  if (!nick) return;
  const sessions = readSessions();
  if (sessions[session] === nick) return;
  sessions[session] = nick;
  // Sessions come and go; the file must not grow forever.
  const kept = Object.fromEntries(Object.entries(sessions).slice(-200));
  try {
    writeFileSync(SESSIONS_PATH, JSON.stringify(kept), { mode: 0o600 });
  } catch {
    // Not knowing the session only means not checking its writes.
  }
}

export function sessionNick(session: string | null): string | null {
  return session ? (readSessions()[session] ?? null) : null;
}

function allow(): string {
  return '{}';
}

function contextClaude(event: string, context: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  });
}

interface HookInput {
  hook_event_name?: string;
  /** Claude and codex. */
  session_id?: string;
  /** Cursor's name for the same thing. */
  conversation_id?: string;
  tool_name?: string;
  cwd?: string;
  tool_input?: { file_path?: string; command?: string };
  /** Cursor puts the command at the root of the object rather than in tool_input. */
  command?: string;
}

/** Cursor names its events differently — that is how the dialect is recognised. */
const CURSOR_EVENTS = new Set([
  'beforeReadFile',
  'afterFileEdit',
  'beforeShellExecution',
  'preToolUse',
  'postToolUse',
  'sessionStart',
  'sessionEnd',
]);

export function detectDialect(input: HookInput): Dialect {
  const event = input.hook_event_name ?? '';
  if (CURSOR_EVENTS.has(event)) return 'cursor';
  return 'claude';
}

/**
 * A refusal looks different in each dialect.
 * Codex has no hookSpecificOutput wrapper — only flat fields.
 */
function denyFor(dialect: Dialect, reason: string, event: string): string {
  if (dialect === 'cursor') {
    return JSON.stringify({ permission: 'deny', userMessage: reason, agentMessage: reason });
  }
  if (dialect === 'codex') {
    return JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

async function handleWrite(
  identity: Identity,
  input: HookInput,
  filePath: string,
  dialect: Dialect,
): Promise<string> {
  const resource = toRelative(identity.root, filePath);
  // Nothing to coordinate about a file outside the repository.
  if (resource === null) return allow();

  const result = await api.checkWrite(identity, resource, input.tool_name ?? 'unknown');
  if (result.allow || !result.conflict) return allow();

  return denyFor(dialect, denyText(resource, result.conflict, identity.cli), 'PreToolUse');
}

/**
 * The shell is the way around a claimed file, and for codex it is the only
 * interception point at all: file edits there are not visible to hooks.
 */
async function handleShell(
  identity: Identity,
  command: string,
  dialect: Dialect,
  event: string,
): Promise<string> {
  // This hook runs on every command the agent issues, so the free checks come
  // first and the network only after: otherwise `ls` would wait on the hub.
  if (command.includes('vibegram')) return allow();
  if (!looksLikeWrite(command)) return allow();

  const { claims } = await api.othersClaims(identity);
  if (claims.length === 0) return allow();

  const targets = writeTargets(command, claims.map((c) => c.resource));
  if (targets.length === 0) return allow();

  const conflict = claims.find((c) => c.resource === targets[0])!;
  const reason =
    `This command writes to ${targets.join(', ')}, which is claimed in vibegram by ${conflict.nick}` +
    `${conflict.note ? ` ("${conflict.note}")` : ''}. ` +
    `Do not route around the claim through the shell. Message the holder: ` +
    `${identity.cli} send "@${conflict.nick} I need ${targets[0]}".`;

  // An attempted bypass is a feed event: people should see it.
  await api.checkWrite(identity, targets[0]!, 'Bash', 'blocked').catch(() => undefined);

  return denyFor(dialect, reason, event);
}

async function handleContext(identity: Identity, event: string): Promise<string> {
  const pending = await api.pending(identity, 30, true);
  const text = pendingText(pending, identity.cli);
  return text === null ? allow() : contextClaude(event, text);
}

async function handleSessionStart(identity: Identity): Promise<string> {
  // Refresh the tree at session start: relying on a manual `sync` means showing
  // week-old state in the web view. Quietly, without holding up the session.
  if (shouldPoll(`tree-${identity.roomId}`, TREE_INTERVAL_MS)) {
    const paths = collectPaths(identity.root);
    await api.submitTree(identity, paths.tracked, paths.untracked).catch(() => undefined);
  }

  const [pending, plan] = await Promise.all([api.pending(identity, 30, true), api.getPlan(identity)]);
  const parts = [
    `You are connected to vibegram as ${identity.nick}. Other agents work in this same repository.`,
    `Claim a file before editing it: ${identity.cli} claim <path> -m "what you are doing".`,
    planText(plan, identity.cli),
  ];
  const fresh = pendingText(pending, identity.cli);
  if (fresh) parts.push(fresh);
  return contextClaude('SessionStart', parts.join('\n\n'));
}

/**
 * The hook handler. Any error means allow: the hook is synchronous, and a hub
 * that is down must not paralyse the whole team. See PLAN.md.
 */
export async function runHook(argv: string[]): Promise<string> {
  const raw = readFileSync(0, 'utf8');
  let input: HookInput = {};
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    logHook({ error: 'bad_json', raw: raw.slice(0, 500) });
    return allow();
  }
  logHook(input);

  const flagIndex = argv.indexOf('--dialect');
  const dialect: Dialect =
    flagIndex >= 0 ? ((argv[flagIndex + 1] ?? 'claude') as Dialect) : detectDialect(input);

  const cwd = input.cwd ?? process.cwd();
  const event = input.hook_event_name ?? '';
  const session = input.session_id ?? input.conversation_id ?? null;
  learnSession(session, input.tool_input?.command ?? input.command);

  const { identity, candidates } = resolveIdentity(cwd, process.env.VIBEGRAM_AS ?? sessionNick(session));
  if (!identity) {
    // Several agents share this copy and this session has not said which it is.
    // Its writes cannot be checked yet, so it is told how to fix that — at the
    // start and then now and again, not on every call.
    const tell =
      candidates.length > 1 &&
      dialect === 'claude' &&
      (event === 'SessionStart' || (event === 'PostToolUse' && shouldPoll(`who-${session ?? 'none'}`, 5 * 60_000)));
    if (tell) {
      return contextClaude(event, `vibegram: ${ambiguityText(candidates)}. Until then your writes are not checked against claims.`);
    }
    // Without registration the hook stays silent: `vibegram join` was never run.
    return allow();
  }

  const tool = input.tool_name ?? '';

  switch (event) {
    case 'PreToolUse':
    case 'preToolUse': {
      const filePath = input.tool_input?.file_path;
      if (filePath && WRITE_TOOLS.has(tool)) {
        return handleWrite(identity, input, filePath, dialect);
      }
      const command = input.tool_input?.command;
      if (command) return handleShell(identity, command, dialect, event);
      return allow();
    }

    case 'beforeShellExecution': {
      const command = input.tool_input?.command ?? input.command;
      if (!command) return allow();
      return handleShell(identity, command, 'cursor', event);
    }

    case 'beforeReadFile': {
      // Cursor has no hook before a write, so reads are intercepted instead: an
      // agent almost always reads a file before editing it. Cruder, but earlier.
      const filePath = input.tool_input?.file_path;
      if (!filePath) return allow();
      return handleWrite(identity, input, filePath, 'cursor');
    }

    case 'PostToolUse':
    case 'postToolUse':
      // Per agent: two agents in one copy must not swallow each other's updates.
      if (!shouldPoll(`${identity.roomId}-${identity.nick}`)) return allow();
      return handleContext(identity, 'PostToolUse');

    case 'SessionStart':
    case 'sessionStart':
      return handleSessionStart(identity);

    case 'SessionEnd':
    case 'sessionEnd':
      await api.leave(identity);
      return allow();

    default:
      return allow();
  }
}

export async function hookMain(argv: string[]): Promise<void> {
  let output = allow();
  try {
    output = await runHook(argv);
  } catch (err) {
    // Hub down, timeout, anything at all — let it through and write it to the log.
    logHook({ error: String(err) });
  }
  process.stdout.write(output);
}
