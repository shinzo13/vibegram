<script>
  import { onMount } from 'svelte';
  import { agentColor, alertLabel, describe, mode, plural, time } from './format.js';
  import { renderMarkdown } from './markdown.js';
  import Identicon from './Identicon.svelte';
  import Tree from './Tree.svelte';

  // The read-only token comes from the link: /r/<token>. The room id is not
  // accepted here on purpose — it travels through logs, the token does not.
  const viewToken = window.location.pathname.startsWith('/r/')
    ? window.location.pathname.slice(3).split('/')[0]
    : '';
  let roomName = $state('');
  let denied = $state(false);
  let agents = $state([]);
  let plan = $state({ items: [], notes: { body: '' }, revision: 0, acks: [], proposedBy: null });
  let events = $state([]);
  let tree = $state([]);
  let connected = $state(false);

  let stream = null;
  // `$state` so the scroll effects re-run once `bind:this` fills it in.
  let feedEl = $state(null);

  // Same courtesy the alert dot pays: a reader who asked for less motion gets
  // an instant jump instead of a glide.
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  // `scrollTo` with options is the animated path; the bare assignment is the
  // fallback for jsdom in the tests, which implements neither smooth scrolling
  // nor the method itself.
  function toTail(smooth) {
    if (!feedEl) return;
    if (typeof feedEl.scrollTo === 'function') {
      feedEl.scrollTo({ top: feedEl.scrollHeight, behavior: smooth && !reduceMotion ? 'smooth' : 'auto' });
    } else {
      feedEl.scrollTop = feedEl.scrollHeight;
    }
  }

  // Which pane a phone shows. Three columns do not fit a hand, and the feed is
  // what people open the link for — the rest is a tap away.
  let pane = $state('feed');

  // The id just copied, so the tap has some acknowledgement.
  let copied = $state(null);

  /**
   * Hands an event id to the person reading.
   *
   * This page is where a human catches up, and the CLI takes an id to rewind
   * from: `read --since <id>`. Without a way to lift the id off the screen the
   * bridge between the two is someone retyping a number from a phone.
   */
  async function copyId(id) {
    try {
      await navigator.clipboard.writeText(String(id));
    } catch {
      // No clipboard permission, or an insecure origin. Selecting the number
      // by hand still works, so this is not worth an error message.
      return;
    }
    copied = id;
    setTimeout(() => {
      if (copied === id) copied = null;
    }, 1200);
  }

  const acked = $derived(
    new Set(plan.acks.filter((a) => a.revision === plan.revision).map((a) => a.nick)),
  );

  /** Tree header summary: how much of the repository is spoken for right now. */
  const treeStats = $derived.by(() => {
    const holders = new Set();
    let paths = 0;
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.heldHere) {
          holders.add(node.heldBy);
          paths += 1;
        }
        walk(node.children);
      }
    };
    walk(tree);
    // Built here rather than in markup: template line breaks would leak into
    // the rendered text as stray whitespace.
    return `${holders.size} ${plural(holders.size, 'holder', 'holders')} · ${paths} ${plural(paths, 'claimed path', 'claimed paths')}`;
  });

  async function loadState() {
    const res = await fetch(`/api/state?view=${encodeURIComponent(viewToken)}`);
    if (!res.ok) {
      denied = true;
      return;
    }
    const state = await res.json();
    roomName = state.room?.name ?? '';
    agents = state.agents;
    plan = state.plan;
    events = state.events;
    await loadTree();
  }

  // The tree is a separate request: it is large and changes far less often
  // than the rest, so it has no business inside the common state payload.
  async function loadTree() {
    const res = await fetch(`/api/tree?view=${encodeURIComponent(viewToken)}`);
    if (res.ok) tree = (await res.json()).tree;
  }

  /**
   * Side panels are re-read whole — re-deriving conflict logic in the browser
   * is pointless. The feed is deliberately left alone: it already holds the
   * event that arrived over the stream, and overwriting it would drop what
   * just came in and race with late responses.
   */
  let refreshing = false;
  async function refreshPanels() {
    if (refreshing) return;
    refreshing = true;
    try {
      const res = await fetch(`/api/state?view=${encodeURIComponent(viewToken)}`);
      if (!res.ok) return;
      const state = await res.json();
      agents = state.agents;
      plan = state.plan;
      await loadTree();
    } finally {
      refreshing = false;
    }
  }

  function listen() {
    stream?.close();
    stream = new EventSource(`/api/stream?view=${encodeURIComponent(viewToken)}`);
    stream.addEventListener('hello', () => (connected = true));
    stream.addEventListener('append', (e) => {
      const event = JSON.parse(e.data);
      // A reconnect can replay an event that is already on screen.
      if (events.some((existing) => existing.id === event.id)) return;
      events = [...events, event];
      refreshPanels();
    });
    stream.onerror = () => (connected = false);
  }

  onMount(async () => {
    if (!viewToken) {
      denied = true;
      return;
    }
    await loadState();
    if (!denied) listen();
    // The web fonts land after the first paint and change every row's height,
    // leaving the first snap-to-bottom short. Snap once more when they are in.
    try {
      await document.fonts?.ready;
    } catch {
      // no font-loading API — the first snap stands
    }
    requestAnimationFrame(() => toTail(false));
  });

  // Whether the reader is at the tail. Measured in `$effect.pre`, before the
  // new row lands in the DOM — once it is there the scroll height has already
  // grown and this always reads false.
  let atTail = true;
  $effect.pre(() => {
    events.length;
    if (feedEl) atTail = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 80;
  });

  // Follow the tail, but only when the reader is already there: otherwise
  // reading older events would be yanked away by every new arrival.
  let landed = false;
  $effect(() => {
    events.length;
    if (!feedEl) return;
    // First batch from /api/state: drop straight to the bottom. Gliding through
    // the whole history on load would just read as slow.
    if (!landed) {
      landed = true;
      queueMicrotask(() => toTail(false));
      return;
    }
    if (atTail) queueMicrotask(() => toTail(true));
  });
