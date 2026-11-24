// Bundle src/cli.ts into one self-contained dist/cli.js: every dependency is inlined, so
// `npx cueston` installs nothing else.
import { readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
rmSync(`${root}dist`, { recursive: true, force: true });

await build({
  entryPoints: [`${root}src/cli.ts`],
  outfile: `${root}dist/cli.js`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  // Bundled CommonJS dependencies (commander) call require() for Node built-ins.
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __cuestonCreateRequire } from "node:module";\nconst require = __cuestonCreateRequire(import.meta.url);',
  },
  define: { __CUESTON_VERSION__: JSON.stringify(version) },
  logLevel: "info",
});
