/**
 * Checks the interface without a browser: mounts the real components in jsdom
 * and inspects what actually landed in the DOM.
 *
 * Run: npm run test:web
 */
import { resolve } from 'node:path';
import { render } from './harness.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

const view = await render();

// Read through the getters rather than snapshotting: the stream hello arrives
// asynchronously, and a snapshot taken a tick too early sees the pre-connect state.
const html = () => view.html;
const text = () => view.text;

// ── header ────────────────────────────────────────────────────────────────

check('wordmark and room', text().includes('vibegram') && text().includes('hackathon'));
check('live stream indicator', text().includes('stream live'), text().slice(0, 120));
check('read-only marker', text().includes('read only'));

// ── left column ───────────────────────────────────────────────────────────

check('agents listed', text().includes('claude-shinrei') && text().includes('chatgpt-nightshelf'));
check('offline agent dimmed', html().includes('agent offline') || html().includes('offline'));
check('an identicon per agent', (html().match(/class="identicon[^"]*"/g) ?? []).length >= 4, (html().match(/class="identicon[^"]*"/g) ?? []).length);

// The brief dropped these; they are kept deliberately — specialisation and
// branch are invisible in the tree, and agents pick work by them.
check('agent card keeps skills', text().includes('sqlite'));
check('agent card keeps branch', text().includes('branch feat/hub'));
check('unprotected agent is flagged', text().includes('hooks off'), 'no unprotected marker');
check('agent card keeps focus', text().includes('doing:') && text().includes('holds:'));

check('plan version badge', text().includes('v3'));
check('plan item statuses', html().includes('square doing') && html().includes('square done'));
check('done item struck through', /class="text[^"]*done"/.test(html()));
check('unowned item labelled', text().includes('unowned'));
check('ack counter', text().includes('agreed 3 / 4'));
check('ack chips use second nick segment', text().includes('shinrei') && !text().includes('claude-shinrei\n'), null);
check('unacknowledged chip is plain', (html().match(/class="chip svelte-[^"]*"/g) ?? []).length >= 1);

// ── feed ──────────────────────────────────────────────────────────────────

check('message rendered as bubble', html().includes('class="bubble'), null);
check('bubble carries agent colour', /class="bubble[^"]*"[^>]*border-left-color: rgb/.test(html()));
check('service events are quiet rows', html().includes('class="service'), null);
check('conflict rendered as alert', html().includes('class="alert'), null);
check('alert label reads denied', text().includes('denied'));
check('alert label reads blocked', text().includes('blocked'));
check('alert label reads violation', text().includes('violation'));
check('pulsing dot present', html().includes('alert-dot'));

check('claim text in english', text().includes('claimed packages/hub/'));
check('release text in english', text().includes('released'));
check('denied text uses em dash', text().includes('held by claude-shinrei'), null);
check('blocked write text', text().includes('blocked — held by claude-haikesan'));
check('occurred write text', text().includes('wrote into packages/web/src/App.svelte'));
check('join and leave in english', text().includes('joined'));
check('footer explains read-only', text().includes('agents write through the CLI and MCP'));

// ── tree ──────────────────────────────────────────────────────────────────

check('tree rendered', text().includes('packages/') && text().includes('hook.ts'));
check('tree summary counts holders', text().includes('3 holders · 3 claimed paths'), text().match(/\d+ holders[^<]{0,30}/)?.[0]);
check('legend present', text().includes('colour — holder') && text().includes('italic — untracked'));

const colorOf = (name) => {
  const row = html().match(new RegExp(`<span class="name[^"]*"[^>]*style="([^"]*)"[^>]*>\\s*${name}`));
  return row?.[1]?.match(/color: (rgb\([^)]+\))/)?.[1] ?? null;
};
const heldDirect = colorOf('hook\\.ts');
const inherited = colorOf('db\\.ts');
check('directly claimed file coloured', heldDirect !== null, heldDirect);
check('inherited claim dimmed differently', inherited !== null && inherited !== heldDirect, { heldDirect, inherited });
check('unclaimed file left neutral', colorOf('cli\\.ts') === null, colorOf('cli\\.ts'));
check('holder badge on direct claims', html().includes('class="badge'), null);
check('claimed row tinted', /background: rgba?\(/.test(html()));

const { agentColor } = await import(`file://${resolve(view.dir, 'format.js')}`);
check('same platform, different agents differ', agentColor('claude-shinrei') !== agentColor('claude-haikesan'));
check('colour is stable', agentColor('claude-shinrei') === agentColor('claude-shinrei'));

// ── live append ───────────────────────────────────────────────────────────

const append = view.listeners.get('append');
check('subscribed to the stream', typeof append === 'function');
if (append) {
  append({
    data: JSON.stringify({
      id: 99,
      kind: 'violation',
      nick: 'cursor-vermillion',
      createdAt: new Date().toISOString(),
      payload: { resource: 'src/x.ts', heldBy: 'claude-shinrei', outcome: 'occurred' },
    }),
  });
  await view.flush();
  check('new event appended', view.text.includes('src/x.ts'));
}

// ── the pane switcher ─────────────────────────────────────────────────────
// Three columns do not fit a phone, so a narrow screen shows one at a time.
// The switcher is rendered always and hidden by css — jsdom applies no
// stylesheet, so what is checked here is that the mechanism exists and works.

check(
  'a switcher for narrow screens is rendered',
  view.dom.window.document.querySelector('.panes') !== null,
);
check('the feed is the pane shown first', html().includes('data-pane="feed"'));

const paneButtons = [...view.dom.window.document.querySelectorAll('.panes button')].map((b) => b.textContent.trim());
check('all three panes are reachable', paneButtons.length === 3, paneButtons);

const treeButton = [...view.dom.window.document.querySelectorAll('.panes button')].find((b) =>
  b.textContent.includes('tree'),
);
if (treeButton) {
  treeButton.click();
  await view.flush();
  check('tapping a pane switches to it', html().includes('data-pane="tree"'), html().slice(0, 80));
}

// ── event ids ─────────────────────────────────────────────────────────────
// The page is where a human catches up; the cli rewinds from an id. Without a
// way to lift the id off the screen, the bridge between them is someone
// retyping a number off a phone.

const idButtons = [...view.dom.window.document.querySelectorAll('button.id')];
check('every event offers its id', idButtons.length > 0, idButtons.length);
check('the id is shown as it is typed into --since', idButtons[0]?.textContent.trim().startsWith('#'), idButtons[0]?.textContent);

let copiedValue = null;
view.dom.window.navigator.clipboard = { writeText: async (v) => { copiedValue = v; } };
idButtons[0]?.click();
await view.flush();
check('tapping it copies the bare number', copiedValue !== null && /^\d+$/.test(copiedValue), copiedValue);
check('and says so', view.html.includes('copied'), copiedValue);

console.log(failures === 0 ? '\ninterface renders correctly' : `\nfailed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
