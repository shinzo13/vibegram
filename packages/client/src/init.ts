import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentRules, cleanRepoUrl, isValidNick } from '../../protocol/src/index.ts';
import * as api from './api.ts';
import {
  DEFAULT_HUB,
  collectPaths,
  currentBranch,
  ensureDirFor,
  isSharedWithTeam,
  legacySettingsPathFor,
  loadIdentity,
  originUrl,
  repoFingerprint,
  repoRoot,
  saveIdentity,
  settingsPathFor,
  type Identity,
} from './config.ts';

const CLI_ENTRY = resolve(fileURLToPath(import.meta.url), '../cli.ts');

/**
 * Prefers the launcher on PATH over the absolute path to this clone.
 *
 * Both work, but they rot differently: `vibegram` keeps the path to the clone
 * in one file that a single command rewrites, while an absolute path gets
 * copied into the config of every repository and dies silently the moment the
 * clone is moved. Without a launcher the absolute path is still correct — it is
 * the fallback, not the default.
 */
export function hookCommand(dialect: string, launcherAvailable = inPath('vibegram')): string {
  return launcherAvailable
    ? `vibegram hook --dialect ${dialect}`
    : `node ${CLI_ENTRY} hook --dialect ${dialect}`;
}

/**
 * Recognises our own entries in someone else's config.
 *
 * Matching on the word "vibegram" was wrong: a clone in ~/work/vg produces a
 * command with no such word, so our own filter stopped seeing our own hooks and
 * a second join duplicated them. The invocation itself is the marker.
 */
export function ownsCommand(command: string | undefined): boolean {
  return /(^|[\s/])vibegram(\s|$)|cli\.ts\s+hook\s+--dialect/.test(command ?? '');
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
  return entry.hooks?.some((h) => ownsCommand(h.command)) ?? false;
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
  // Older installs wrote into the shared settings.json; leaving them there would
  // run the hook twice and keep a machine-specific path in the team's git
  const shared = legacySettingsPathFor(root, 'claude');
  if (shared && stripOurHooks(shared)) {
    console.log(`  moved out of ${shared} — that file is shared with the team`);
  }
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
    const existing = (config.hooks[event] ?? []).filter((h) => !ownsCommand(h.command));
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
    const existing = (config.hooks[event] ?? []).filter((h) => !ownsCommand(h.command));
    config.hooks[event] = [...existing, { command: hookCommand('codex') }];
  }

  ensureDirFor(path);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

function readJson(path: string): Record<string, never> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, never>;
  } catch {
    return null;
  }
}

/**
 * Removes our hooks and leaves everything else exactly as it was, including a
 * file that ends up with an empty hooks object: it may be the human's own file
 * and deleting it is not ours to decide.
 */
