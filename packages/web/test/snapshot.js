/**
 * Static snapshot of the interface: renders the real components with the demo
 * fixture and writes the resulting HTML, styles included.
 *
 * Lets anyone look at the UI without starting the hub or any agents, and works
 * as a fallback during a demo if the live agents misbehave.
 *
 * Run: npm run snapshot  ->  packages/web/snapshot.html
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const view = await render();

const out = resolve(here, '../snapshot.html');
writeFileSync(out, `<!doctype html>\n${view.dom.window.document.documentElement.outerHTML}\n`);
console.log(`snapshot: ${out}`);
process.exit(0);
