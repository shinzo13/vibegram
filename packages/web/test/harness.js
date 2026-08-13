/**
 * Mounts the real components in jsdom with fetch and EventSource stubbed.
 * Shared by the render test and the static snapshot so both exercise the same
 * code path the browser would.
 */
import { JSDOM } from 'jsdom';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE, TREE } from './fixture.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Compiled next to the project, not in a temp dir: the generated code imports
 * `svelte`, which only resolves from inside the workspace. Component imports
 * are rewritten from .svelte to .js — including Tree, which imports itself.
 */
function compileComponents() {
  const dir = resolve(here, '.tmp');
  mkdirSync(dir, { recursive: true });

  for (const name of readdirSync(resolve(here, '../src'))) {
    const source = readFileSync(resolve(here, '../src', name), 'utf8');
    if (name.endsWith('.svelte')) {
      const { js } = compile(source, { generate: 'client', filename: name, css: 'injected' });
      writeFileSync(resolve(dir, name.replace('.svelte', '.js')), js.code.replaceAll('.svelte', '.js'));
    } else if (name.endsWith('.js') && name !== 'main.js') {
      writeFileSync(resolve(dir, name), source);
    }
  }
  return dir;
}

export async function render({ onStream } = {}) {
  const dir = compileComponents();

  const dom = new JSDOM(
    '<!doctype html><html><head><meta charset="utf-8"><title>vibegram</title></head><body><div id="app"></div></body></html>',
    { url: 'http://localhost:4321/r/demo-view-token' },
  );

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // navigator is read-only in node — swap it through a descriptor.
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

  // Svelte's client runtime expects the DOM constructors as globals.
  for (const name of [
    'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'HTMLElement',
    'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'DOMParser', 'Range',
  ]) {
    if (globalThis[name] === undefined) globalThis[name] = dom.window[name];
  }

  const listeners = new Map();
  globalThis.EventSource = class {
    addEventListener(type, fn) {
      listeners.set(type, fn);
      if (type === 'hello') setTimeout(() => fn({}), 0);
    }
    close() {}
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () =>
      url.startsWith('/api/tree') ? { tree: TREE } : STATE,
  });

  const { mount, flushSync } = await import('svelte');
  const App = (await import(`file://${resolve(dir, 'App.js')}`)).default;

  mount(App, { target: document.getElementById('app') });

  // Wait for the condition rather than a fixed delay: the stream hello arrives
  // asynchronously, and a fixed wait turns into a flake the moment the machine
  // is busy — which is exactly when the suite runs.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    flushSync();
    if (dom.window.document.body.textContent.includes('stream live')) break;
  }

  onStream?.(listeners);

  return {
    dom,
    dir,
    listeners,
    flush: async () => {
      await new Promise((r) => setTimeout(r, 50));
      flushSync();
    },
    get html() {
      return dom.window.document.body.innerHTML;
    },
    get text() {
      return dom.window.document.body.textContent;
    },
  };
}
