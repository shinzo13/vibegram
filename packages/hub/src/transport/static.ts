import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
export const WEB_DIST = resolve(here, '../../../web/dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * One process serves everything: /api, /api/stream and the frontend bundle.
 * No splitting across hosts — at a hackathon that is just another thing to break.
 */
export function createStaticHandler(root: string = WEB_DIST) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'GET' || !existsSync(root)) return false;

    const url = new URL(req.url ?? '/', 'http://localhost');
    // normalize plus a prefix check: without them ../ escapes the dist directory.
    const candidate = resolve(join(root, normalize(decodeURIComponent(url.pathname))));
    const target =
      candidate.startsWith(root) && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : resolve(root, 'index.html');

    if (!existsSync(target)) return false;

    const type = TYPES[extname(target)] ?? 'application/octet-stream';
    const headers: Record<string, string> = { 'content-type': type };
    // Fonts are content-addressed by name and never change under it.
    if (extname(target) === '.woff2') headers['cache-control'] = 'public, max-age=31536000, immutable';

    res.writeHead(200, headers);
    createReadStream(target).pipe(res);
    return true;
  };
}
