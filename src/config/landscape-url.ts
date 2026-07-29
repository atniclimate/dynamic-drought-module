/**
 * The one bundled landscape-signature asset URL.
 *
 * `import.meta.env` is optional here so pure Node tests can import the lazy
 * consumer while injecting their own transport. Vite supplies BASE_URL in the
 * application build.
 */

const viteEnv = (
  import.meta as ImportMeta & {
    readonly env?: {
      readonly BASE_URL?: string;
    };
  }
).env;

export const LANDSCAPE_SIGNATURE_LOCAL_URL =
  `${viteEnv?.BASE_URL ?? '/'}data/landscape-signature-pnw.json`;
