import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where an agent's identity lives. Overridable through VIBEGRAM_HOME: one
 * machine may run several agents in different clones of the same repository,
 * and identity is keyed by project — without separation they would all share
 * a single nick.
 */
export const HOME_DIR = resolve(process.env.VIBEGRAM_HOME ?? homedir(), '.vibegram');
export const CONFIG_PATH = resolve(HOME_DIR, 'config.json');
export const LOG_PATH = resolve(HOME_DIR, 'hooks.log');

export const DEFAULT_HUB = process.env.VIBEGRAM_HUB ?? 'http://localhost:4321';

export interface Identity {
  nick: string;
  token: string;
  hub: string;
  roomId: string;
  /** Read-only token: used to print the feed link, never to write. */
  viewToken: string;
  /** The repository root on this machine: every agent has its own clone. */
  root: string;
  /**
   * A ready-to-run client command.
   *
   * A live agent that hit a claim could not reach the holder: the refusal said
   * "vibegram send" and no such command was on PATH. An agent that wants to
   * follow the protocol and cannot is an agent that will start working around
   * it. So every hint carries a command that works without installation.
   */
  cli: string;
}

interface ConfigFile {
  hub: string;
  /** Keyed by the repository root: the same clone always belongs to one room. */
  identities: Record<string, Omit<Identity, 'hub'>>;
}

function readConfig(): ConfigFile {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as ConfigFile;
  } catch {
    return { hub: DEFAULT_HUB, identities: {} };
  }
}

export function saveIdentity(identity: Identity): void {
  const config = readConfig();
  config.hub = identity.hub;
  config.identities[identity.root] = {
    nick: identity.nick,
    token: identity.token,
    roomId: identity.roomId,
    viewToken: identity.viewToken,
    root: identity.root,
    cli: identity.cli,
  };
  mkdirSync(HOME_DIR, { recursive: true });
  // Holds an agent token: owner-only.
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), 'cli.ts');

export function loadIdentity(cwd: string): Identity | null {
  const config = readConfig();
  // Identities used to be keyed by a project hash rather than a path. Those
  // entries stay in the file forever and answer to nobody; skipping anything
  // that is not an absolute path keeps a stale one from being picked up.
  const entry = Object.entries(config.identities).find(
    ([key]) => key === repoRoot(cwd) && key.startsWith('/'),
  )?.[1];
  if (!entry) return null;
  return {
    ...entry,
    hub: config.hub ?? DEFAULT_HUB,
    // A config written by an older client has no cli field. Without a fallback
    // the agent would be told to run "undefined send".
    cli: entry.cli ?? `node ${CLI_ENTRY}`,
  };
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string): string {
  return git(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
}

/** The branch belongs on the card: every agent has its own clone, and that is half the context. */
export function currentBranch(cwd: string): string | null {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

/** Where this clone came from, for the room's invite. The hub strips credentials too. */
export function originUrl(cwd: string): string | null {
  return git(['remote', 'get-url', 'origin'], cwd);
}

/**
 * A fingerprint of the repository: the hash of its first commit.
 *
 * It used to identify the room, which was wrong on both counts — two teams can
 * share a public repository, and anyone who cloned it knows the hash. Now it
 * only proves that everyone in a room is in the same repository, and catches
 * joining from the wrong directory. See PLAN.md.
 */
export function repoFingerprint(cwd: string): string | null {
  const first = git(['rev-list', '--max-parents=0', 'HEAD'], cwd);
  return first ? first.split('\n')[0]!.slice(0, 16) : null;
}

/**
 * The hub only accepts paths relative to the repository root: every agent has
 * its own clone, and absolute paths from different machines are incomparable.
 */
export function toRelative(root: string, filePath: string): string | null {
  if (!filePath) return null;
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  const rel = relative(root, abs);
  // A file outside the repository is nothing to coordinate about.
  if (rel === '' || rel.startsWith('..')) return null;
  return rel.split('\\').join('/');
}

/**
 * Paths of the repository, for the tree in the web view.
 *
 * Collected here rather than on the hub: the agent is already authenticated in
 * its own clone, so the hub needs neither tokens nor repository access — only
 * file names travel, never contents. It also sees uncommitted work, which is
 * exactly what is being worked on right now. See PLAN.md.
 */
export function collectPaths(root: string): { tracked: string[]; untracked: string[] } {
  const split = (value: string | null): string[] =>
    value === null || value === '' ? [] : value.split('\n').filter(Boolean).filter(isNotOwnArtifact);

  return {
    tracked: split(git(['ls-files'], root)),
    // --exclude-standard honours .gitignore: node_modules and build output stay out.
    untracked: split(git(['ls-files', '--others', '--exclude-standard'], root)),
  };
}

/** Our own config files are noise in the tree: vibegram created them, they are not the team's work. */
const OWN_ARTIFACTS = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/skills/vibegram/',
  '.cursor/hooks.json',
  '.codex/hooks.json',
  '.mcp.json',
];

function isNotOwnArtifact(path: string): boolean {
  return !OWN_ARTIFACTS.some((own) => path === own || path.startsWith(own));
}

/**
 * Everything a hook receives on stdin is written to disk: without it hooks
 * cannot be debugged at all — the agent shows only the outcome, never the input.
 */
export function logHook(entry: unknown): void {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must not bring down the hook: the agent matters more than diagnostics.
  }
}

/**
 * Where our hooks go.
 *
 * For claude that is settings.local.json, not settings.json: the latter is the
 * team's file and lives in git, so writing there commits a hook pointing at one
 * machine's clone into everyone else's checkout. The local file is personal and
 * gitignored by default, which is exactly what an installation is.
 *
 * Cursor and codex have no local variant, so those stay project-wide — join
 * says so out loud rather than pretending otherwise.
 */
export function settingsPathFor(root: string, dialect: 'claude' | 'cursor' | 'codex'): string {
  if (dialect === 'claude') return resolve(root, '.claude/settings.local.json');
  if (dialect === 'cursor') return resolve(root, '.cursor/hooks.json');
  return resolve(root, '.codex/hooks.json');
}

/** Earlier versions installed into the shared file; leave and join clean it up. */
export function legacySettingsPathFor(root: string, dialect: 'claude' | 'cursor' | 'codex'): string | null {
  return dialect === 'claude' ? resolve(root, '.claude/settings.json') : null;
}

export function isSharedWithTeam(dialect: 'claude' | 'cursor' | 'codex'): boolean {
  return dialect !== 'claude';
}

export function ensureDirFor(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