</script>

{#snippet idButton(id)}
  <button class="id" class:copied={copied === id} onclick={() => copyId(id)} title="copy the event id">
    {copied === id ? 'copied' : `#${id}`}
  </button>
{/snippet}

<header>
  <span class="brand">
    <!-- The mark, inline so it takes the wordmark's colour. Asymmetric V: left
         stroke full length, right one short and dimmed. See logo/README.md. -->
    <svg
      class="mark"
      viewBox="0 0 64 64"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      stroke-width="7"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M16 14 L32 46" />
      <path d="M48 14 L38 34" opacity="0.45" />
    </svg>
    <span class="wordmark">vibegram</span>
  </span>
  <span class="tick"></span>
  <span class="room">{roomName}</span>
  <span class="conn" class:lost={!connected}>
    <span class="conn-dot"></span>{connected ? 'stream live' : 'connection lost'}
  </span>
  <span class="readonly">read only</span>
</header>

{#if denied}
  <div class="denied">
    <p>This feed needs a link.</p>
    <p class="hint">Ask the team for the view link — it looks like /r/&lt;token&gt;. A room id will not do.</p>
  </div>
{:else}
<div class="body" data-pane={pane}>
  <aside class="left">
    <div class="scroll">
      <h2 class="label agents-label">agents</h2>
      {#each agents as agent}
        <div class="agent" class:offline={agent.status !== 'online'}>
          <Identicon nick={agent.nick} size={30} />
          <div class="agent-body">
            <span class="agent-head">
              <span class="nick" style:color={agentColor(agent.nick)}>{agent.nick}</span>
              <span class="status-dot" class:on={agent.status === 'online'}></span>
            </span>
            {#if agent.description}<span class="desc">{agent.description}</span>{/if}
            {#if agent.skills?.length}<span class="meta">{agent.skills.join(' · ')}</span>{/if}
            {#if agent.branch}<span class="meta">branch {agent.branch}</span>{/if}
            {#if agent.hooksAlive === false}
              <span class="meta unprotected">hooks off — writes not blocked</span>
            {/if}
            {#if agent.focus?.planItem}
              <span class="meta doing">doing: {agent.focus.planItem.text}</span>
            {/if}
            {#if agent.focus?.holding?.length}
              <span class="meta">holds: {agent.focus.holding.join(', ')}</span>
            {/if}
          </div>
        </div>
      {:else}
        <p class="empty">nobody connected</p>
      {/each}

      <h2 class="label plan-label">
        plan {#if plan.revision}<span class="rev">v{plan.revision}</span>{/if}
      </h2>
      {#if plan.items.length === 0}
        <p class="empty">no plan published yet</p>
      {:else}
        <div class="plan">
          {#each plan.items as item}
            <div class="item">
              <span class="square {item.status}"></span>
              <div class="item-body">
                <span class="text" class:done={item.status === 'done'}>{item.text}</span>
                <span class="owner" style:color={item.ownerNick ? agentColor(item.ownerNick) : null}>
                  {item.ownerNick ?? 'unowned'}
                </span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    {#if plan.items.length > 0}
      <div class="acks">
        <span class="ack-count">agreed {acked.size} / {agents.length}</span>
        {#each agents as agent}
          <span class="chip" class:yes={acked.has(agent.nick)}>
            {agent.nick.split('-').slice(1).join('-')}
          </span>
        {/each}
      </div>
    {/if}
  </aside>

  <main class="center">
    <div class="feed" bind:this={feedEl}>
      {#each events as event (event.id)}
        {#if mode(event.kind) === 'message'}
          <div class="msg">
            <Identicon nick={event.nick} size={26} />
            <div class="bubble" style:border-left-color={agentColor(event.nick)}>
              <span class="bubble-nick" style:color={agentColor(event.nick)}>{event.nick}</span>
              <div class="bubble-body md">{@html renderMarkdown(event.payload?.body ?? describe(event))}</div>
              <span class="bubble-time">
                {time(event.createdAt)}
                {@render idButton(event.id)}
              </span>
            </div>
          </div>
        {:else if mode(event.kind) === 'alert'}
          <div class="alert">
            <span class="alert-dot"></span>
            <Identicon nick={event.nick} size={16} />
            <span class="alert-label">{alertLabel(event)}</span>
            <span class="alert-nick" style:color={agentColor(event.nick)}>{event.nick}</span>
            <span class="alert-text">{describe(event)}</span>
            <span class="alert-time">
              {time(event.createdAt)}
              {@render idButton(event.id)}
            </span>
          </div>
        {:else}
          <div class="service">
            <span class="svc-time">{time(event.createdAt)}</span>
            <Identicon nick={event.nick ?? ''} size={13} />
            <span class="svc-nick" style:color={agentColor(event.nick)}>{event.nick ?? 'system'}</span>
            <span class="svc-text">{describe(event)}</span>
            <span class="svc-id">{@render idButton(event.id)}</span>
          </div>
        {/if}
      {:else}
        <p class="empty">nothing has happened yet</p>
      {/each}
    </div>
    <div class="foot">the feed only shows — agents write through the CLI and MCP</div>
  </main>

  <aside class="right">
    <div class="tree-head">
      <h2 class="label">tree</h2>
      <span class="tree-stats">{treeStats}</span>
    </div>
    <div class="tree-rows">
      {#if tree.length === 0}
        <p class="empty">tree is empty — no snapshots from agents yet</p>
      {:else}
        <Tree nodes={tree} />
      {/if}
    </div>
    <div class="legend">
      <span>colour — holder</span>
      <span>dimmed — inherited</span>
      <span class="ital">italic — untracked</span>
    </div>
  </aside>
</div>

<!-- Shown only on a narrow screen; on a wide one all three panes are visible
     at once and there is nothing to switch between. -->
<nav class="panes">
  <button class:on={pane === 'agents'} onclick={() => (pane = 'agents')}>
    agents<span class="badge">{agents.length}</span>
  </button>
  <button class:on={pane === 'feed'} onclick={() => (pane = 'feed')}>feed</button>
  <button class:on={pane === 'tree'} onclick={() => (pane = 'tree')}>tree</button>
</nav>
{/if}

<style>
  @import './fonts.css';

  :global(html),
  :global(body) {
    margin: 0;
    height: 100%;
    overflow: hidden;
  }

  :global(body) {
    background: #17181b;
    color: #d5d7dc;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
  }

  :global(#app) {
    height: 100vh;
    /* dvh follows the mobile browser chrome as it hides and reappears; without
       it the last line of the feed sits under the address bar */
    height: 100dvh;
    display: grid;
    grid-template-rows: 44px 1fr;
  }

  header {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 16px;
    background: #131417;
    border-bottom: 1px solid #23252b;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #d5d7dc;
  }

  .mark {
    flex: none;
    /* The mark's optical centre sits high; drop it a hair onto the text row. */
    margin-top: 1px;
  }

  .wordmark {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    letter-spacing: 0.02em;
    color: #d5d7dc;
  }

  .tick {
    width: 1px;
    height: 16px;
    background: #2b2e35;
  }

  .room {
    font-size: 13px;
    color: #9aa1ad;
  }

  .conn {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    font-size: 12px;
    color: #6f757f;
  }

  .conn-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4cae72;
  }

  .conn.lost .conn-dot {
    background: #e0554f;
  }

  .readonly {
    font-size: 12px;
    color: #565c66;
  }

  .body {
    display: grid;
    /* The info column carries cards now, not a flat list — it needs the room.
       The extra width comes off the feed, which was wider than a message ever
       is on a desktop. */
    grid-template-columns: 400px minmax(0, 1fr) 380px;
    min-height: 0;
  }

  /* ── left: agents and plan ───────────────────────────────────────────── */

  .left {
    background: #141518;
    border-right: 1px solid #23252b;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .scroll {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .label {
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #616772;
    font-weight: 400;
    margin: 0;
  }

  .agents-label {
    padding: 14px 16px 10px;
  }

  .plan-label {
    padding: 22px 16px 10px;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .rev {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    color: #4a5058;
    letter-spacing: 0;
    text-transform: none;
  }

  /* Each agent is a card, not a row in a monolith: it carries a name, a
     specialisation, a branch and a focus, and that reads better boxed. */
  .agent {
    display: grid;
    grid-template-columns: 30px 1fr;
    gap: 11px;
    align-items: start;
    margin: 0 12px 8px;
    padding: 10px 12px;
    background: #191a1e;
    border: 1px solid #24262c;
    border-radius: 9px;
  }

  .agent:first-of-type {
    margin-top: 2px;
  }

  .agent.offline {
    opacity: 0.5;
  }

  .agent-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .agent-head {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #3b3f47;
    flex: none;
  }

  .status-dot.on {
    background: #4cae72;
  }

  .nick {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .desc {
    font-size: 12px;
    color: #767c87;
  }

  .meta {
    font-size: 11px;
    color: #5c626c;
  }

  /* This agent can walk into a claimed file and nothing stops it — the team
     should see that without asking. */
  .meta.unprotected {
    color: #d3a24c;
  }

  .meta.doing {
    color: #767c87;
  }

  .plan {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 16px;
  }

  .item {
    display: grid;
    grid-template-columns: 7px 1fr;
    gap: 10px;
    align-items: start;
    padding: 5px 0;
  }

  .square {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    margin-top: 6px;
  }

  .square.doing {
    background: #d3a24c;
  }

  .square.done {
    background: #3f7a55;
  }

  .square.todo {
    background: #3b3f47;
  }

  .square.blocked {
    background: #e0554f;
  }

  .item-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .text {
    font-size: 13px;
    line-height: 1.35;
    color: #c8ccd3;
  }

  .text.done {
    color: #5c626c;
    text-decoration: line-through;
  }

  .owner {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    color: #4a5058;
  }

  .acks {
    margin-top: 14px;
    padding: 10px 16px;
    border-top: 1px solid #202228;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }

  .ack-count {
    font-size: 11px;
    color: #616772;
  }

  .chip {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
    color: #5c626c;
    background: rgba(255, 255, 255, 0.04);
  }

  .chip.yes {
    color: #7fc39a;
    background: rgba(76, 174, 114, 0.12);
  }

  /* ── center: the feed ────────────────────────────────────────────────── */

  .center {
    background: #17181b;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .feed {
    flex: 1;
    /* A reading measure: past this the feed just spreads a message across half
       a metre. Wider screens get side margin instead. */
    align-self: center;
    width: 100%;
    max-width: 900px;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 16px 24px 20px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .foot {
    padding: 10px 24px;
    border-top: 1px solid #23252b;
    background: #141518;
    font-size: 12px;
    color: #4a5058;
  }

  /* A message row: avatar in the gutter, bubble beside it — a chat, basically. */
  .msg {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 7px 0;
  }

  .msg :global(.identicon) {
    margin-top: 3px;
  }

  .bubble {
    max-width: 560px;
    min-width: 0;
    padding: 9px 13px 8px;
    background: #202329;
    border-radius: 3px 12px 12px 12px;
    border-left: 2px solid;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .bubble-nick {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
  }

  .bubble-body {
    font-size: 14px;
    line-height: 1.45;
    color: #d9dbe0;
  }

  /* ── markdown in a message ───────────────────────────────────────────────
     Agents write it constantly. `code` and **bold** get a real highlight, not
     just a different face — a warm chip and a cool one, so they read apart. */
  .md :global(p) {
    margin: 0;
  }

  .md :global(p + p),
  .md :global(pre),
  .md :global(ul),
  .md :global(ol),
  .md :global(blockquote) {
    margin: 6px 0 0;
  }

  .md :global(strong) {
    font-weight: 600;
    color: #eaf1f8;
    background: rgba(108, 182, 255, 0.14);
    border-radius: 3px;
    padding: 0 3px;
  }

  .md :global(em) {
    color: #c6cbd3;
  }

  .md :global(del) {
    color: #6f757f;
  }

  .md :global(code) {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.9em;
    color: #e6b673;
    background: #2b2f38;
    border-radius: 4px;
    padding: 1px 5px;
  }

  .md :global(pre) {
    background: #15161a;
    border: 1px solid #262931;
    border-radius: 6px;
    padding: 8px 10px;
    overflow-x: auto;
  }

  .md :global(pre code) {
    display: block;
    color: #cdd2da;
    background: none;
    padding: 0;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre;
  }

  .md :global(a) {
    color: #6cb6ff;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .md :global(.mention) {
    color: #7cc4ff;
    background: rgba(108, 182, 255, 0.13);
    border-radius: 3px;
    padding: 0 3px;
    font-weight: 500;
  }

  .md :global(ul),
  .md :global(ol) {
    padding-left: 18px;
  }

  .md :global(li) {
    margin: 1px 0;
  }

  .md :global(blockquote) {
    border-left: 2px solid #3b3f47;
    padding-left: 10px;
    color: #9aa1ad;
  }

  .md :global(.md-h) {
    font-size: 13.5px;
    font-weight: 600;
    color: #e8eaee;
    margin: 6px 0 3px;
  }

  .bubble-time {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: #5c626c;
    align-self: flex-end;
    margin-top: -2px;
  }

  .service {
    padding: 3px 0 3px 4px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    row-gap: 2px;
    gap: 8px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
  }

  .svc-time {
    color: #4a5058;
  }

  .svc-nick {
    opacity: 0.85;
  }

  .svc-text {
    color: #6b717b;
    overflow-wrap: anywhere;
  }

  /* A collision has to be visible without reading — that is the whole point. */
  .alert {
    width: 100%;
    margin: 7px 0;
    padding: 10px 14px;
    background: rgba(224, 85, 79, 0.13);
    border-left: 3px solid #e0554f;
    border-radius: 0 6px 6px 0;
    display: flex;
    align-items: center;
    gap: 11px;
    box-sizing: border-box;
  }

  .alert-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #e0554f;
    flex: none;
    animation: pulse 1.6s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.25;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .alert-dot {
      animation: none;
    }
  }

  .alert-label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    color: #e0554f;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    flex: none;
  }

  .alert-nick {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    flex: none;
  }

  .alert-text {
    font-size: 13px;
    color: #efb9b6;
  }

  .alert-time {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    color: #8c6e6c;
    margin-left: auto;
    flex: none;
  }

  /* ── right: the tree ─────────────────────────────────────────────────── */

  .right {
    background: #141518;
    border-left: 1px solid #23252b;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .tree-head {
    padding: 14px 16px 10px;
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  .tree-stats {
    font-size: 11px;
    color: #4a5058;
  }

  .tree-rows {
    padding: 0 12px 14px;
    overflow-y: auto;
    min-height: 0;
  }

  .legend {
    margin-top: auto;
    padding: 10px 16px;
    border-top: 1px solid #202228;
    display: flex;
    gap: 14px;
    font-size: 11px;
    color: #565c66;
  }

  .legend .ital {
    font-style: italic;
  }

  .denied {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #9aa1ad;
    font-size: 14px;
  }

  .denied .hint {
    color: #565c66;
    font-size: 12px;
  }

  .empty {
    color: #4a5058;
    font-size: 12px;
    padding: 0 16px;
  }

  /* ── scrollbars ──────────────────────────────────────────────────────────
     The browser default is a wide grey slab that fights the dark chrome. Make
     it a thin rail that stays out of the way and only firms up on hover. */
  .scroll,
  .feed,
  .tree-rows {
    scrollbar-width: thin;
    scrollbar-color: #30333a transparent;
  }

  .scroll::-webkit-scrollbar,
  .feed::-webkit-scrollbar,
  .tree-rows::-webkit-scrollbar {
    width: 9px;
    height: 9px;
  }

  .scroll::-webkit-scrollbar-track,
  .feed::-webkit-scrollbar-track,
  .tree-rows::-webkit-scrollbar-track {
    background: transparent;
  }

  .scroll::-webkit-scrollbar-thumb,
  .feed::-webkit-scrollbar-thumb,
  .tree-rows::-webkit-scrollbar-thumb {
    background: #2b2e35;
    border: 3px solid transparent;
    background-clip: padding-box;
    border-radius: 9px;
  }

  .scroll:hover::-webkit-scrollbar-thumb,
  .feed:hover::-webkit-scrollbar-thumb,
  .tree-rows:hover::-webkit-scrollbar-thumb {
    background: #3c414b;
    background-clip: padding-box;
  }

  /* Below this width the tree is no longer readable at 380px; the brief calls
     for dropping the column rather than squeezing it. With the wider info
     column the three-up layout runs out of room sooner. */
  @media (max-width: 1240px) {
    .body {
      grid-template-columns: 372px minmax(0, 1fr);
    }

    .right {
      display: none;
    }
  }

  /* ── event ids: the handle a person uses to rewind from the cli ───────── */

  .id {
    appearance: none;
    background: none;
    border: none;
    padding: 0 0 0 6px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: inherit;
    color: #464c55;
    cursor: pointer;
    /* Quiet until wanted: this is a handle, not information anyone reads. */
    opacity: 0;
    transition: opacity 0.12s;
  }

  .bubble:hover .id,
  .alert:hover .id,
  .service:hover .id,
  .id:focus-visible,
  .id.copied {
    opacity: 1;
  }

  .id:hover {
    color: #8b919b;
  }

  .id.copied {
    color: #4cae72;
  }

  .svc-id {
    margin-left: auto;
  }

  /* A handle that only appears on hover is a handle a touch screen never has.
     Keyed on hover rather than width: a tablet is wide and still has no cursor. */
  @media (hover: none) {
    .id {
      opacity: 1;
      padding: 4px 2px 4px 8px;
    }
  }

  /* ── the pane switcher: only ever visible on a narrow screen ──────────── */

  .panes {
    display: none;
  }

  @media (max-width: 720px) {
    :global(#app) {
      grid-template-rows: 40px 1fr auto;
    }

    header {
      gap: 8px;
      padding: 0 12px;
    }

    /* The room name is the one thing worth keeping when space runs out: the
       wordmark repeats on every page and "read only" is said again in the
       footer. */
    .wordmark,
    .readonly,
    .tick {
      display: none;
    }

    .room {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .conn {
      flex: none;
    }

    .body {
      grid-template-columns: 1fr;
      min-width: 0;
    }

    .left,
    .right {
      display: none;
      border-right: none;
      border-left: none;
    }

    .body[data-pane='agents'] .left,
    .body[data-pane='tree'] .right {
      display: flex;
    }

    .body[data-pane='agents'] .center,
    .body[data-pane='tree'] .center {
      display: none;
    }

    .feed {
      padding: 12px 12px 16px;
    }

    .bubble {
      max-width: 100%;
    }

    /* The alert rows are a single line of five parts on a desktop; on a phone
       that line becomes five words a row deep. */
    .alert {
      flex-wrap: wrap;
      row-gap: 2px;
    }

    .alert-text {
      flex-basis: 100%;
    }

    .service {
      flex-wrap: wrap;
      row-gap: 2px;
    }

    .foot,
    .legend {
      padding-left: 12px;
      padding-right: 12px;
    }

    .panes {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      background: #131417;
      border-top: 1px solid #23252b;
      /* Clears the home indicator on a phone without a bar, and collapses to
         nothing everywhere else. */
      padding-bottom: env(safe-area-inset-bottom, 0);
    }

    .panes button {
      appearance: none;
      background: none;
      border: none;
      border-top: 2px solid transparent;
      color: #6f757f;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 12px;
      letter-spacing: 0.04em;
      /* 44px of height: anything less is a miss on a thumb. */
      padding: 14px 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
    }

    .panes button.on {
      color: #d5d7dc;
      border-top-color: #4cae72;
    }

    .badge {
      font-size: 10px;
      color: #565c66;
    }

    .panes button.on .badge {
      color: #6f757f;
    }
  }
</style>
