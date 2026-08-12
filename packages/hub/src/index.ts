import { openDb } from './db.ts';
import { createCtx, reapStale } from './core/index.ts';
import { createHttpServer } from './transport/http.ts';
import { createStaticHandler } from './transport/static.ts';

const PORT = Number(process.env.VIBEGRAM_PORT ?? 4321);

const db = openDb();
const ctx = createCtx(db);
const server = createHttpServer(ctx, createStaticHandler());

// A crashed agent never fires SessionEnd, so dead claims are reaped on a timer
// rather than only on a clean exit. See PLAN.md.
const reaper = setInterval(() => {
  try {
    const reaped = reapStale(ctx);
    if (reaped > 0) console.log(`[hub] stale claims released: ${reaped}`);
  } catch (err) {
    console.error('[hub] reaper', err);
  }
}, 60_000);
reaper.unref();

server.listen(PORT, () => {
  console.log(`[hub] listening on http://localhost:${PORT}`);
});

function shutdown(): void {
  clearInterval(reaper);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
