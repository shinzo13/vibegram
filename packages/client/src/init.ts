import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidNick } from '../../protocol/src/index.ts';
import * as api from './api.ts';
import {
  DEFAULT_HUB,
  collectPaths,
  currentBranch,
  ensureDirFor,
  loadIdentity,
  repoFingerprint,
  repoRoot,
  saveIdentity,
  settingsPathFor,
  type Identity,
} from './config.ts';

const CLI_ENTRY = resolve(fileURLToPath(import.meta.url), '../cli.ts');

/** The hook command uses an absolute path so it does not depend on an npm install. */
function hookCommand(dialect: string): string {
  return `node ${CLI_ENTRY} hook --dialect ${dialect}`;
}

export interface DetectedAgent {
  dialect: 'claude' | 'cursor' | 'codex';
  reason: string;
}

/** Detection by traces in the repository and on PATH: configure only what is actually used. */
export function detectAgents(root: string): DetectedAgent[] {
  const found: DetectedAgent[] = [];

  if (existsSync(resolve(root, '.claude')) || which('claude')) {
    found.push({ dialect: 'claude', reason: which('claude') ? 'claude is on PATH' : '.claude/ exists in the repository' });
  }
  if (existsSync(resolve(root, '.cursor'))) {
    found.push({ dialect: 'cursor', reason: '.cursor/ exists in the repository' });
  }
  if (which('codex')) {
    found.push({ dialect: 'codex', reason: 'codex is on PATH' });
  }
  return found;
}

function which(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

function isOurs(entry: HookEntry): boolean {
  return entry.hooks?.some((h) => h.command?.includes('vibegram')) ?? false;
}

/**
 * Agent settings are appended to, never overwritten: the human may have their
 * own hooks there, and silently wiping them is the surest way to lose their
 * trust in the tool for good.
 */
export function installClaudeHooks(root: string): string {
  const path = settingsPathFor(root, 'claude');
  const settings: { hooks?: Record<string, HookEntry[]> } = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, never>)
    : {};

  const ours: Record<string, HookEntry[]> = {
    PreToolUse: [
      {
        // Bash is mandatory here: without it a claim is bypassed by a single
        // `echo > file`, and write interception exists only on paper.
        matcher: 'Edit|Write|NotebookEdit|MultiEdit|Bash',
        hooks: [{ type: 'command', command: hookCommand('claude'), timeout: 5 }],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Edit|Write|Read|Bash',
        hooks: [{ type: 'command', command: hookCommand('claude'), timeout: 5 }],
      },
    ],
    SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('claude'), timeout: 10 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: hookCommand('claude'), timeout: 5 }] }],
  };

  settings.hooks ??= {};
  for (const [event, entries] of Object.entries(ours)) {
    const existing = (settings.hooks[event] ?? []).filter((e) => !isOurs(e));
    settings.hooks[event] = [...existing, ...entries];
  }

  ensureDirFor(path);
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return path;
}

export function installCursorHooks(root: string): string {
  const path = settingsPathFor(root, 'cursor');
  const config: { version?: number; hooks?: Record<string, { command: string }[]> } = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, never>)
    : {};

  config.version ??= 1;
  config.hooks ??= {};
  // Cursor has no hook before a write, so we wedge into reads and the shell.
  for (const event of ['beforeReadFile', 'beforeShellExecution', 'afterFileEdit', 'sessionStart']) {
    const existing = (config.hooks[event] ?? []).filter((h) => !h.command?.includes('vibegram'));
    config.hooks[event] = [...existing, { command: hookCommand('cursor') }];
  }

  ensureDirFor(path);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

export function installCodexHooks(root: string): string {
  const path = settingsPathFor(root, 'codex');
  const config: { hooks?: Record<string, { command: string }[]> } = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, never>)
    : {};

  config.hooks ??= {};
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const existing = (config.hooks[event] ?? []).filter((h) => !h.command?.includes('vibegram'));
    config.hooks[event] = [...existing, { command: hookCommand('codex') }];
  }

  ensureDirFor(path);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

/**
 * Installs a short command on PATH. Not critical — every hint carries a
 * self-sufficient absolute command — but `vibegram` is easier for the agent,
 * and the easier compliance is, the less often anyone looks for a way around.
 * See PLAN.md.
 */
function installLauncher(): string | null {
  const target = resolve(homedir(), '.local/bin/vibegram');
  const script = `#!/bin/sh\nexec node ${CLI_ENTRY} "$@"\n`;
  try {
    ensureDirFor(target);
    writeFileSync(target, script, { mode: 0o755 });
    return target;
  } catch {
    return null;
  }
}

function inPath(bin: string): boolean {
  return (process.env.PATH ?? '').split(':').some((dir) => existsSync(resolve(dir, bin)));
}

/**
 * The MCP server is registered in the repository rather than in a global
 * config: each project has its own agent identity, and `.mcp.json` travels
 * with the clone.
 */
export function installMcpServer(root: string): string {
  const path = resolve(root, '.mcp.json');
  const config: { mcpServers?: Record<string, unknown> } = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, never>)
    : {};

  config.mcpServers ??= {};
  config.mcpServers.vibegram = { command: 'node', args: [CLI_ENTRY, 'mcp'] };

  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

/**
 * The skill goes into the repository rather than a global config: it describes
 * how this particular team works and travels with the clone.
 */
