import { expect, test } from '@playwright/test';
import sitesServer from '../deploy/sites-server.js';

test('Sites adapter passes the request directly to the static asset binding', async () => {
  const request = new Request('https://example.test/assets/map.js');
  const expected = new Response('static bytes', {
    status: 206,
    headers: {
      'content-range': 'bytes 0-11/12',
      'x-static-host': 'sites',
    },
  });
  let received: Request | undefined;

  const response = await sitesServer.fetch(request, {
    ASSETS: {
      fetch(candidate: Request) {
        received = candidate;
        return Promise.resolve(expected);
      },
    },
  });

  expect(received).toBe(request);
  expect(response).toBe(expected);
  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toBe('bytes 0-11/12');
});

test('Sites adapter maps a root state URL to the static index', async () => {
  const request = new Request('https://example.test/?embed=true&layer=heat');
  let received: Request | undefined;

  const response = await sitesServer.fetch(request, {
    ASSETS: {
      fetch(candidate: Request) {
        received = candidate;
        return Promise.resolve(new Response('index'));
      },
    },
  });

  expect(received?.url).toBe(
    'https://example.test/index.html?embed=true&layer=heat',
  );
  expect(await response.text()).toBe('index');
});
