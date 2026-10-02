/**
 * Installing into someone else's config files.
 *
 * Every check here stands for a way this went wrong in practice: hooks written
 * into the file that travels in git, a clone whose directory is not called
 * "vibegram" and so goes unrecognised by our own filter, and an install that
 * could not be undone without editing json by hand.
 *
 * Run: npm run test:install
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  hookCommand,
  inspectHooks,
  installClaudeHooks,
  installMcpServer,
  installRules,
  ownsCommand,
  runLeave,
} from '../src/init.ts';

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || detail === '' ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

function tempRepo(): string {
  return mkdtempSync(resolve(tmpdir(), 'vibegram-install-'));
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function write(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

console.log('— the command that goes into the config —');
check('launcher is preferred', hookCommand('claude', true) === 'vibegram hook --dialect claude');
check('absolute path is the fallback', hookCommand('claude', false).startsWith('node /'));

console.log('\n— recognising our own entries —');
check('launcher invocation', ownsCommand('vibegram hook --dialect claude'));
check('absolute path invocation', ownsCommand('node /home/x/projects/vibegram/packages/client/src/cli.ts hook --dialect claude'));
// the filter used to look for the word "vibegram" and missed this one
check('clone in a directory with another name', ownsCommand('node /home/x/work/vg/packages/client/src/cli.ts hook --dialect claude'));
check('someone else s hook is not ours', !ownsCommand('npm run lint'));
check('a tool merely named in an argument is not ours', !ownsCommand('echo vibegram-is-nice'));

console.log('\n— where hooks land —');
{
  const root = tempRepo();
  const path = installClaudeHooks(root);
  check('written to the local file', path.endsWith('.claude/settings.local.json'), path);
  check('the shared file is left alone', readJson(path).hooks.PreToolUse.length === 1);
  rmSync(root, { recursive: true, force: true });
}

console.log('\n— an older install is migrated —');
{
  const root = tempRepo();
  const shared = resolve(root, '.claude/settings.json');
  write(shared, {
    hooks: {
      PreToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'node /old/clone/packages/client/src/cli.ts hook --dialect claude' }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run guard' }] },
      ],
    },
  });

  installClaudeHooks(root);
  const after = readJson(shared);
  check('ours is gone from the shared file', JSON.stringify(after).includes('cli.ts hook') === false, after);
  check('the human own hook survives', JSON.stringify(after).includes('npm run guard'), after);
  rmSync(root, { recursive: true, force: true });
}

console.log('\n— leave —');
{
  const root = tempRepo();
  installClaudeHooks(root);
  installMcpServer(root);
  const local = resolve(root, '.claude/settings.local.json');
  const settings = readJson(local);
  settings.hooks.PreToolUse.push({ matcher: 'Write', hooks: [{ type: 'command', command: 'npm run guard' }] });
  write(local, settings);
  write(resolve(root, '.mcp.json'), { mcpServers: { vibegram: { command: 'node' }, other: { command: 'x' } } });

  runLeave(root);
  const left = readJson(local);
  check('our hooks are removed', JSON.stringify(left).includes('hook --dialect') === false, left);
  check('the human own hook stays', JSON.stringify(left).includes('npm run guard'), left);

  const mcp = readJson(resolve(root, '.mcp.json'));
  check('our mcp entry is removed', mcp.mcpServers.vibegram === undefined);
  check('another mcp server stays', mcp.mcpServers.other !== undefined);
  rmSync(root, { recursive: true, force: true });
}

console.log('\n— doctor sees a dead path —');
{
  const root = tempRepo();
  write(resolve(root, '.claude/settings.local.json'), {
    hooks: {
      PreToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'node /gone/clone/packages/client/src/cli.ts hook --dialect claude' }] },
      ],
    },
  });

  const claude = inspectHooks(root).find((h) => h.dialect === 'claude' && h.installed);
  check('installed is reported', claude !== undefined);
  check('but it does not resolve', claude?.resolves === false, claude);
  rmSync(root, { recursive: true, force: true });
}

console.log('\n— nothing installed —');
{
  const root = tempRepo();
  check('reported as not installed', inspectHooks(root).every((h) => !h.installed));
  check('leave on a clean repo touches nothing', runLeave(root).length === 0);
  rmSync(root, { recursive: true, force: true });
}

console.log('\n— joining without hooks —');
{
  const root = tempRepo();
  installMcpServer(root);
  // --no-hooks installs everything except interception: the mcp entry is there,
  // the hooks are not, and doctor must not pretend otherwise
  check('mcp entry is written', existsSync(resolve(root, '.mcp.json')));
  check('no hooks are reported', inspectHooks(root).every((h) => !h.installed));
  rmSync(root, { recursive: true, force: true });
}

console.log('\n— rules in AGENTS.md —');
{
  const root = tempRepo();
  const path = resolve(root, 'AGENTS.md');
  installRules(root);
  const fresh = readFileSync(path, 'utf8');
  check('a missing AGENTS.md is created with the block', fresh.startsWith('<!-- vibegram:start -->') && fresh.includes('vibegram claim'));

  writeFileSync(path, `# team rules\n\nbe nice\n\n${fresh}\nafter us\n`);
  installRules(root);
  installRules(root);
  const again = readFileSync(path, 'utf8');
  check(
    'a second join replaces the block in place: one copy, the team text around it untouched',
    again.split('<!-- vibegram:start -->').length === 2 &&
      again.startsWith('# team rules\n\nbe nice\n') &&
      again.trimEnd().endsWith('after us'),
    again,
  );
  check('the block carries no absolute paths — the file travels in git', !again.includes(root) && !again.includes('cli.ts'));
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
