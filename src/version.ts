declare const __CUESTON_VERSION__: string | undefined;

/** The package version, set at build time (tsup `define`); "dev" when running from source. */
export const VERSION: string =
  typeof __CUESTON_VERSION__ === "string" ? __CUESTON_VERSION__ : "0.0.0-dev";
