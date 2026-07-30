import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  createServer,
  type Server,
  type ServerResponse
} from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));
const MOUNT_PATHS = ['/', '/dynamic-drought-module/'] as const;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

function mountedFilePath(requestUrl: string | undefined): string | null {
  const pathname = new URL(requestUrl ?? '/', 'http://127.0.0.1').pathname;
  const mountPath = pathname.startsWith(MOUNT_PATHS[1])
    ? MOUNT_PATHS[1]
    : MOUNT_PATHS[0];
  if (!mountPath) return null;

  const relativePath = decodeURIComponent(pathname.slice(mountPath.length));
  const filePath = resolve(DIST_DIR, relativePath || 'index.html');
  if (
    filePath !== resolve(DIST_DIR, 'index.html') &&
    !filePath.startsWith(`${resolve(DIST_DIR)}${sep}`)
  ) {
    return null;
  }
  return filePath;
}

async function serveDist(
  requestUrl: string | undefined,
  response: ServerResponse
): Promise<void> {
  try {
    const filePath = mountedFilePath(requestUrl);
    if (!filePath) {
      response.writeHead(404).end();
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type':
        CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream'
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Static test server did not bind to a TCP port');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

test('the built entry assets resolve at root and the deployment subpath', async ({
  request
}) => {
  const server = createServer((incoming, response) => {
    void serveDist(incoming.url, response);
  });

  try {
    const origin = await listen(server);

    for (const mountPath of MOUNT_PATHS) {
      const indexUrl = `${origin}${mountPath}`;
      const indexResponse = await request.get(indexUrl);
      expect(indexResponse.status(), `GET ${mountPath}`).toBe(200);
      expect(indexResponse.headers()['content-type']).toContain('text/html');

      const indexHtml = await indexResponse.text();
      const entryHref = indexHtml.match(
        /<script\b(?=[^>]*\btype="module")[^>]*\bsrc="([^"]+)"/i
      )?.[1];
      const stylesheetHrefs = Array.from(
        indexHtml.matchAll(
          /<link\b(?=[^>]*\brel="stylesheet")[^>]*\bhref="([^"]+)"/gi
        ),
        (match) => match[1]
      );

      expect(entryHref).toMatch(/^\.\/assets\/[^/?#]+\.js$/);
      expect(stylesheetHrefs.length).toBeGreaterThan(0);
      for (const stylesheetHref of stylesheetHrefs) {
        expect(stylesheetHref).toMatch(/^\.\/assets\/[^/?#]+\.css$/);
      }

      for (const assetHref of [entryHref!, ...stylesheetHrefs]) {
        const assetUrl = new URL(assetHref, indexUrl);
        expect(assetUrl.pathname).toBe(
          `${mountPath}${assetHref.slice('./'.length)}`
        );

        const assetResponse = await request.get(assetUrl.toString());
        expect(assetResponse.status(), `GET ${assetUrl.pathname}`).toBe(200);
        expect((await assetResponse.body()).byteLength).toBeGreaterThan(0);
      }
    }
  } finally {
    await close(server);
  }
});
