import { Option, type Command } from "commander";
import { CONTENT_TYPES, parseId, statusOf, type ContentTypeDef } from "../content-types.js";
import { confirm, contextOf, plural } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { bodyFrom } from "../input.js";
import { ago, color, table, yaml } from "../output.js";

const envOption = () =>
  new Option("--env <environment>", "production or staging")
    .choices(["production", "staging"])
    .default("production");

/** "live", "live · edited" (draft has changes not yet published), "staging", "draft". */
export function statusLabel(item: any): string {
  const status = statusOf(item.publication);
  const changes = item.hasUnpublishedChanges;
  const edited =
    status !== "draft" &&
    (changes === true ||
      (changes && typeof changes === "object" && (changes.production || changes.staging)));
  return edited ? `${status} · edited` : status;
}

const versionNumber = (version: any) =>
  typeof version === "object" && version ? (version.version ?? null) : (version ?? null);

/** Strip isActive: the CLI creates and edits drafts; going live is `publish`. */
function draftBody(body: Record<string, unknown>, warn: (message: string) => void) {
  if ("isActive" in body) {
    warn("Ignored isActive: changes are saved as drafts. Use `publish` to go live.");
    delete body.isActive;
  }
  return body;
}

function contentFields(options: { name?: string; urlPattern?: string }) {
  return { name: options.name, urlPattern: options.urlPattern };
}

const INPUT_HELP = (def: ContentTypeDef) => `
Input: --file ${def.type}.json|.yaml (or - for stdin), --data '<json>' (or @file), and field
flags (--name, --url-pattern), which win over the file. Run \`cueston ${def.plural} get <id> --json\`
to see every field, or \`cueston tools list\` for the schema (create_${def.type}).`;

