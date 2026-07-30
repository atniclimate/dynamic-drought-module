/**
 * Sites requires a Worker-shaped entrypoint even for static applications.
 * Keep this adapter body-transparent: the platform asset binding owns every
 * response, including status codes, headers, ranges, and bodies.
 */
export default {
  fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
