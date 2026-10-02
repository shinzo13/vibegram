/**
 * Several agents in one working copy.
 *
 * The copy used to map to exactly one identity, so a second agent joining from
 * the same directory silently took over the first one's seat. Each check here
 * is a way to tell them apart, or a config an older client left behind.
 *
 * Run: npm run test:identity
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const home = mkdtempSync(resolve(tmpdir(), 'vibegram-identity-'));
process.env.VIBEGRAM_HOME = home;
delete process.env.VIBEGRAM_AS;
// HOME_DIR is fixed at import time, so the environment has to be set first.
const { resolveIdentity, saveIdentity } = await import('../src/config.ts');
const { learnSession, sessionNick } = await import('../src/hook.ts');

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || detail === '' ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'vibegram-copy-')));
execFileSync('git', ['init', '-q'], { cwd: root });

const base = { hub: 'http://hub', roomId: 'r1', viewToken: 'V', root, cli: 'vibegram' };

// An older client keyed the identity by the bare root.
mkdirSync(resolve(home, '.vibegram'), { recursive: true });
writeFileSync(
  resolve(home, '.vibegram/config.json'),
  JSON.stringify({ hub: 'http://hub', identities: { [root]: { ...base, nick: 'claude-old', token: 't0' } } }),
);
const legacy = resolveIdentity(root);
check('a config from an older client still resolves', legacy.identity?.nick === 'claude-old', legacy);
check('alone in the copy, hints carry no --as', legacy.identity?.cli === 'vibegram');

saveIdentity({ ...base, nick: 'qwen-new', token: 't1' });
const shared = resolveIdentity(root);
check('with two agents and no name given, nobody is guessed', shared.identity === null, shared);
check('the agents in the copy are listed', shared.candidates.sort().join(',') === 'claude-old,qwen-new', shared.candidates);

const picked = resolveIdentity(root, 'qwen-new');
check('--as picks the agent, with its own token', picked.identity?.token === 't1');
check('hints then carry --as, so the copied command works', picked.identity?.cli === 'vibegram --as qwen-new');
check('an unknown name resolves to nobody', resolveIdentity(root, 'kimi-x').identity === null);

process.env.VIBEGRAM_AS = 'claude-old';
check('VIBEGRAM_AS works like --as', resolveIdentity(root).identity?.nick === 'claude-old');
delete process.env.VIBEGRAM_AS;

saveIdentity({ ...base, nick: 'claude-old', token: 't2' });
check('rejoining moves the old entry to the new key instead of doubling it', resolveIdentity(root).candidates.length === 2);
check('and keeps the fresh token', resolveIdentity(root, 'claude-old').identity?.token === 't2');

learnSession('s1', 'vibegram --as qwen-new claim src/a.ts');
learnSession('s2', 'VIBEGRAM_AS=claude-old vibegram read');
learnSession('s3', 'echo --as qwen-new');
check(
  'a session is bound by the name it uses in its own vibegram commands',
  sessionNick('s1') === 'qwen-new' && sessionNick('s2') === 'claude-old' && sessionNick('s3') === null,
);

rmSync(home, { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? '\nall good' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
