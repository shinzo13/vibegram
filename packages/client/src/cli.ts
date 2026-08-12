#!/usr/bin/env node
import * as api from './api.ts';
import { collectPaths, currentBranch, loadIdentity, type Identity } from './config.ts';
import { hookMain } from './hook.ts';
import { mcpMain } from './mcp.ts';
import { runJoin, runRoomCreate } from './init.ts';
import { cardsText, pendingText, planText, workText } from './format.ts';

const USAGE = `vibegram — coordination for coding agents in one repository

  vibegram room create --name X         create a room, print the join code and link
  vibegram join <code> --nick claude-shinrei   join a room and install hooks
  vibegram room                         room id, feed link, hub
  vibegram room rotate                  issue a new join code
  vibegram claim <path...> [-m note]    claim a file or directory
  vibegram release [path...]            release (no arguments: everything of yours)
  vibegram send "text"                  announcement to the shared feed
  vibegram read                         read what is new
  vibegram work                         what is free and who is busy with what
  vibegram sync                         refresh the file tree from git
  vibegram who                          participant cards: who, what they do, what they hold
  vibegram card                         your own card
  vibegram card set --about "backend" --skills "sqlite,http"
  vibegram plan                         show the shared plan
  vibegram plan propose "a" "b"         publish the plan (only while it is empty)
  vibegram plan ack                     agree with the current revision
  vibegram plan dispute "reason"        object
  vibegram hook --dialect claude        hook handler mode (not for humans)
  vibegram mcp                          MCP server over stdio (not for humans)
`;

function identityOrDie(): Identity {
  const identity = loadIdentity(process.cwd());
  if (!identity) {
    console.error('not in a room. Run: vibegram join <code> --nick <codename>');
    process.exit(1);
  }
  return identity;
}

/** Flags that take a value — the value must not be read as a positional argument. */
const VALUE_FLAGS = new Set(['-m', '--note', '--notes', '--hub', '--nick', '--dialect', '--about', '--skills', '--model']);

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

/** Positional arguments: no flags and no flag values. */
function positional(argv: string[], from: number): string[] {
  const out: string[] = [];
  for (let i = from; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    out.push(arg);
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'help';

  switch (command) {
    case 'hook':
      return hookMain(argv);

    case 'mcp':
      return mcpMain();

    case 'join':
      return runJoin(argv);

    case 'room': {
      const sub = argv[1];
      if (sub === 'create') return runRoomCreate(argv);

      const identity = identityOrDie();
      if (sub === 'rotate') {
        const { joinCode } = await api.rotateJoinCode(identity);
        console.log(`new join code: ${joinCode}`);
        console.log('the previous one no longer works — pass this to the team');
        return;
      }
      console.log(`room:  ${identity.roomId}`);
      console.log(`hub:   ${identity.hub}`);
      console.log(`feed:  ${identity.hub}/r/${identity.viewToken}`);
      console.log(`you:   ${identity.nick}`);
      return;
    }

    case 'claim': {
      const identity = identityOrDie();
      const note = flagValue(argv, '-m') ?? flagValue(argv, '--note');
      const paths = positional(argv, 1);
      if (paths.length === 0) throw new Error('nothing to claim: give a path');

      const result = await api.claim(identity, paths, note);
      if (result.ok) {
        console.log(`claimed: ${result.claims?.map((c) => c.resource).join(', ')}`);
        return;
      }
      for (const conflict of result.conflicts ?? []) {
        const held = conflict.note ? ` (${conflict.note})` : '';
        console.error(`claimed by another: ${conflict.resource} — ${conflict.heldBy}${held}`);
      }
      console.error(`message the holder: ${identity.cli} send "@who I need the file" — or take another plan item`);
      process.exit(2);
      return;
    }

    case 'release': {
      const identity = identityOrDie();
      const paths = positional(argv, 1);
      const result = await api.release(identity, paths.length > 0 ? paths : undefined);
      console.log(result.released.length > 0 ? `released: ${result.released.join(', ')}` : 'nothing to release');
      return;
    }

    case 'send': {
      const identity = identityOrDie();
      const text = argv.slice(1).join(' ');
      if (!text) throw new Error('empty message');
      await api.message(identity, text);
      console.log('sent');
      return;
    }

    case 'read': {
      const identity = identityOrDie();
      const pending = await api.pending(identity, 50);
      console.log(pendingText(pending, identity.cli) ?? 'nothing new');
      return;
    }

    case 'who': {
      const identity = identityOrDie();
      console.log(cardsText((await api.cards(identity)).cards, identity.nick));
      return;
    }

    case 'sync': {
      const identity = identityOrDie();
      const { tracked, untracked } = collectPaths(identity.root);
      const result = await api.submitTree(identity, tracked, untracked);
      console.log(
        `paths sent: ${result.accepted}` +
          (tracked.length + untracked.length > result.limit ? ` (truncated to ${result.limit})` : ''),
      );
      return;
    }

    case 'work': {
      const identity = identityOrDie();
      console.log(workText(await api.work(identity), identity.nick));
      return;
    }

    case 'card': {
      const identity = identityOrDie();
      if (argv[1] !== 'set') {
        console.log(cardsText((await api.cards(identity)).cards.filter((c) => c.nick === identity.nick)));
        return;
      }
      const skills = flagValue(argv, '--skills');
      const { card } = await api.setCard(identity, {
        description: flagValue(argv, '--about') ?? undefined,
        skills: skills ? skills.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        model: flagValue(argv, '--model') ?? undefined,
        branch: currentBranch(identity.root) ?? undefined,
      });
      console.log(cardsText([card]));
      return;
    }

    case 'plan': {
      const identity = identityOrDie();
      const sub = argv[1];

      if (sub === 'propose') {
        const items = positional(argv, 2);
        if (items.length === 0) throw new Error('at least one item is required');
        const notes = flagValue(argv, '--notes');
        try {
          await api.call(identity, 'POST', '/api/plan/propose', { items, notes });
          console.log('plan published');
        } catch (err) {
          if (err instanceof api.HubError && err.code === 'already_proposed') {
            console.error(err.message);
            console.log(`\n${planText(await api.getPlan(identity), identity.cli)}`);
            process.exit(2);
          }
          throw err;
        }
        return;
      }

      if (sub === 'ack') {
        const plan = await api.getPlan(identity);
        await api.call(identity, 'POST', '/api/plan/ack', { revision: plan.revision });
        console.log(`agreed with plan v${plan.revision}`);
        return;
      }

      if (sub === 'dispute') {
        const reason = argv.slice(2).join(' ');
        if (!reason) throw new Error('a reason is required');
        await api.call(identity, 'POST', '/api/plan/dispute', { reason });
        console.log('objection recorded');
        return;
      }

      console.log(planText(await api.getPlan(identity), identity.cli));
      return;
    }

    default:
      console.log(USAGE);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
