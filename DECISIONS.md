# Decisions

Why vibegram is built the way it is. Every entry here cost something to learn — most of them
came out of live runs with real agents rather than from design.

## Awareness before enforcement

The bet is that agents **try** to respect claims. Hooks and shell interception are a backstop,
not the foundation. Three consequences follow:

1. **The bottleneck is knowledge, not intent.** An agent walks into someone else's file because
   it does not know the file is taken. So the investment goes into delivering context at the
   right moment — unread activity attached to every tool result, and a session-start briefing —
   rather than into interception.
2. **Complying must be cheaper than routing around.** If checking a claim costs a separate tool
   call, some agents will drift around it out of economy rather than malice. So the information
   arrives on the return channel of something the agent already calls. If only one feature of
   this project could survive, it would be that one, not the deny.
3. **A false refusal costs more than a miss.** One unfair deny and the agent concludes the system
   is broken and starts working around it deliberately. Shell interception is therefore
   conservative: when in doubt, let it through and record a violation for people to sort out.

## What each agent actually allows

| | block a file write | block shell | block reads | hold after replying |
|---|---|---|---|---|
| **Claude Code** | yes — `PreToolUse` on `Edit\|Write\|NotebookEdit` | yes | yes | yes (`Stop`, unused) |
| **Cursor** | no hook fires before a write; `afterFileEdit` is after the fact | yes | yes | `stop` cannot block |
| **Codex** | no — `PreToolUse` sees **only** the shell, not `apply_patch` | yes | no | no |

Hard blocking exists only in Claude Code. This is stated plainly in the README rather than
glossed over.

**Codex trap:** hooks are experimental and off by default. Without `[features].codex_hooks = true`
in `~/.codex/config.toml` they silently do nothing, with no error at all.

## Verified against a live agent

A probe on a real headless Claude Code session confirmed and exposed:

- `PreToolUse` stdin carries `cwd`, so a path can be made relative without invoking git on the
  hot path; `file_path` is absolute, which is exactly why the hub rejects absolute paths
- the hook fires even under `permission_mode: bypassPermissions` — a claim cannot be escaped by
  loosening permissions
- **the agent stops, relays the reason to the human and offers to contact the holder** — because
  the refusal text says so. The wording is part of the product, not a log line
- **the gap the agent itself named:** a claim can be bypassed through the shell. Closed by
  parsing `Bash` commands, which is also the only interception point Codex has at all

A later run exposed a worse one: an agent started outside the repository root never loads the
project hooks, so it runs with no interception while vibegram reports itself as installed. Hooks
now report themselves, and an agent nobody has heard a hook from is flagged as unprotected.

## A room is the primary entity

A room was originally the hash of the repository's first commit. That was wrong twice over: two
teams sharing a public repository landed in one room, and the hash is no secret — anyone who
cloned the repo knows it. It separated nothing and protected nothing.

- **join code** — secret, admits an agent, stored hashed, rotatable so a leak is survivable
- **view token** — read-only, appears in `/r/<token>` links. Deliberately separate: a feed link
  gets shown on stage, and if it also let people in, anyone watching could attach an agent
- **the room id grants nothing** — it travels through logs and error messages
- **repo fingerprint** — the demoted commit hash. Grants no access; it catches running `join`
  from the wrong directory, which is otherwise discovered half an hour later
- the global room listing was removed: on a public hub it would expose every team's existence

Codes use an alphabet without look-alikes: they are read aloud and retyped.

The view token is eight characters, not six. Six is ~890 million combinations, exhausted by a
week of scanning at a thousand requests per second, and the prize is a team's file names and
agent chatter.

## The file tree is submitted by clients

The hub was going to clone the remote. Rejected: it would have to hold access tokens for other
people's repositories on a machine behind a tunnel, it would see all the code rather than just
file names, and it would only see what had been pushed — not what is being worked on.

Instead each client sends `git ls-files` from its own clone: **paths only, no contents**. A
snapshot replaces that agent's previous contribution entirely, so files that disappeared on a
branch switch disappear from the tree. Claims are applied at render time rather than stored:
derived state is a way to get out of sync.

The cost, stated plainly: file names do reach the hub. There is no tree of claims without them.

## The plan is published by an agent, and agreement is explicit

The human works the plan out with an agent but writes nothing by hand. The first agent to connect
publishes it; the rest agree or object.

- `propose` is atomic and succeeds exactly once — two agents starting together would otherwise
  overwrite each other or leave a duplicate
- `ack` is tied to a revision; a stale acknowledgement is rejected
- `dispute` is a first-class primitive, not a remark in the feed: otherwise disagreement
  dissolves into the stream and nobody can tell agreement from silence
- **only a change of intent moves the revision.** Status and ownership are the plan being
  executed; bumping on those would expire every acknowledgement every few minutes

## The human picks the work

A claim is visible to the whole team and blocks everyone else, so an agent does not assign work
to itself. It introduces itself, checks what is available, offers two or three options with
reasons, and waits.

This cannot be enforced — an agent can always call the tool. So the rule lives where it changes
behaviour: in the skill and in the tool descriptions. On a live run the same agent that used to
take work silently instead answered with three options, recommended one that was not in the plan,
and asked which to take.

## Scale, and what breaks first

Ten agents in a room. Four things were built in from the start because they cost migrations
later: room ids on events, refusals that name the holder and the time, normalised resource paths,
and relevance filtering of unread activity — with ten agents an unfiltered feed in everyone's
context is a tenfold token cost across the team.

Deliberately not built: claim queues, preemption, priority hierarchies, sharding.

**What breaks first at scale:** directory-prefix claims. With ten agents two people in `src/`
will collide constantly and this will have to go down to files. The conflict check is therefore
one function.

## Stack notes

- **Node 26 everywhere**: the hub runs TypeScript with no build step and uses `node:sqlite` from
  core. The client is plain node so it runs anywhere an agent does.
- **`protocol` is imported by relative path**, not as a package: node does not strip types inside
  `node_modules`, which is where workspaces symlink packages.
- **SSE, not websockets**: the channel to the web view is one-way, and node has no built-in
  websocket server — a dependency for two-way traffic nobody needs.
- **State in SQLite on disk.** A hub restart mid-session must not wipe every claim.
- **A miss under `/api/*` is an honest JSON 404.** The SPA fallback used to swallow it, and the
  client died on `Unexpected token '<'` — a version mismatch that looked like a mystery.
