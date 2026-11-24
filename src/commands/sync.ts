import { Option, type Command } from "commander";
import { CONTENT_TYPES, typeOf, type ContentTypeDef } from "../content-types.js";
import { contextOf, plural } from "../context.js";
import { color } from "../output.js";
import { pull, push, type PlanEntry } from "../sync.js";

function typesFrom(value: string | undefined): readonly ContentTypeDef[] {
  if (!value) return CONTENT_TYPES;
  return value.split(",").map((part) => typeOf(part));
}

const SYMBOL: Record<PlanEntry["action"], string> = {
  create: "+",
  update: "~",
  unchanged: "=",
  missing: "!",
};

function describePlan(entries: PlanEntry[], verbose: boolean): string {
  const shown = entries.filter((entry) => verbose || entry.action !== "unchanged");
  const lines = shown.map((entry) => {
    const what = `${entry.action.padEnd(9)} ${entry.file}`;
    const detail =
      entry.action === "update"
        ? color.dim(` (${entry.fields.join(", ")})`)
        : entry.action === "create" && entry.name
          ? color.dim(` "${entry.name}"`)
          : entry.action === "missing"
            ? color.dim(" (not on the server)")
            : "";
    const paint =
      entry.action === "create"
        ? color.green
        : entry.action === "update"
          ? color.yellow
          : entry.action === "missing"
            ? color.red
            : color.dim;
    return `${paint(SYMBOL[entry.action])} ${what}${detail}`;
  });
  const count = (action: PlanEntry["action"]) =>
    entries.filter((entry) => entry.action === action).length;
  lines.push(
    color.dim(
      `${count("create")} to create, ${count("update")} to update, ${count("unchanged")} unchanged` +
        (count("missing") ? `, ${count("missing")} missing on the server` : "")
    )
  );
  return lines.join("\n");
}

export function registerSync(program: Command) {
  program
    .command("pull [dir]")
    .description("Download guidance drafts as JSON files: <dir>/<type>/<id>-<name>.json")
    .option("-t, --type <types>", "only these types, e.g. tours,banners")
    .option("--prune", "delete local files whose item no longer exists")
    .addHelpText(
      "after",
      `
Files hold the editable draft fields (no ids or timestamps besides "id"), with keys in a stable
order, so they diff cleanly in git. Edit them, then \`cueston push\`.

Examples:
  cueston pull                     # into ./cueston
  cueston pull content --type tours,tooltips`
    )
    .action(async (dir: string | undefined, options, command: Command) => {
      const ctx = contextOf(command);
      const folder = dir ?? "cueston";
      const result = await pull(ctx.client, folder, typesFrom(options.type), {
        prune: options.prune,
        onItem: (line) => ctx.out.info(color.dim(`  ${line}`)),
      });
      ctx.out.result(
        result,
        () =>
          `${color.green("✓")} Pulled ${plural(result.written.length, "item")} into ${folder}/.` +
          (result.pruned.length ? ` Removed ${plural(result.pruned.length, "file")}.` : "")
      );
    });

  program
    .command("push [dir]")
    .description("Create and update drafts from local files (prints the plan first)")
    .option("-t, --type <types>", "only these types, e.g. tours,banners")
    .option("--dry-run", "only print the plan")
    .option("--publish", "publish every created or updated item afterwards")
    .addOption(
      new Option("--env <environment>", "where --publish publishes")
        .choices(["production", "staging"])
        .default("production")
    )
    .option("-v, --verbose", "also list unchanged files")
    .addHelpText(
      "after",
      `
A file without "id" creates a new draft (its id is written back into the file); a file with an
id updates that item's draft, sending only the fields that differ. Fields a file leaves out stay
as they are. After saving, push writes back what the server stored, so a second push changes
nothing. Exit code 1 if anything failed.

Examples:
  cueston push --dry-run
  cueston push --publish --env staging
  CUESTON_API_KEY=sk_… npx cueston push content --publish   # in CI`
    )
    .action(async (dir: string | undefined, options, command: Command) => {
      const ctx = contextOf(command);
      const folder = dir ?? "cueston";
      const outcome = await push(ctx.client, folder, typesFrom(options.type), {
        dryRun: options.dryRun,
        publish: options.publish,
        environment: options.env,
        onPlan: (entries) => {
          if (!ctx.out.jsonMode)
            process.stderr.write(`${describePlan(entries, Boolean(options.verbose))}\n`);
        },
        onProgress: (line) => ctx.out.info(`${color.green("✓")} ${line}`),
      });
      for (const error of outcome.errors) ctx.out.warn(`${error.file}: ${error.message}`);
      ctx.out.result(outcome, () => {
        if (options.dryRun) return color.dim("Dry run: nothing was changed.");
        const changed = outcome.applied.length;
        return changed === 0 && outcome.errors.length === 0
          ? "Everything is up to date."
          : `${changed ? `${color.green("✓")} Saved ${plural(changed, "draft")}` : "No drafts saved"}` +
              (outcome.published.length
                ? `, published ${outcome.published.length} to ${options.env}`
                : "") +
              (outcome.errors.length
                ? `, ${color.red(plural(outcome.errors.length, "error"))}`
                : "") +
              ".";
      });
      if (outcome.errors.length) process.exitCode = 1;
    });
}
