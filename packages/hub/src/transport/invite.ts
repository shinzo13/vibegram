import type { ServerResponse } from 'node:http';
import type { Room } from '../../../protocol/src/index.ts';
import { agentRules } from '../../../protocol/src/index.ts';

/** `/<join code>` — the same 4-4 shape and alphabet the hub issues codes in. */
export const INVITE_PATH = /^\/([abcdefghjkmnpqrstuvwxyz23456789]{4}-[abcdefghjkmnpqrstuvwxyz23456789]{4})\/?$/;

/**
 * The invite: everything a stranger's agent needs to join, behind one link.
 *
 * Written for the lowest common denominator — an agent that can read text and
 * run a shell, nothing more. No tool-specific steps: whatever the agent is, it
 * gets the same instructions, and the link is the whole message a human sends.
 */
export function inviteText(room: Room, code: string, hub: string): string {
  const dir = room.repoUrl?.replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') ?? '';
  const clone = room.repoUrl
    ? ['```sh', `git clone ${room.repoUrl} && cd ${dir}`, '```', 'Skip it if you are already in a clone of this repository.']
    : ['Go to the root of the repository this room belongs to — ask your human which one if unsure.'];

  return [
    `# Join the vibegram room "${room.name}"`,
    '',
    'vibegram coordinates the coding agents working in one repository: each agent claims a file',
    'before editing it, so nobody overwrites anybody. You were sent this link to join. Do the steps',
    'below in a shell.',
    '',
    '## 1. Codename',
    '',
    'Ask your human which codename to use, unless they already told you. The format is',
    '`<platform>-<callsign>`, lowercase, for example `qwen-alice`. Do not invent one yourself.',
    '',
    '## 2. Repository',
    '',
    ...clone,
    '',
    '## 3. Join',
    '',
    'From the repository root, with node 22.18 or newer:',
    '',
    '```sh',
    `curl -fsSL ${hub}/install.sh | sh -s -- ${code} --nick <codename> --yes`,
    '```',
    '',
    'Add `--no-hooks` if your session was started outside this repository. Then check the result',
    'with `vibegram doctor`, and introduce yourself:',
    '`vibegram card set --about "what you do" --skills "a,b"`.',
    '',
    '## How to work',
    '',
    agentRules(),
    '',
    `The same rules end up in AGENTS.md in the repository. Humans watch the feed at ${hub}/r/${room.viewToken}.`,
    '',
  ].join('\n');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Plain text for anything that is not a browser, a page for a browser. The page
 * carries the very same text: an agent fetching through an HTML-to-markdown
 * tool must not get less than one using curl.
 */
export function sendInvite(
  res: ServerResponse,
  room: Room | null,
  code: string,
  hub: string,
  accept: string | undefined,
): void {
  const text = room
    ? inviteText(room, code, hub)
    : 'No room matches this invite. The join code may have been rotated — ask for a fresh link.\n';
  const status = room ? 200 : 404;
  const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };

  if (!accept?.includes('text/html')) {
    res.writeHead(status, { ...headers, 'content-type': 'text/markdown; charset=utf-8' });
    res.end(text);
    return;
  }

  const title = room ? `vibegram · ${escapeHtml(room.name)}` : 'vibegram';
  res.writeHead(status, { ...headers, 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  body { margin: 0; background: #17181b; color: #d5d7dc; }
  pre { max-width: 860px; margin: 0 auto; padding: 32px 20px; white-space: pre-wrap;
        overflow-wrap: anywhere; font: 14px/1.6 ui-monospace, "IBM Plex Mono", monospace; }
</style>
</head>
<body><pre>${escapeHtml(text)}</pre></body>
</html>
`);
}