export function registerContent(program: Command) {
  for (const def of CONTENT_TYPES) {
    const group = program
      .command(def.plural)
      .alias(def.type)
      .description(`List, create, edit, publish and roll back ${def.plural}`);

    group
      .command("list")
      .alias("ls")
      .description(`List ${def.plural} with their publish status`)
      .addOption(
        new Option("--status <status>", "only live, staging or draft items").choices([
          "live",
          "staging",
          "draft",
        ])
      )
      .action(async (options, command: Command) => {
        const ctx = contextOf(command);
        const body = await ctx.client.get(`/api/${def.plural}`);
        let items: any[] = body[def.plural] ?? [];
        if (options.status)
          items = items.filter((item) => statusOf(item.publication) === options.status);
        ctx.out.result(items, () =>
          items.length === 0
            ? `No ${def.plural} yet. Create one with \`cueston ${def.plural} create --file ${def.type}.json\`.`
            : table(items, [
                { header: "id", value: (item) => item.id },
                { header: "name", value: (item) => item.name, max: 40 },
                { header: "status", value: statusLabel },
                { header: "url pattern", value: (item) => item.urlPattern, max: 40 },
                { header: "updated", value: (item) => ago(item.updatedAt) },
              ])
        );
      });

    group
      .command("get <id>")
      .description(`Show one ${def.type}: every field, its steps or items, and publish status`)
      .action(async (id: string, _options, command: Command) => {
        const ctx = contextOf(command);
        const item = (await ctx.client.get(`/api/${def.plural}/${parseId(id)}`))[def.type];
        ctx.out.result(
          item,
          () => `${color.dim(`# ${def.type} ${item.id} · ${statusLabel(item)}`)}\n${yaml(item)}`
        );
      });

    group
      .command("create")
      .description(`Create a ${def.type} as a draft`)
      .option("-f, --file <path>", "JSON or YAML file with the fields (- for stdin)")
      .option("-d, --data <json>", "the fields as JSON (or @file)")
      .option("--name <name>", "name")
      .option("--url-pattern <pattern>", 'pages it shows on, e.g. "https://app.acme.com/billing*"')
      .addHelpText("after", INPUT_HELP(def))
      .action(async (options, command: Command) => {
        const ctx = contextOf(command);
        const body = draftBody(await bodyFrom(options, contentFields(options)), ctx.out.warn);
        if (Object.keys(body).length === 0)
          throw new UsageError("Nothing to create.", "Pass --file, --data or --name.");
        const item = (await ctx.client.post(`/api/${def.plural}`, { ...body, isActive: false }))[
          def.type
        ];
        ctx.out.result(
          item,
          () =>
            `${color.green("✓")} Created ${def.type} ${color.bold(String(item.id))} "${item.name}" (draft).`
        );
      });

    group
      .command("update <id>")
      .alias("edit")
      .description(`Change fields of a ${def.type}'s draft (fields you leave out stay as they are)`)
      .option("-f, --file <path>", "JSON or YAML file with the fields to change (- for stdin)")
      .option("-d, --data <json>", "the fields as JSON (or @file)")
      .option("--name <name>", "name")
      .option("--url-pattern <pattern>", "pages it shows on")
      .addHelpText("after", INPUT_HELP(def))
      .action(async (id: string, options, command: Command) => {
        const ctx = contextOf(command);
        const body = draftBody(await bodyFrom(options, contentFields(options)), ctx.out.warn);
        delete body.id;
        if (Object.keys(body).length === 0)
          throw new UsageError(
            "Nothing to change.",
            "Pass --file, --data, --name or --url-pattern."
          );
        const item = (await ctx.client.patch(`/api/${def.plural}/${parseId(id)}`, body))[def.type];
        const live = statusOf(item.publication) !== "draft";
        ctx.out.result(
          item,
          () =>
            `${color.green("✓")} Saved ${def.type} ${item.id} draft (${Object.keys(body).join(", ")}).` +
            (live
              ? color.dim(
                  `\n  People see the published version until you run \`cueston ${def.plural} publish ${item.id}\`.`
                )
              : "")
        );
      });

    group
      .command("delete <id>")
      .alias("rm")
      .description(`Delete a ${def.type} with its versions and translations (can't be undone)`)
      .option("-y, --yes", "don't ask for confirmation")
      .action(async (id: string, options, command: Command) => {
        const ctx = contextOf(command);
        const itemId = parseId(id);
        const item = (await ctx.client.get(`/api/${def.plural}/${itemId}`))[def.type];
        if (
          !(await confirm(
            `Delete ${def.type} ${itemId} "${item.name}"? This can't be undone.`,
            options.yes
          ))
        )
          throw new CliError("Canceled.");
        await ctx.client.delete(`/api/${def.plural}/${itemId}`);
        ctx.out.result(
          { type: def.type, id: itemId, deleted: true },
          () => `${color.green("✓")} Deleted ${def.type} ${itemId}.`
        );
      });

    group
      .command("duplicate <id>")
      .alias("copy")
      .description(`Copy a ${def.type} as a new draft ("Copy of …")`)
      .action(async (id: string, _options, command: Command) => {
        const ctx = contextOf(command);
        const item = (await ctx.client.post(`/api/${def.plural}/${parseId(id)}/duplicate`, {}))[
          def.type
        ];
        ctx.out.result(
          item,
          () =>
            `${color.green("✓")} Created ${def.type} ${color.bold(String(item.id))} "${item.name}" (draft).`
        );
      });

    group
      .command("publish <id>")
      .description(`Publish the ${def.type}'s current draft as a new version`)
      .addOption(envOption())
      .option("--note <text>", 'what changed, for the version history ("New export step")')
      .action(async (id: string, options, command: Command) => {
        const ctx = contextOf(command);
        const itemId = parseId(id);
        const result = await ctx.client.post(`/api/${def.plural}/${itemId}/publish`, {
          environment: options.env,
          ...(options.note ? { note: options.note } : {}),
        });
        const version = versionNumber(result.version);
        ctx.out.result(
          { type: def.type, id: itemId, environment: options.env, ...result },
          () =>
            `${color.green("✓")} Published ${def.type} ${itemId} to ${options.env}${version ? ` (version ${version})` : ""}.` +
            (result.versionCreated === false
              ? color.dim("\n  Nothing changed since the last version; it was reused.")
              : "")
        );
      });

    group
      .command("unpublish <id>")
      .description(`Stop showing the ${def.type} (the draft and versions stay)`)
      .addOption(envOption())
      .action(async (id: string, options, command: Command) => {
        const ctx = contextOf(command);
        const itemId = parseId(id);
        const result = await ctx.client.post(`/api/${def.plural}/${itemId}/unpublish`, {
          environment: options.env,
        });
        ctx.out.result(
          { type: def.type, id: itemId, environment: options.env, ...result },
          () => `${color.green("✓")} Unpublished ${def.type} ${itemId} from ${options.env}.`
        );
      });

    group
      .command("versions <id>")
      .description(`Version history of a ${def.type}`)
      .action(async (id: string, _options, command: Command) => {
        const ctx = contextOf(command);
        const body = await ctx.client.get(`/api/${def.plural}/${parseId(id)}/versions`);
        const versions: any[] = body.versions ?? [];
        ctx.out.result(body, () =>
          versions.length === 0
            ? "Never published."
            : table(versions, [
                { header: "version", value: (v) => v.version },
                { header: "id", value: (v) => v.id },
                {
                  header: "live in",
                  value: (v) =>
                    Array.isArray(v.environments) ? v.environments.join(", ") : v.environments,
                },
                { header: "note", value: (v) => v.note, max: 40 },
                {
                  header: "by",
                  value: (v) => v.createdBy?.name ?? v.createdBy?.email ?? v.createdBy,
                },
                { header: "created", value: (v) => ago(v.createdAt) },
              ])
        );
      });

    group
      .command("rollback <id> <versionId>")
      .description("Make an earlier version live again (the draft isn't touched)")
      .addOption(envOption())
      .action(async (id: string, versionId: string, options, command: Command) => {
        const ctx = contextOf(command);
        const itemId = parseId(id);
        const result = await ctx.client.post(
          `/api/${def.plural}/${itemId}/versions/${parseId(versionId, "version id")}/publish`,
          { environment: options.env }
        );
        const version = versionNumber(result.version);
        ctx.out.result(
          { type: def.type, id: itemId, environment: options.env, ...result },
          () =>
            `${color.green("✓")} ${def.type} ${itemId} now serves version ${version ?? versionId} in ${options.env}.`
        );
      });

    group
      .command("restore <id> <versionId>")
      .description("Copy an earlier version into the draft (publishes nothing)")
      .action(async (id: string, versionId: string, _options, command: Command) => {
        const ctx = contextOf(command);
        const itemId = parseId(id);
        const result = await ctx.client.post(
          `/api/${def.plural}/${itemId}/versions/${parseId(versionId, "version id")}/restore`,
          {}
        );
        ctx.out.result(
          result,
          () =>
            `${color.green("✓")} Restored version ${result.restoredFrom?.version ?? versionId} into the draft of ${def.type} ${itemId}.`
        );
      });

    group
      .command("request-review <id>")
      .description("Ask a publisher to review and publish the current draft")
      .option("--note <text>", "what changed and why, for the reviewer")
      .option("--version <versionId>", "ask to publish this existing version instead (a rollback)")
      .action(async (id: string, options, command: Command) => {
        const ctx = contextOf(command);
        const itemId = parseId(id);
        const result = await ctx.client.post(`/api/${def.plural}/${itemId}/publish-requests`, {
          ...(options.note ? { note: options.note } : {}),
          ...(options.version ? { versionId: parseId(options.version, "version id") } : {}),
        });
        ctx.out.result(
          result,
          () =>
            `${color.green("✓")} Review requested (request ${result.request?.id}). Publishers see it in Approvals.`
        );
      });

    if (def.type === "survey") registerSurveyExtras(group);
  }
}

