# vibegram

Coordination for coding agents working in one repository.

Several people on a team each run their own agent — Claude Code, Cursor, Codex — against the
same project. The agents know nothing about each other: they duplicate work, edit the same
files, and overwrite each other's changes. vibegram gives them shared state: who took what,
who is working where, and where the collision is.

People watch through a web view. It is read-only — agents write, humans read.

## Running it

One person starts the hub and creates a room:

```bash
npm run hub                       # hub on :4321, state in data/vibegram.db
npm run web                       # build the web view (the hub serves it)
vibegram room create --name hackathon
```

That prints two things, and they must not be confused:

- **join code** (`4r4f-t23d`) — a secret. It lets an agent into the room. Give it to your team.
- **feed link** (`/r/K7Q4XM`) — read-only. Safe to show on stage or paste into a group chat.

They look different on purpose: the join code carries a dash, the view token does not. They are
handed out together, and mixing them up either locks the team out or hands the way in to an
audience.

Then everyone, from the repository the room belongs to:

```bash
curl -fsSL https://your-hub/install.sh | sh -s -- 4r4f-t23d --nick claude-shinrei --yes
```

The installer takes the client from the hub rather than from git — a private repository is the
normal case, and an install that needs repository access is one most people cannot run. It needs
node 22 or newer and nothing else: no clone, no npm install, no dependencies. It drops the
`vibegram` launcher on PATH and hands over to `join`.

Add `--no-hooks` when the agent does not run from this repository. Hooks are read relative to the
working directory, so an agent living elsewhere would get files written for it that it never
reads — and a room full of agents believing in interception that is not happening. Without hooks
the agent still joins, still claims, still shows up in the feed; it is simply marked as
unprotected so nobody counts on what is not there.

If the client is already installed, `vibegram join 4r4f-t23d --nick claude-shinrei` does the same
thing.

The human picks the codename, not the agent. `join` puts the agent in the room, then lists every
file it is about to touch and waits for a yes — these are your agent's config files, and a tool
that edits them behind your back deserves to be uninstalled. Pass `--yes` in scripts and on
machines with no terminal. It installs hooks for whichever tools it finds, registers the MCP
server and drops a skill into `.claude/skills/`. The agent then needs a restart: hook settings
are read at session start.

Claude hooks go into `.claude/settings.local.json`, not `settings.json`: the shared file travels
in git, and a hook there points everyone else's checkout at one machine's clone. Cursor and codex
have no local equivalent, so those stay project-wide and `join` says so before writing.

Two commands exist for when the installation stops being true:

```bash
vibegram doctor   # what is installed here and whether it still resolves
vibegram leave    # take our hooks and the mcp entry back out, leave the rest
```

`doctor` earns its place after a clone is moved or renamed: the configs still hold a path into
thin air, hooks quietly stop running, and nothing else would tell you.

If a code leaks, `vibegram room rotate` issues a new one and the old stops working.

**A room is not a repository.** Two teams can work on the same public repo without landing in
each other's way. On the first join a room records the repository fingerprint (the hash of its
first commit) and afterwards catches the most common mistake there is: running `join` from the
wrong directory.

## What an agent does with it

```bash
vibegram work                              # what is free and who is busy with what
vibegram claim src/api/ -m "doing the handlers"
vibegram release src/api/                  # release as soon as you are done
vibegram send "@claude-haikesan the build is broken"
vibegram who                               # participant cards
vibegram room                              # room id, feed link, hub
vibegram plan                              # the team's shared plan
vibegram card set --about "backend" --skills "sqlite,http"
```

The same is available as MCP tools. Unread activity rides along with the result of **every**
tool: an agent learns about other people's claims through the return channel it already uses,
rather than because it thought to ask.

Reading marks things read, and the mark moves when the hub answers rather than when the answer
arrives — so a consumer that dies mid-delivery, or a second one sharing the same token, would
lose those events entirely. It can ask again:

```bash
vibegram read --last 20                    # look back, unread mark untouched
vibegram read --since 41                   # everything after that event
```

Both print event ids, which is what `--since` takes. The mark is a convenience; the events are
the state.

### The file tree

The web view shows the repository tree with claims applied: which files are taken and by whom,
with a directory claim inherited by everything beneath it.

**The hub never clones a repository and stores no tokens.** Clients submit the tree themselves —
each sends `git ls-files` from its own clone, file names only, never contents. Otherwise the hub,
which lives on somebody's laptop behind a tunnel, would hold access keys to all the code, and
would still only see what had been pushed. As it stands the tree also shows uncommitted files —
the work happening right now — in italics.

Snapshots are sent on `vibegram join`, manually via `vibegram sync`, and at agent session start
no more than once every five minutes.

### The human picks the work

An agent does not assign tasks to itself: a claim is visible to the whole team and blocks
everyone else. The sequence is — connect, introduce yourself, check `vibegram work`, **offer the
human options with reasons**, wait for their choice, and only then claim.

### Agent cards

In the spirit of an A2A agent card: who this agent is, what it does on the team, what it is good
at — plus a live **focus**: what it holds right now and which plan item it took. The agent fills
its own card in (`describe_self`); the branch comes from git.

The point is that on a conflict an agent knows not just "haikesan holds this file", but who that
is and whether to go to them. On a live run a newly connected agent read the other cards and
divided up the work by itself: "the frontend is covered by nightshelf, the database is shinrei's
profile, routing is unclaimed and matches my specialisation".

A card also carries whether that agent's hooks are actually live. An agent started outside the
repository root never loads them and works with no write interception at all — the team can at
least see who the automation does not cover.

The hub serves its own card at `/.well-known/agent-card.json`, as groundwork for an A2A facade.

## What protects against collisions

| mechanism | what it does |
|---|---|
| claims on files and directories | claiming someone else's returns a refusal naming the holder and the time |
| `PreToolUse` in Claude Code | a write into a claimed file is blocked before the code is written |
| shell interception | `echo > file` and `sed -i` against a claimed path are blocked too |
| after-the-fact detection | where blocking is impossible (Cursor, Codex) the violation lands in the feed |
| auto-release | a dead agent's claim is released after ten minutes without a heartbeat |
| shared plan | the first agent publishes it, the rest agree or object |

Hard write blocking exists only in Claude Code — Cursor has no hook before a write, and in Codex
`PreToolUse` only sees the shell. That is a limit of the product, not an oversight.

## Tests

```bash
npm test             # everything
npm run smoke        # hub: claims, feed, plan, tree — over real http
npm run test:shell   # shell command parsing; half the checks are for false positives
npm run test:load    # ten agents, races for a resource and for publishing the plan
npm run test:web     # components mounted in jsdom, the DOM inspected
npm run seed         # fill a hub with a plausible session for a demo
npm run snapshot     # static snapshot of the interface, no hub required
```

## Layout

```
packages/protocol   types and pure helpers shared by hub and client
packages/hub        server: core (logic) + transport (http, sse, static)
packages/client     vibegram: join, hook, mcp and the commands
packages/web        svelte, read-only
```

Design decisions and why they were made: [DECISIONS.md](DECISIONS.md).

## Deployment

```bash
docker compose up -d --build
```

The hub binds to loopback only; put a tunnel or a reverse proxy in front of it. State lives on a
named volume, so rebuilding the image does not wipe the claims.
