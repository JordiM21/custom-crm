import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Local development server.
 *
 * Serves `public/` and maps /api/<path> to api/<path>.ts, the same way Vercel
 * does, so the panel can be run with `npm run dev:local` and no Vercel account.
 */

const ROOT = process.cwd();
const PORT = Number.parseInt(process.env['PORT'] ?? '3000', 10);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Adds the `status`/`json`/`send` helpers Vercel puts on the response. */
function decorate(res: import('node:http').ServerResponse): void {
  const target = res as unknown as Record<string, unknown>;
  target['status'] = (code: number) => {
    res.statusCode = code;
    return res;
  };
  target['json'] = (body: unknown) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  };
  target['send'] = (body: string) => res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  decorate(res);

  if (url.pathname.startsWith('/api/')) {
    const modulePath = join(ROOT, `${url.pathname.replace(/\/$/, '')}.ts`);
    try {
      const mod = (await import(pathToFileURL(modulePath).href)) as {
        default: (req: unknown, res: unknown) => Promise<void> | void;
      };
      (req as unknown as Record<string, unknown>)['query'] = Object.fromEntries(
        url.searchParams.entries(),
      );
      await mod.default(req, res);
    } catch (err) {
      console.error(`[dev] ${url.pathname} failed:`, err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
      }
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = join(ROOT, 'public', normalize(requested).replace(/^(\.\.[/\\])+/, ''));

  try {
    const file = await readFile(filePath);
    res.setHeader('content-type', MIME[extname(filePath)] ?? 'application/octet-stream');
    res.end(file);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  LET Junior panel  →  http://localhost:${PORT}\n`);
});
