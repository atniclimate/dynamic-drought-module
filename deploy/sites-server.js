/**
 * Sites requires a Worker-shaped entrypoint even for static applications.
 * Keep this adapter body-transparent: the platform asset binding owns every
 * response, including status codes, headers, ranges, and bodies.
 */
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      url.pathname === '/'
    ) {
      url.pathname = '/index.html';
      return env.ASSETS.fetch(new Request(url, request));
    }
    return env.ASSETS.fetch(request);
  },
};
