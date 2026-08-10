import { expect, test } from '@playwright/test';

import { isHistoricalGroundProbeResponse } from '../src/map/historical-ground';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const JPEG_SIGNATURE_BYTES = new Uint8Array(64);
JPEG_SIGNATURE_BYTES.set([0xff, 0xd8, 0xff]);

test('historical ground accepts supported image headers with matching bytes', async () => {
  await expect(
    isHistoricalGroundProbeResponse(
      new Response(PNG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png' }
      })
    )
  ).resolves.toBe(true);

  await expect(
    isHistoricalGroundProbeResponse(
      new Response(JPEG_SIGNATURE_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' }
      })
    )
  ).resolves.toBe(true);
});

for (const [name, response] of [
  [
    'HTTP failure',
    new Response('unavailable', {
      status: 503,
      headers: { 'content-type': 'image/jpeg' }
    })
  ],
  [
    'HTML',
    new Response('<html>not an image</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    })
  ],
  [
    'empty JPEG',
    new Response(new Uint8Array(), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' }
    })
  ],
  [
    'mislabeled JPEG',
    new Response('<html>not an image</html>', {
      status: 200,
      headers: { 'content-type': 'image/jpeg' }
    })
  ],
  [
    'truncated JPEG',
    new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' }
    })
  ]
] as const) {
  test(`historical ground rejects ${name}`, async () => {
    await expect(isHistoricalGroundProbeResponse(response)).resolves.toBe(false);
  });
}
