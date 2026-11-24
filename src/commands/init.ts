import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { Client } from "../client.js";
import { confirm, contextOf } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { detectTarget, htmlSnippet, IDENTIFY_SNIPPET, lineDiff, needsYesFirst, patchFile, type ProjectFiles } from "../install.js";
import { color } from "../output.js";
import { browserLogin, saveSignIn } from "./auth.js";

const projectFiles = (root: string): ProjectFiles => ({
  exists: (path) => existsSync(join(root, path)),
  read: (path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  },
});

/**
 * `cueston init`: the terminal route to a working install. Signs in when needed (the browser
 * approval page also creates accounts), takes the workspace's publishable key, adds the snippet
 * to the project's HTML shell after showing the change, and prints the identify() step.
 */
export function registerInit(program: Command) {
  program
    .command("init")
    .description("Set Cueston up in this project: sign in, then add the snippet to your app")
    .option("--dir <path>", "project folder (default: the current folder)", ".")
    .option("--dry-run", "show what would change without writing anything")
    .option("-y, --yes", "don't ask before editing the file")
    .option("--no-browser", "print the sign-in link instead of opening the browser")
    .addHelpText(
      "after",
      `
Examples:
  npx cueston init                 # sign in, find your app's HTML shell, add Cueston
  npx cueston init --dry-run       # only show what it would change
  npx cueston init --dir apps/web  # a project in a monorepo

Supports Next.js (App Router layout, Pages Router _document), Vite and other index.html
projects, and Create React App. Anything else gets the snippet printed to paste in.`
    )
    .action(async (_options, command: Command) => {
      const ctx = contextOf(command);
      const { dir, dryRun, yes, browser } = command.opts();
      const root = resolve(dir);
      if (!existsSync(root)) throw new CliError(`No folder at ${root}.`);

      // Before any sign-in: with no terminal to ask in, editing needs --yes (or --dry-run)
      if (needsYesFirst({ yes, dryRun, interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY) }))
        throw new UsageError(
          "cueston init edits a file in your project, and without a terminal it can't ask first.",
          "Re-run with --yes to let it edit, or --dry-run to only see the change."
        );

      // 1. Signed in? If not, the same browser approval as `cueston login`.
      let client = ctx.client;
      if (!ctx.auth.key) {
        ctx.out.info("First, sign in to Cueston (new here? the page lets you create a free account).");
        const issued = await browserLogin(ctx, browser !== false);
        saveSignIn(ctx, issued);
        client = new Client(ctx.auth.apiUrl, issued.key, (message) => ctx.out.info(message));
        ctx.out.info(`${color.green("✓")} Signed in as ${color.bold(issued.user.email)} to ${color.bold(issued.workspace.name)}.`);
      }

      // 2. The workspace's publishable key (safe in page source; the secret key never goes there).
      const { workspace } = await client.get<{ workspace: { name: string; publicKey: string | null } }>(
        "/api/workspaces/current"
      );
      if (!workspace.publicKey?.startsWith("pk_"))
        throw new CliError("This workspace has no publishable key yet.", "Open Settings → Install once, then run `cueston init` again.");
      const publicKey: string = workspace.publicKey;

      // 3. Where the snippet goes, and the change.
      const files = projectFiles(root);
      const found = detectTarget(files);
      const result = found ? patchFile(found.kind, files.read(found.file) ?? "", publicKey, ctx.auth.apiUrl) : null;

      const next = () =>
        [
          "",
          `${color.bold("Next:")} tell Cueston who's signed in, where your app knows the user:`,
          color.dim(IDENTIFY_SNIPPET.replace(/^/gm, "  ")),
          color.dim("  (Skip this if your site has no signed-in users.)"),
          "",
          `Then build guidance from your AI agent: ${color.cyan("claude mcp add --scope user --transport http cueston https://app.cueston.com/api/mcp")}`,
          `or in the dashboard: ${color.cyan(`${ctx.auth.apiUrl}/dashboard`)}`,
        ].join("\n");

      if (!found || result?.status === "no-anchor") {
        ctx.out.result(
          { workspace: workspace.name, publicKey: publicKey, installed: false, file: found?.file ?? null, snippet: htmlSnippet(publicKey, ctx.auth.apiUrl) },
          () =>
            [
              found
                ? `Found ${found.label} (${found.file}) but no ${result?.status === "no-anchor" ? result.anchor : "place"} to add Cueston to.`
                : "Couldn't find your app's HTML shell (no Next.js layout or index.html here).",
              "Add these two tags to the <head> of every page:",
              "",
              htmlSnippet(publicKey, ctx.auth.apiUrl),
              next(),
            ].join("\n")
        );
        return;
      }

      if (result!.status === "already-installed") {
        ctx.out.result({ workspace: workspace.name, installed: true, file: found.file, changed: false }, () =>
          `${color.green("✓")} Cueston is already in ${found.file}.${next()}`
        );
        return;
      }

      const patched = (result as { text: string }).text;
      if (dryRun) {
        const hunks = lineDiff(files.read(found.file) ?? "", patched);
        ctx.out.result({ workspace: workspace.name, file: found.file, changed: false, dryRun: true, diff: hunks }, () =>
          [
            `Would add Cueston (key ${publicKey}) to ${found.label}: ${color.bold(found.file)}`,
            ...hunks.flatMap((hunk) => [
              "",
              color.cyan(`@@ ${found.file}:${hunk.line}`),
              ...hunk.removed.map((line) => color.red(`- ${line}`)),
              ...hunk.added.map((line) => color.green(`+ ${line}`)),
            ]),
            "",
            color.dim("Nothing written. Run without --dry-run to apply it."),
          ].join("\n")
        );
        return;
      }

      ctx.out.info(`Adding Cueston (workspace ${color.bold(workspace.name)}, key ${publicKey}) to ${found.label}: ${color.bold(found.file)}`);
      if (!(await confirm(`Edit ${found.file}?`, yes))) {
        ctx.out.result({ installed: false, changed: false }, () => "Nothing changed.");
        return;
      }
      writeFileSync(join(root, found.file), patched);
      ctx.out.result({ workspace: workspace.name, publicKey: publicKey, installed: true, file: found.file, changed: true }, () =>
        `${color.green("✓")} Added Cueston to ${found.file}. Start your app and open a page: it shows up as connected in Cueston within a minute.${next()}`
      );
    });
}
