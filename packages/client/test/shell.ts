/**
 * Shell command parsing. A false refusal costs more than a miss here: an unfair
 * deny convinces an agent the system is broken and sends it looking for a way
 * around on purpose. So "let it through" is an acceptable outcome and "refused
 * for nothing" is not.
 *
 * Run: npm run test:shell
 */
import { writeTargets } from '../src/shell.ts';

const HELD = ['src/routing.ts', 'packages/hub/', 'README.md'];

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || detail === '' ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

function blocks(command: string): string[] {
  return writeTargets(command, HELD);
}

console.log('— must be caught —');
check('output redirection', blocks('echo x > src/routing.ts').length > 0);
check('append', blocks('cat foo >> src/routing.ts').length > 0);
check('sed -i', blocks("sed -i '' 's/a/b/' src/routing.ts").length > 0);
check('tee', blocks('echo x | tee src/routing.ts').length > 0);
check('mv over a claimed file', blocks('mv tmp.ts src/routing.ts').length > 0);
check('rm', blocks('rm -f README.md').length > 0);
check('file inside a claimed directory', blocks('echo x > packages/hub/src/db.ts').length > 0);
check('quoted path', blocks('echo x > "src/routing.ts"').length > 0);
check('git checkout over it', blocks('git checkout -- src/routing.ts').length > 0);
check('python writing', blocks('python3 -c "open(\'src/routing.ts\',\'w\')"').length > 0);

console.log('\n— must NOT be caught —');
check('reading a file', blocks('cat src/routing.ts').length === 0, blocks('cat src/routing.ts'));
check('grep over a file', blocks('grep -n foo src/routing.ts').length === 0);
check('writing to a free file', blocks('echo x > src/other.ts').length === 0);
check('similar name', blocks('echo x > src/routing.ts.bak').length === 0, blocks('echo x > src/routing.ts.bak'));
check(
  'directory with a shared prefix',
  blocks('echo x > packages/hub-web/a.ts').length === 0,
  blocks('echo x > packages/hub-web/a.ts'),
);
check('mention in text without a write', blocks('echo "see src/routing.ts"').length === 0);
check('git status', blocks('git status').length === 0);
check('running tests', blocks('npm test').length === 0);
check('listing a claimed directory', blocks('ls packages/hub/').length === 0, blocks('ls packages/hub/'));

console.log(failures === 0 ? '\ncommand parsing has no false positives' : `\nfailed: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