export function stripOurHooks(path: string): boolean {
  const config = readJson(path) as { hooks?: Record<string, unknown[]> } | null;
  if (!config?.hooks) return false;

  let removed = 0;
  for (const [event, entries] of Object.entries(config.hooks)) {
    const kept = (entries ?? []).filter((entry) => {
      const owned =
        typeof entry === 'object' && entry !== null && 'hooks' in entry
          ? isOurs(entry as HookEntry)
          : ownsCommand((entry as { command?: string }).command);
      return !owned;
    });
    removed += (entries?.length ?? 0) - kept.length;
    if (kept.length > 0) config.hooks[event] = kept;
    else delete config.hooks[event];
  }
  if (removed === 0) return false;

  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

export function uninstallHooks(root: string, dialect: 'claude' | 'cursor' | 'codex'): string[] {
  const paths = [settingsPathFor(root, dialect), legacySettingsPathFor(root, dialect)].filter(
    (p): p is string => p !== null,
  );
  return paths.filter(stripOurHooks);
}

/** The mcp entry is ours alone, so it goes; other servers in the file stay. */
export function uninstallMcpServer(root: string): string | null {
  const path = resolve(root, '.mcp.json');
  const config = readJson(path) as { mcpServers?: Record<string, unknown> } | null;
  if (!config?.mcpServers?.vibegram) return null;

  delete config.mcpServers.vibegram;
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

const RULES_START = '<!-- vibegram:start -->';
const RULES_END = '<!-- vibegram:end -->';

/**
 * The working rules, in AGENTS.md.
 *
 * AGENTS.md is the one place agents of every make look for project rules, so
 * this is how an agent nobody configured still learns that files get claimed
 * here. The block sits between markers and is replaced in place, never
 * duplicated; the rest of the file is the team's. It names the bare `vibegram`
 * command and carries no secrets — the file travels in git.
 */
export function installRules(root: string): string {
  const path = resolve(root, 'AGENTS.md');
  const block = [
    RULES_START,
    '## vibegram',
    '',
    'Several coding agents work in this repository at once and coordinate through vibegram.',
    'Claim a file before editing it. If `vibegram` is not installed, ask your human for the',
    "room's invite link and follow it.",
    '',
    agentRules(),
    RULES_END,
  ].join('\n');

  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const start = current.indexOf(RULES_START);
  const end = current.indexOf(RULES_END);
  const next =
    start >= 0 && end > start
      ? current.slice(0, start) + block + current.slice(end + RULES_END.length)
      : current === ''
        ? `${block}\n`
        : `${current.replace(/\n*$/, '')}\n\n${block}\n`;

  if (next !== current) writeFileSync(path, next);
  return path;
}

/**
 * Says what will be written before writing it, and waits for a yes.
 *
 * These are the agent's own config files. A tool that edits them without asking
 * gets uninstalled the first time someone notices, and rightly so — consent is
 * cheaper than trust rebuilt afterwards. Non-interactive callers pass --yes,
 * which is a decision made once rather than a prompt nobody can answer.
 */
export async function confirmInstall(
  root: string,
  detected: DetectedAgent[],
  assumeYes: boolean,
  withHooks = true,
): Promise<boolean> {
  console.log('\nvibegram will write to:');
  console.log(`  ${resolve(root, '.mcp.json')} — mcp server entry`);
  console.log(`  ${resolve(root, 'AGENTS.md')} — working rules for any agent (shared with the team, travels in git)`);
  if (withHooks) {
    for (const agent of detected) {
      const shared = isSharedWithTeam(agent.dialect) ? ' (shared with the team, travels in git)' : '';
      console.log(`  ${settingsPathFor(root, agent.dialect)} — ${agent.dialect} hooks${shared}`);
    }
  }
  if (detected.some((d) => d.dialect === 'claude')) {
    console.log(`  ${resolve(root, '.claude/skills/vibegram/SKILL.md')} — skill`);
  }
  if (!withHooks) console.log('  no hooks (--no-hooks): nothing will intercept writes');
  console.log('Existing entries are kept; "vibegram leave" removes ours again.');

  if (assumeYes) return true;
  if (!process.stdin.isTTY) {
    console.log('\nnot a terminal — rerun with --yes to install without asking');
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Continue? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Everything that goes into a working copy: hooks for detected agents, MCP and
 * the skill.
 *
 * With hooks off it installs the rest and says plainly that writes are not
 * intercepted. That combination is not a broken install — it is the only honest
 * one for an agent whose working directory is not this repository, where hooks
 * would be written and then never read. Better a tool that admits it is only
 * advising than one that reports protection it does not provide.
 */
function installEverything(root: string, withHooks = true): DetectedAgent[] {
  console.log(`  mcp: ${installMcpServer(root)}`);
  console.log(`  rules: ${installRules(root)}`);

  const detected = detectAgents(root);
  if (!withHooks) {
    if (detected.some((d) => d.dialect === 'claude')) console.log(`  skill: ${installSkill(root)}`);
    console.log('  hooks: skipped (--no-hooks) — writes are not intercepted, claim by hand');
    return detected;
  }
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
      'no codename given. Run: vibegram join <code|hub-link> --nick claude-alice\n' +
        '(the human picks the name; an agent must not invent one for itself)',
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Codename in the feed (for example claude-alice): ');
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

  // The invite tells a newcomer where to clone from; this clone's origin is the
  // obvious answer when nobody gave one.
  const repoFlag = flagValue(argv, '--repo');
  const repoUrl = cleanRepoUrl(repoFlag ?? originUrl(process.cwd()));
  if (repoFlag && !repoUrl) throw new Error(`"${repoFlag}" is not an https, ssh or git@host:owner/repo address`);

  const { room, joinCode } = await api.createRoom(hub, name, repoUrl);
  const base = hub.replace(/\/+$/, '');

  console.log(`room "${room.name}" created on ${hub}\n`);
  console.log(`  invite:     ${base}/${joinCode}`);
  console.log(`  feed link:  ${base}/r/${room.viewToken}`);
  console.log(`  repository: ${repoUrl ?? 'unknown — set it with: vibegram room repo <url>'}\n`);
  console.log('Send the invite to anyone whose agent should join — it is a secret, and the');
  console.log('whole message: any agent that can read a link and run a shell follows it.\n');
  console.log('The feed link is read-only and safe to show anywhere.');
  console.log('If the code leaks, issue a new one: vibegram room rotate');
}

/** Flags that take a value: their value must not be mistaken for the join code. */
const VALUE_FLAGS = new Set(['--nick', '--hub', '--name', '--repo']);

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

/** The same alphabet the hub issues codes from, in the same 4-4 shape. */
const JOIN_CODE = /^[abcdefghjkmnpqrstuvwxyz23456789]{4}-[abcdefghjkmnpqrstuvwxyz23456789]{4}$/;

/**
 * A join target is either a bare code or the hub link with the code on the end:
 * one string is what actually gets pasted into a chat, and demanding that the
 * human split it back into `<code> --hub <url>` is how a join goes to the wrong
 * hub without anyone noticing.
 */
export function parseJoinTarget(value: string): { code: string; hub: string | null } {
  if (JOIN_CODE.test(value)) return { code: value, hub: null };

  if (!value.includes('/')) {
    throw new Error(`"${value}" is neither a join code (like p94q-vney) nor a hub link`);
  }

  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new Error(`"${value}" is not a valid hub link`);
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const code = segments.pop() ?? '';
  if (!JOIN_CODE.test(code)) {
    throw new Error(`no join code at the end of ${value} — it should look like https://hub.example/p94q-vney`);
  }

  const path = segments.length > 0 ? `/${segments.join('/')}` : '';
  return { code, hub: `${url.origin}${path}` };
}

/**
 * Takes our hooks back out. Uninstalling has to be as easy as installing —
 * a tool that can only be removed by hand-editing json is a tool people resent.
 */
export function runLeave(root: string): string[] {
  const touched: string[] = [];
  for (const dialect of ['claude', 'cursor', 'codex'] as const) {
    touched.push(...uninstallHooks(root, dialect));
  }
  const mcp = uninstallMcpServer(root);
  if (mcp) touched.push(mcp);
  return touched;
}

export interface HookHealth {
  dialect: 'claude' | 'cursor' | 'codex';
  path: string;
  installed: boolean;
  command: string | null;
  /** Whether that command can actually be run right now. */
  resolves: boolean;
  sharedWithTeam: boolean;
  /** Installed by an older version into the file that travels in git. */
  legacy: boolean;
}

function commandResolves(command: string): boolean {
  const [bin, ...rest] = command.split(/\s+/);
  if (bin === 'node') {
    const script = rest[0];
    return script !== undefined && existsSync(script);
  }
  return which(bin!);
}

/**
 * What is actually installed, as opposed to what join once reported.
 *
 * The failure this exists for is silent: the clone gets moved, every config
 * still holds a path into thin air, and the agent goes on writing to files
 * other people hold while vibegram claims it is protected.
 */
export function inspectHooks(root: string): HookHealth[] {
  const out: HookHealth[] = [];
  for (const dialect of ['claude', 'cursor', 'codex'] as const) {
    const current = settingsPathFor(root, dialect);
    const legacy = legacySettingsPathFor(root, dialect);

    // The legacy file is inspected too: an agent installed by an older version
    // is protected, and reporting "not installed" would send it reinstalling
    // over a working setup
    for (const [path, isLegacy] of [[current, false], ...(legacy ? [[legacy, true]] : [])] as [string, boolean][]) {
      const command = ourCommandsIn(path)[0] ?? null;
      if (command === null && isLegacy) continue;
      out.push({
        dialect,
        path,
        installed: command !== null,
        command,
        resolves: command !== null && commandResolves(command),
        sharedWithTeam: isLegacy || isSharedWithTeam(dialect),
        legacy: isLegacy,
      });
    }
  }
  return out;
}

function ourCommandsIn(path: string): string[] {
  const config = readJson(path) as { hooks?: Record<string, unknown[]> } | null;
  const commands: string[] = [];

  for (const entries of Object.values(config?.hooks ?? {})) {
    for (const entry of entries ?? []) {
      if (typeof entry === 'object' && entry !== null && 'hooks' in entry) {
        for (const hook of (entry as HookEntry).hooks ?? []) {
          if (ownsCommand(hook.command)) commands.push(hook.command);
        }
      } else {
        const command = (entry as { command?: string }).command;
        if (ownsCommand(command)) commands.push(command!);
      }
    }
  }
  return commands;
}

export async function runJoin(argv: string[]): Promise<void> {
  const target = firstPositional(argv, 1);
  if (!target) {
    throw new Error('a join code is required: vibegram join <code|hub-link> --nick <codename>');
  }
  const { code: joinCode, hub: hubFromLink } = parseJoinTarget(target);

  const hubFlag = flagValue(argv, '--hub');
  // Two different hubs in one command is a mistake worth stopping on: guessing
  // which one was meant lands the agent in someone else's room.
  if (hubFlag && hubFromLink && hubFlag.replace(/\/+$/, '') !== hubFromLink) {
    throw new Error(`the link points at ${hubFromLink}, but --hub says ${hubFlag} — leave one of them`);
  }
  const hub = hubFlag ?? hubFromLink ?? DEFAULT_HUB;
  const cwd = process.cwd();
  const root = repoRoot(cwd);

  // Identity is keyed by the working copy, while hooks, MCP and the skill live
  // inside it. Re-running join in a fresh clone has to reinstall them, otherwise
  // the agent silently ends up with no integration at all.
  const assumeYes = argv.includes('--yes') || argv.includes('-y');
  // an agent that runs from somewhere else than this repository would get hooks
  // written into files it never reads — joining without them is the honest setup
  const withHooks = !argv.includes('--no-hooks');

  const existing = loadIdentity(cwd);
  if (existing) {
    console.log(`already in room ${existing.roomId} as ${existing.nick} — refreshing settings in this copy`);
    if (!(await confirmInstall(root, detectAgents(root), assumeYes, withHooks))) return;
    installEverything(root, withHooks);
    return;
  }

  const nick = flagValue(argv, '--nick')?.trim() ?? (await askNick());
  if (!isValidNick(nick)) {
    throw new Error(
      `codename "${nick}" will not do: it must look like claude-alice — platform, dash, callsign, lowercase`,
    );
  }

  const fingerprint = repoFingerprint(cwd);
  if (!fingerprint) {
    console.log('! this repository has no commits yet — the room will remember it on the first commit');
  }

  const { token, room } = await api.joinRoom(hub, joinCode, nick, fingerprint, cleanRepoUrl(originUrl(cwd)));

  // Asked after the join rather than before it: an agent in the room without
  // hooks still coordinates by hand, while a refused join leaves nothing at all.
  const detected = detectAgents(root);
  const install = await confirmInstall(root, detected, assumeYes, withHooks);

  const launcher = install ? installLauncher() : null;
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

  if (!install) {
    console.log('\nnothing was written. You are in the room and can coordinate by hand:');
    console.log(`  ${cli} work    ${cli} claim <path>    ${cli} release`);
    console.log(`Install the hooks later with: ${cli} join ${joinCode} --yes`);
    return;
  }

  installEverything(root, withHooks);

  if (!withHooks) {
    console.log('\njoined without hooks. Claim before you write and release when done:');
    console.log(`  ${cli} work    ${cli} claim <path>    ${cli} release`);
    console.log(`The room shows you as unprotected, so nobody counts on interception that is not there.`);
    return;
  }

  if (detected.some((d) => d.dialect === 'codex')) {
    console.log(
      '\n! codex: hooks are off by default. Add to ~/.codex/config.toml:\n' +
        '  [features]\n  codex_hooks = true\n' +
        '  without it hooks silently do nothing, with no error at all.',
    );
  }
  console.log('\nrestart the agent: hook settings are read at session start.');
}