function registerSurveyExtras(group: Command) {
  group
    .command("results <id>")
    .description("Responses, response rate, NPS and per-question answers")
    .addOption(new Option("--days <n>", "7, 30 or 90").choices(["7", "30", "90"]).default("30"))
    .addOption(envOption())
    .action(async (id: string, options, command: Command) => {
      const ctx = contextOf(command);
      const { summary, survey } = await ctx.client.get(
        `/api/surveys/${parseId(id)}/responses/summary`,
        {
          days: options.days,
          environment: options.env,
        }
      );
      ctx.out.result({ survey, summary }, () => {
        const totals = summary.totals ?? {};
        const lines = [
          `${color.bold(survey.name)} · last ${options.days} days · ${options.env}`,
          `${plural(totals.responses ?? 0, "response")} (${totals.completed ?? 0} completed) from ${plural(totals.viewers ?? 0, "viewer")}` +
            (typeof totals.responseRate === "number"
              ? ` · ${Math.round(totals.responseRate * 100)}% response rate`
              : ""),
        ];
        if (summary.nps)
          lines.push(
            `NPS ${summary.nps.score} (${summary.nps.promoters} promoters, ${summary.nps.passives} passives, ${summary.nps.detractors} detractors)`
          );
        for (const question of summary.questions ?? [])
          lines.push("", color.dim(`# ${question.prompt ?? question.id}`), yaml(question));
        return lines.join("\n");
      });
    });

  group
    .command("export <id>")
    .description("Every response as CSV (to stdout, or --output)")
    .addOption(new Option("--days <n>", "7, 30 or 90").choices(["7", "30", "90"]).default("30"))
    .option("-o, --output <file>", "write to a file")
    .action(async (id: string, options, command: Command) => {
      const ctx = contextOf(command);
      const csv = await ctx.client.request<string>(
        "GET",
        `/api/surveys/${parseId(id)}/responses/export`,
        {
          query: { days: options.days },
          text: true,
        }
      );
      await writeOutput(csv, options.output, ctx.out.info);
    });
}

export async function writeOutput(
  text: string,
  file: string | undefined,
  info: (message: string) => void
) {
  if (!file) {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, text);
  info(`${color.green("✓")} Wrote ${file}.`);
}
