import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../scripts/verify-live.mjs', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('async function get('), source.indexOf('\nfunction cacheHeaders('));
const get = runInNewContext(`(${helper})`, {
  fetch, AbortSignal, AbortController, setTimeout, clearTimeout, FETCH_TIMEOUT_MS: 500,
});

for (const method of ['text', 'arrayBuffer']) {
  test(`live verifier bounds a stalled ${method} body after headers arrive`, async (t) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.write('partial');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const response = await get(`http://127.0.0.1:${server.address().port}/`, {
      signal: new AbortController().signal,
    });
    // A broken deadline must fail the test instead of leaving its socket open.
    const watchdog = setTimeout(() => server.closeAllConnections(), 2000);
    try {
      assert.equal(response.status, 200);
      await assert.rejects(response[method](), (error) => ['AbortError', 'TimeoutError'].includes(error.name));
    } finally {
      clearTimeout(watchdog);
    }
  });
}

test('live verifier keeps HEAD options and permits a complete response', async (t) => {
  const server = createServer((request, response) => {
    assert.equal(request.method, 'HEAD');
    assert.equal(request.headers['x-probe'], 'live');
    response.writeHead(200, { 'Content-Length': '7' });
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const response = await get(`http://127.0.0.1:${server.address().port}/`, {
    method: 'HEAD', headers: { 'X-Probe': 'live' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '7');
  assert.equal(await response.text(), '');
});