export function installSkill(root: string): string {
  const source = resolve(fileURLToPath(import.meta.url), '../../skill/SKILL.md');
  const target = resolve(root, '.claude/skills/vibegram/SKILL.md');
  ensureDirFor(target);
  writeFileSync(target, readFileSync(source, 'utf8'));
  return target;
}

/** Everything that goes into a working copy: hooks for detected agents, MCP and the skill. */
function installEverything(root: string): DetectedAgent[] {
  console.log(`  mcp: ${installMcpServer(root)}`);

  const detected = detectAgents(root);
  if (detected.length === 0) console.log('! no agents detected — hooks not installed');

  for (const agent of detected) {
    const path =
      agent.dialect === 'claude'
        ? installClaudeHooks(root)
        : agent.dialect === 'cursor'
          ? installCursorHooks(root)
          : installCodexHooks(root);
    console.log(`  ${agent.dialect}: ${path} (${agent.reason})`);
    if (agent.dialect === 'claude') console.log(`  skill: ${installSkill(root)}`);
  }
  return detected;
}


async function askNick(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'no codename given. Run: vibegram join <code> --nick claude-shinrei\n' +
        '(the human picks the name; an agent must not invent one for itself)',
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Codename in the feed (for example claude-shinrei): ');
    return answer.trim();
  } finally {
    rl.close();
  }
}

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

/**
 * Creates a room and prints its secrets once.
 *
 * The join code and the feed link are deliberately printed apart: the link ends
 * up on a projector and in group chats, and if it also let people in, anyone
 * watching could attach an agent and claim your files.
 */
export async function runRoomCreate(argv: string[]): Promise<void> {
  const hub = flagValue(argv, '--hub') ?? DEFAULT_HUB;
  const name = flagValue(argv, '--name') ?? repoRoot(process.cwd()).split('/').pop() ?? 'room';

  const { room, joinCode } = await api.createRoom(hub, name);

  console.log(`room "${room.name}" created on ${hub}\n`);
  console.log(`  join code:  ${joinCode}`);
  console.log(`  feed link:  ${hub}/r/${room.viewToken}\n`);
  console.log('Pass the join code to your team — it lets an agent in:');
  console.log(`  vibegram join ${joinCode} --nick <codename>${hub === DEFAULT_HUB ? '' : ` --hub ${hub}`}\n`);
  console.log('The feed link is read-only and safe to show anywhere.');
  console.log('If the code leaks, issue a new one: vibegram room rotate');
}

/** Flags that take a value: their value must not be mistaken for the join code. */
const VALUE_FLAGS = new Set(['--nick', '--hub', '--name']);

function firstPositional(argv: string[], from: number): string | null {
  for (let i = from; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return null;
}

export async function runJoin(argv: string[]): Promise<void> {
  const joinCode = firstPositional(argv, 1);
  if (!joinCode) throw new Error('a join code is required: vibegram join <code> --nick <codename>');

  const hub = flagValue(argv, '--hub') ?? DEFAULT_HUB;
  const cwd = process.cwd();
  const root = repoRoot(cwd);

  // Identity is keyed by the working copy, while hooks, MCP and the skill live
  // inside it. Re-running join in a fresh clone has to reinstall them, otherwise
  // the agent silently ends up with no integration at all.
  const existing = loadIdentity(cwd);
  if (existing) {
    console.log(`already in room ${existing.roomId} as ${existing.nick} — refreshing settings in this copy`);
    installEverything(root);
    return;
  }

  const nick = flagValue(argv, '--nick')?.trim() ?? (await askNick());
  if (!isValidNick(nick)) {
    throw new Error(
      `codename "${nick}" will not do: it must look like claude-shinrei — platform, dash, callsign, lowercase`,
    );
  }

  const fingerprint = repoFingerprint(cwd);
  if (!fingerprint) {
    console.log('! this repository has no commits yet — the room will remember it on the first commit');
  }

  const { token, room } = await api.joinRoom(hub, joinCode, nick, fingerprint);

  const launcher = installLauncher();
  // The command in every hint has to work, so the short name is used only when
  // it is genuinely available on PATH.
  const cli = launcher && inPath('vibegram') ? 'vibegram' : `node ${CLI_ENTRY}`;

  const identity: Identity = {
    nick,
    token,
    hub,
    roomId: room.id,
    viewToken: room.viewToken,
    root,
    cli,
  };
  saveIdentity(identity);

  console.log(`joined room "${room.name}" as ${nick}`);
  console.log(`  feed: ${hub}/r/${room.viewToken}`);
  if (launcher && cli !== 'vibegram') {
    console.log(`! ${launcher} was created, but its directory is not on PATH — agents get the full command`);
  }

  // The card starts filled in: branch and model are known right away.
  await api
    .setCard(identity, { branch: currentBranch(root), model: process.env.VIBEGRAM_MODEL ?? null })
    .catch(() => undefined);

  // The tree for the web view: only file names travel, the hub needs no repository access.
  const paths = collectPaths(root);
  await api
    .submitTree(identity, paths.tracked, paths.untracked)
    .then((r) => console.log(`  tree: ${r.accepted} paths sent`))
    .catch(() => undefined);

  const detected = installEverything(root);

  if (detected.some((d) => d.dialect === 'codex')) {
    console.log(
      '\n! codex: hooks are off by default. Add to ~/.codex/config.toml:\n' +
        '  [features]\n  codex_hooks = true\n' +
        '  without it hooks silently do nothing, with no error at all.',
    );
  }
  console.log('\nrestart the agent: hook settings are read at session start.');
}
