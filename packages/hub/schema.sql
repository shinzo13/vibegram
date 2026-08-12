-- Hub state lives on disk rather than in memory: a restart mid-session must not
-- wipe every claim. See PLAN.md.

-- A room is the primary entity, with an identity of its own.
--
-- It used to be the hash of the repository's first commit, which was wrong twice
-- over: two teams working on the same public repository would land in one room,
-- and the hash is no secret at all — anyone who cloned the repository knows it.
--
-- The join code and the view token are deliberately separate. A view link gets
-- shown on stage and pasted into group chats; if that were also the way in,
-- anyone in the audience could attach an agent and claim your files.
CREATE TABLE IF NOT EXISTS rooms (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  -- Secret. Lets an agent register and write. Rotatable, so a leak is recoverable.
  join_code_hash TEXT NOT NULL,
  -- Read-only. Safe to show anywhere.
  view_token     TEXT NOT NULL UNIQUE,
  -- Hash of the repository's first commit, recorded when the first agent joins.
  -- Demoted to a fingerprint: it no longer grants access, it only catches the
  -- most common mistake — joining from the wrong directory.
  repo_fingerprint TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS rooms_by_view ON rooms (view_token);

CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id),
  nick         TEXT NOT NULL,
  platform     TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'online',
  last_seen_at TEXT NOT NULL,
  -- When a hook last called in. An agent started outside the repository root
  -- never loads the project hooks and silently has no write interception at
  -- all, while vibegram reports itself as installed. Found on a live run.
  hooks_seen_at TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (room_id, nick)
);

CREATE INDEX IF NOT EXISTS agents_by_token ON agents (token_hash);

-- An agent card in the spirit of A2A: who they are and what they do. A separate
-- table rather than columns on agents, so the description can grow and change
-- without touching identity and tokens.
CREATE TABLE IF NOT EXISTS agent_cards (
  agent_id    TEXT PRIMARY KEY REFERENCES agents(id),
  description TEXT,
  -- JSON array: what this agent picks up most readily.
  skills      TEXT NOT NULL DEFAULT '[]',
  model       TEXT,
  branch      TEXT,
  updated_at  TEXT NOT NULL
);

-- The file tree is submitted by clients (`git ls-files`); the hub never clones.
-- Otherwise it would have to hold access tokens for other people's repositories,
-- and would only ever see pushed work — not what is being edited right now.
CREATE TABLE IF NOT EXISTS tree_paths (
  room_id  TEXT NOT NULL REFERENCES rooms(id),
  path     TEXT NOT NULL,
  -- Who last confirmed the path exists: everyone has their own clone and branch.
  agent_id TEXT REFERENCES agents(id),
  -- Whether git tracks the file or it only exists on someone's disk.
  tracked  INTEGER NOT NULL DEFAULT 1,
  seen_at  TEXT NOT NULL,
  PRIMARY KEY (room_id, path)
);

CREATE TABLE IF NOT EXISTS claims (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id),
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  -- Normalised path or directory prefix (see normalizeResource).
  resource     TEXT NOT NULL,
  note         TEXT,
  plan_item_id TEXT REFERENCES plan_items(id),
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL,
  released_at  TEXT
);

CREATE INDEX IF NOT EXISTS claims_active ON claims (room_id, status);

CREATE TABLE IF NOT EXISTS events (
  -- The monotonic id doubles as the unread cursor.
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  agent_id   TEXT REFERENCES agents(id),
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_by_room ON events (room_id, id);

CREATE TABLE IF NOT EXISTS mentions (
  event_id INTEGER NOT NULL REFERENCES events(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  PRIMARY KEY (event_id, agent_id)
);

CREATE INDEX IF NOT EXISTS mentions_by_agent ON mentions (agent_id, event_id);

-- Unread state is the server's: the client remembers nothing.
CREATE TABLE IF NOT EXISTS cursors (
  agent_id      TEXT PRIMARY KEY REFERENCES agents(id),
  last_event_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plan_items (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES rooms(id),
  text           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'todo',
  owner_agent_id TEXT REFERENCES agents(id),
  note           TEXT,
  position       INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS plan_items_by_room ON plan_items (room_id, position);

-- The plan is published by the first agent to connect, not by a human. The
-- revision is bumped by any change: the others acknowledge against it.
CREATE TABLE IF NOT EXISTS plan_state (
  room_id     TEXT PRIMARY KEY REFERENCES rooms(id),
  revision    INTEGER NOT NULL DEFAULT 0,
  proposed_by TEXT REFERENCES agents(id),
  proposed_at TEXT
);

-- Explicit agreement with a specific revision: otherwise the web view cannot
-- tell whether the agents agreed or merely stayed quiet.
CREATE TABLE IF NOT EXISTS plan_acks (
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  revision   INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);

CREATE TABLE IF NOT EXISTS plan_notes (
  room_id    TEXT PRIMARY KEY REFERENCES rooms(id),
  body       TEXT NOT NULL DEFAULT '',
  -- Optimistic locking: a write against a stale version is rejected.
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
