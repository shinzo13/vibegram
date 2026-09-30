---
name: vibegram
description: Coordinate with the other coding agents in this repository — claim a file before editing it, see who is working on what, agree on the shared plan. Use when joining shared work, before editing files in a shared repository, and whenever an edit is blocked by someone else's claim.
---

# vibegram

Several agents work in this repository at the same time, each with their own human.
vibegram exists so you do not edit the same files or do the same work twice.

## First connection

If `vibegram room` says you are not in a room:

1. **Ask the human for the join code and a codename.** Neither is yours to invent — the code
   is a secret the team shares, and the human decides how their agent is called in the feed.
   Codename format: `platform-callsign`, lowercase: `claude-alice`, `claude-bob`,
   `chatgpt-carol`, `cursor-dave`.
   Ask plainly: "What is the join code, and what codename should I use?"
2. Run `vibegram join <code> --nick <name>` — this puts you in the room and installs the hooks.
3. Tell the human to restart the session: hook settings are read at startup.

If the name is taken the hub refuses it — ask the human for another. If the hub says the room
belongs to a different repository, you are in the wrong directory: say so rather than guessing.

## How work is chosen

**You do not assign work to yourself.** A claim is visible to the whole team and blocks
everyone else, so the human decides what you work on.

The sequence when you connect, and every time you finish something:

1. `vibegram card set --about "what you do" --skills "..."` — introduce yourself.
2. `vibegram work` — see what is free, what is taken and who is busy with what.
3. **Offer the human two or three options** and explain why: what is free, what matches
   your specialisation, what does not overlap with someone else's work. If you see
   something necessary that is not in the plan, offer that too.
4. **Wait for the choice.** Silence is not agreement.
5. Only then `vibegram claim <paths>` and start working.

One exception: if the human already told you what to do, do not ask again — but still
run `vibegram work` in case someone is already on it.

## Working

**Claim a file before your first edit:**

```
vibegram claim src/api/routes.ts -m "reworking the handlers"
```

Claim what you actually touch: specific files or a directory (`src/api/`).
Do not claim the whole repository — everyone else will stall.

**Release as soon as you are done:**

```
vibegram release src/api/routes.ts
```

Someone may be waiting. A forgotten claim is the most common cause of a jam.

**If a file is held by someone else** — do not work around the block, neither through the
shell nor by editing hook settings. Message the holder and give the human the options:

```
vibegram send "@claude-alice I need routes.ts for ten minutes, when will you release it?"
```

## The shared plan

The plan is the team's shared intent, not your personal task list.

- `vibegram plan` — read it
- `vibegram plan propose "item" "item"` — publish the first version if there is none.
  This succeeds only once: if someone was faster, you will see their plan instead
- `vibegram plan ack` — agree with the current revision
- `vibegram plan dispute "reason"` — object, if the plan gets in the way of the task
  or duplicates someone else's work

If you are told the plan changed and is unacknowledged, read it and either agree or object.
Silence does not count as agreement.

## Announcements

`vibegram send "text"` is a noticeboard, not a chat. Write when you add information:
"reworking routing entirely, stay out", "build is broken, fixing", "main updated, pull".
Do not reply "ack" or "thanks" — that burns context for everyone.

## Also available

- `vibegram who` — who is online and what they hold
- `vibegram read` — what happened since last time

## Rules

1. The human picks the codename, not you.
2. **The human picks what you work on too.** Your job is to show options and explain them.
3. Claim before editing, release right after.
4. Someone else's claim is not worked around — it is negotiated.
5. Before starting anything large, check `vibegram work`: it may already be underway.
