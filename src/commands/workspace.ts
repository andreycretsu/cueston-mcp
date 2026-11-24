/** Segments, review requests, analytics, translations, preview links and webhooks. */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { Option, type Command } from "commander";
import { parseId, typeOf } from "../content-types.js";
import { confirm, contextOf } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { asObject, bodyFrom, readDocument } from "../input.js";
import { ago, color, table, yaml } from "../output.js";
import { writeOutput } from "./content.js";

const daysOption = () =>
  new Option("--days <n>", "7, 30 or 90").choices(["7", "30", "90"]).default("30");

const pct = (rate: unknown) =>
  typeof rate === "number" ? `${Math.round(rate * (rate <= 1 ? 100 : 1))}%` : "—";

export function registerSegments(program: Command) {
  const group = program
    .command("segments")
    .alias("segment")
    .description("Saved audiences that any guidance can target");

  group
    .command("list")
    .alias("ls")
    .description("List saved audiences and where they're used")
    .action(async (_options, command: Command) => {
      const ctx = contextOf(command);
      const { segments } = await ctx.client.get("/api/segments");
      ctx.out.result(segments, () =>
        segments.length === 0
          ? "No saved audiences yet."
          : table(segments as any[], [
              { header: "id", value: (s) => s.id },
              { header: "name", value: (s) => s.name, max: 40 },
              { header: "rules", value: (s) => s.rules?.rules?.length ?? 0 },
              { header: "used by", value: (s) => s.usage?.length ?? 0 },
              { header: "updated", value: (s) => ago(s.updatedAt) },
            ])
      );
    });

  group
    .command("get <id>")
    .description("Show a saved audience with its rules")
    .action(async (id: string, _options, command: Command) => {
      const ctx = contextOf(command);
      const { segment } = await ctx.client.get(`/api/segments/${parseId(id)}`);
      ctx.out.result(segment, () => yaml(segment));
    });

  const fields = (cmd: Command) =>
    cmd
      .option("-f, --file <path>", "JSON or YAML with name, description and rules (- for stdin)")
      .option("-d, --data <json>", "the fields as JSON (or @file)")
      .option("--name <name>", "name")
      .option("--description <text>", "what the audience is");

  fields(group.command("create").description("Save a new audience"))
    .addHelpText(
      "after",
      `
Example rules file (segment.yaml):
  name: Admins on Pro
  rules:
    matchType: all
    rules:
      - { type: role, operator: equals, value: admin }
      - { type: plan, operator: equals, value: pro }`
    )
    .action(async (options, command: Command) => {
      const ctx = contextOf(command);
      const body = await bodyFrom(options, {
        name: options.name,
        description: options.description,
      });
      const { segment } = await ctx.client.post("/api/segments", body);
      ctx.out.result(
        segment,
        () =>
          `${color.green("✓")} Saved audience ${color.bold(String(segment.id))} "${segment.name}".`
      );
    });

  fields(
    group.command("update <id>").description("Rename, describe or replace the rules of an audience")
  ).action(async (id: string, options, command: Command) => {
    const ctx = contextOf(command);
    const body = await bodyFrom(options, { name: options.name, description: options.description });
    if (Object.keys(body).length === 0) throw new UsageError("Nothing to change.");
    const { segment } = await ctx.client.patch(`/api/segments/${parseId(id)}`, body);
    ctx.out.result(
      segment,
      () =>
        `${color.green("✓")} Updated audience ${segment.id}.` +
        (body.rules
          ? color.dim(
              "\n  Rules apply right away to every item that targets it (segments aren't versioned)."
            )
          : "")
    );
  });

  group
    .command("delete <id>")
    .alias("rm")
    .description("Delete an audience (refused while guidance uses it, unless --force)")
    .option("--force", "delete even if guidance or other audiences use it")
    .option("-y, --yes", "don't ask for confirmation")
    .action(async (id: string, options, command: Command) => {
      const ctx = contextOf(command);
      const segmentId = parseId(id);
      if (!(await confirm(`Delete audience ${segmentId}?`, options.yes)))
        throw new CliError("Canceled.");
      await ctx.client.delete(
        `/api/segments/${segmentId}`,
        options.force ? { force: true } : undefined
      );
      ctx.out.result(
        { id: segmentId, deleted: true },
        () => `${color.green("✓")} Deleted audience ${segmentId}.`
      );
    });

  group
    .command("estimate [id]")
    .description("How many recently active users match a saved audience, or rules from --file")
    .option("-f, --file <path>", "rules ({ matchType, rules }) as JSON or YAML")
    .action(async (id: string | undefined, options, command: Command) => {
      const ctx = contextOf(command);
      if (!id && !options.file) throw new UsageError("Pass a segment id or --file with rules.");
      let estimate: any;
      if (id) ({ estimate } = await ctx.client.get(`/api/segments/${parseId(id)}/estimate`));
      else {
        // The file is either the rules ({ matchType, rules }) or a segment ({ name, rules: { … } }).
        const doc = asObject(await readDocument(options.file), options.file);
        const rules = "matchType" in doc ? doc : doc.rules;
        ({ estimate } = await ctx.client.post("/api/segments/estimate", { rules }));
      }
      ctx.out.result(
        estimate,
        () =>
          `${estimate.upperBound ? "Up to " : "About "}${color.bold(String(estimate.count))} of ${estimate.activeUsers} users active in the last ${estimate.days} days.` +
          (estimate.note ? color.dim(`\n  ${estimate.note}`) : "")
      );
    });
}

export function registerReviews(program: Command) {
  const group = program
    .command("reviews")
    .alias("review")
    .description("Publish requests waiting for review (approvals)");

  group
    .command("list")
    .alias("ls")
    .description("List review requests (pending by default)")
    .addOption(
      new Option("--status <status>", "which requests")
        .choices(["pending", "approved", "rejected", "canceled", "all"])
        .default("pending")
    )
    .action(async (options, command: Command) => {
      const ctx = contextOf(command);
      const { requests } = await ctx.client.get("/api/publish-requests", {
        status: options.status,
      });
      ctx.out.result(requests, () =>
        requests.length === 0
          ? `No ${options.status === "all" ? "" : `${options.status} `}review requests.`
          : table(requests as any[], [
              { header: "id", value: (r) => r.id },
              {
                header: "item",
                value: (r) => `${r.contentType} ${r.contentId} "${r.contentName}"`,
                max: 50,
              },
              { header: "version", value: (r) => r.version },
              { header: "status", value: (r) => r.status },
              {
                header: "requested by",
                value: (r) => r.requestedBy?.name ?? r.requestedBy?.email ?? r.requestedBy,
              },
              { header: "note", value: (r) => r.note, max: 40 },
              { header: "created", value: (r) => ago(r.createdAt) },
            ])
      );
    });

  group
    .command("approve <id>")
    .description("Approve a request: the requested version goes live in production")
    .option("--note <text>", "a note for the requester")
    .action(async (id: string, options, command: Command) => {
      const ctx = contextOf(command);
      const result = await ctx.client.post(
        `/api/publish-requests/${parseId(id)}/approve`,
        options.note ? { note: options.note } : {}
      );
      ctx.out.result(
        result,
        () =>
          `${color.green("✓")} Approved. ${result.request?.contentType} ${result.request?.contentId} is live (version ${result.request?.version}).`
      );
    });

  group
    .command("reject <id>")
    .description("Reject a request with a note saying what to change")
    .requiredOption("--note <text>", "what to change (emailed to the requester)")
    .action(async (id: string, options, command: Command) => {
      const ctx = contextOf(command);
      const result = await ctx.client.post(`/api/publish-requests/${parseId(id)}/reject`, {
        note: options.note,
      });
      ctx.out.result(
        result,
        () => `${color.green("✓")} Rejected request ${id}. The requester gets your note by email.`
      );
    });

  group
    .command("cancel <id>")
    .description("Withdraw your own pending request")
    .action(async (id: string, _options, command: Command) => {
      const ctx = contextOf(command);
      const result = await ctx.client.post(`/api/publish-requests/${parseId(id)}/cancel`, {});
      ctx.out.result(result, () => `${color.green("✓")} Canceled request ${id}.`);
    });
}

export function registerAnalytics(program: Command) {
  const group = program
    .command("analytics")
    .description("Impressions, completions, funnels and broken targets");

  group
    .command("overview", { isDefault: true })
    .description("Workspace totals and the top guidance (default)")
    .addOption(daysOption())
    .action(async (options, command: Command) => {
      const ctx = contextOf(command);
      const body = await ctx.client.get("/api/analytics/overview", { days: options.days });
      ctx.out.result(body, () => {
        const t = body.totals ?? {};
        const lines = [
          `${color.bold(`Last ${options.days} days`)}: ${t.impressions ?? 0} impressions · ${t.uniqueVisitors ?? 0} visitors · ${t.completions ?? 0} completions · ${t.dismissals ?? 0} dismissals` +
            (t.targetMissing ? ` · ${color.yellow(`${t.targetMissing} missing targets`)}` : ""),
        ];
        if (body.top?.length)
          lines.push(
            "",
            table(body.top as any[], [
              { header: "type", value: (r) => r.contentType },
              { header: "id", value: (r) => r.contentId },
              { header: "name", value: (r) => r.name, max: 40 },
              { header: "impressions", value: (r) => r.impressions },
              { header: "completions", value: (r) => r.completions },
              { header: "rate", value: (r) => pct(r.completionRate) },
            ])
          );
        if (body.install && !body.install.lastSeenAt)
          lines.push(
            "",
            color.yellow(
              "The Cueston snippet hasn't been seen on your site yet: nothing will show until it's installed."
            )
          );
        return lines.join("\n");
      });
    });

  group
    .command("item <type> <id>")
    .description("One item's totals, and its step funnel (tours) or item completions (checklists)")
    .addOption(daysOption())
    .action(async (type: string, id: string, options, command: Command) => {
      const ctx = contextOf(command);
      const def = typeOf(type);
      const body = await ctx.client.get(`/api/analytics/content/${def.type}/${parseId(id)}`, {
        days: options.days,
      });
      ctx.out.result(body, () => {
        const t = body.totals ?? {};
        const lines = [
          `${color.bold(body.content?.name ?? `${def.type} ${id}`)} · last ${options.days} days`,
          `${t.impressions ?? 0} impressions · ${t.uniqueVisitors ?? 0} visitors · ${t.completions ?? 0} completions · ${t.dismissals ?? 0} dismissals` +
            (t.targetMissing ? ` · ${color.yellow(`${t.targetMissing} missing targets`)}` : ""),
        ];
        if (body.funnel?.length)
          lines.push(
            "",
            table(body.funnel as any[], [
              { header: "step", value: (s) => s.stepIndex + 1 },
              { header: "title", value: (s) => s.title, max: 40 },
              { header: "views", value: (s) => s.views },
              { header: "drop-off", value: (s) => pct(s.dropOffRate) },
            ])
          );
        if (body.checklist?.items?.length)
          lines.push(
            "",
            table(body.checklist.items as any[], [
              { header: "item", value: (s) => s.title, max: 40 },
              { header: "completions", value: (s) => s.completions },
              { header: "rate", value: (s) => pct(s.completionRate) },
            ])
          );
        return lines.join("\n");
      });
    });

  group
    .command("issues")
    .description("Tooltips and tour steps whose target element was missing (broken selectors)")
    .addOption(daysOption())
    .action(async (options, command: Command) => {
      const ctx = contextOf(command);
      const body = await ctx.client.get("/api/analytics/health", { days: options.days });
      const items: any[] = body.items ?? [];
      ctx.out.result(body, () =>
        items.length === 0
          ? `${color.green("✓")} No missing targets in the last ${options.days} days.`
          : table(items, [
              { header: "type", value: (r) => r.contentType },
              { header: "id", value: (r) => r.contentId },
              { header: "name", value: (r) => r.name, max: 30 },
              {
                header: "step",
                value: (r) =>
                  r.stepIndex === null || r.stepIndex === undefined ? "—" : r.stepIndex + 1,
              },
              { header: "selector", value: (r) => r.selector, max: 40 },
              { header: "visitors", value: (r) => r.affectedVisitors },
              { header: "last seen", value: (r) => ago(r.lastSeenAt) },
            ])
      );
    });

  group
    .command("export <dataset>")
    .description("Raw analytics as CSV: events, content or steps (needs analytics.export)")
    .addOption(daysOption())
    .option("-o, --output <file>", "write to a file")
    .action(async (dataset: string, options, command: Command) => {
      const ctx = contextOf(command);
      if (!["events", "content", "steps"].includes(dataset))
        throw new UsageError("Dataset must be events, content or steps.");
      const csv = await ctx.client.request<string>("GET", "/api/analytics/export", {
        query: { dataset, days: options.days },
        text: true,
      });
      await writeOutput(csv, options.output, ctx.out.info);
    });
}

export function registerTranslations(program: Command) {
  const group = program
    .command("translations")
    .alias("translation")
    .description("Export, import and machine-translate guidance text");

  group
    .command("export")
    .description("Every translatable string as CSV or XLIFF (for a translator or a TMS)")
    .addOption(
      new Option("--format <format>", "csv or xliff").choices(["csv", "xliff"]).default("csv")
    )
    .option("--languages <codes>", "languages to include, e.g. de,fr")
    .option("--source <code>", "source language", "en")
    .option("-o, --output <file>", "write to a file")
    .action(async (options, command: Command) => {
      const ctx = contextOf(command);
      const text = await ctx.client.request<string>("GET", "/api/translations/export", {
        query: {
          format: options.format,
          languages: options.languages,
          sourceLanguage: options.source,
        },
        text: true,
      });
      await writeOutput(text, options.output, ctx.out.info);
    });

  group
    .command("import <file>")
    .description(
      "Import a filled-in CSV or XLIFF file (shows what would change; --apply writes it)"
    )
    .addOption(
      new Option("--format <format>", "csv or xliff (default: from the file extension)").choices([
        "csv",
        "xliff",
      ])
    )
    .option("--apply", "write the changes (to drafts; publish to make them live)")
    .action(async (file: string, options, command: Command) => {
      const ctx = contextOf(command);
      const format =
        options.format ??
        ([".xlf", ".xliff", ".xml"].includes(extname(file).toLowerCase()) ? "xliff" : "csv");
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        throw new UsageError(`Can't read ${file}.`);
      }
      const result = await ctx.client.post("/api/translations/import", {
        format,
        content,
        dryRun: !options.apply,
      });
      ctx.out.result(result, () => {
        const s = result.summary ?? {};
        const lines = [
          `${result.dryRun ? "Would import" : `${color.green("✓")} Imported`}: ${s.new ?? 0} new, ${s.changed ?? 0} changed, ${s.unchanged ?? 0} unchanged, ${s.invalid ?? 0} invalid (${(result.languages ?? []).join(", ")}).`,
        ];
        for (const error of (result.errors ?? []).slice(0, 20))
          lines.push(
            color.yellow(`  row ${error.row} ${error.key} [${error.language}]: ${error.message}`)
          );
        if (result.dryRun)
          lines.push(
            color.dim("  Nothing was written. Run again with --apply to save these changes.")
          );
        return lines.join("\n");
      });
    });

  group
    .command("auto <type> <id>")
    .description("Machine-translate an item (a tour's steps, a checklist's items) and save it")
    .option("--to <codes>", "target languages, e.g. de,fr (default: every supported language)")
    .option("--from <code>", "source language", "en")
    .action(async (type: string, id: string, options, command: Command) => {
      const ctx = contextOf(command);
      const def = typeOf(type);
      const itemId = parseId(id);
      const targets = options.to
        ? String(options.to)
            .split(",")
            .map((code: string) => code.trim())
            .filter(Boolean)
        : undefined;
      const units: Array<{ contentType: string; contentId: number }> = [];
      if (def.type === "tour" || def.type === "checklist") {
        const item = (await ctx.client.get(`/api/${def.plural}/${itemId}`))[def.type];
        if (def.type === "checklist") units.push({ contentType: "checklist", contentId: itemId });
        for (const child of item[def.children!] ?? [])
          units.push({
            contentType: def.type === "tour" ? "tour_step" : "checklist_item",
            contentId: child.id,
          });
      } else units.push({ contentType: def.type, contentId: itemId });

      const results: Array<Record<string, unknown>> = [];
      for (const unit of units) {
        try {
          const saved = await ctx.client.post("/api/translations", {
            ...unit,
            sourceLanguage: options.from,
            ...(targets ? { targetLanguages: targets } : {}),
          });
          results.push({ ...unit, translatedTo: saved.translatedTo ?? [] });
        } catch (error) {
          // A step with no text yet isn't a failure of the whole run.
          if ((error as { status?: number }).status === 400)
            results.push({ ...unit, skipped: (error as Error).message });
          else throw error;
        }
      }
      ctx.out.result(results, () =>
        results
          .map((r: any) =>
            r.skipped
              ? color.dim(`- ${r.contentType} ${r.contentId}: skipped (${r.skipped})`)
              : `${color.green("✓")} ${r.contentType} ${r.contentId}: ${r.translatedTo.join(", ") || "nothing new"}`
          )
          .join("\n")
      );
    });
}

export function registerPreview(program: Command) {
  program
    .command("preview <type> <id>")
    .description("A link that shows the item's draft on your real site (only for whoever opens it)")
    .option(
      "--site-url <url>",
      "the page to open (default: from the item's URL pattern or the workspace preview URL)"
    )
    .option("--ttl <minutes>", "how long the link works (default 60)")
    .action(async (type: string, id: string, options, command: Command) => {
      const ctx = contextOf(command);
      const def = typeOf(type);
      const body = await ctx.client.post("/api/preview-sessions", {
        scope: "view",
        contentRefs: [{ type: def.type, id: parseId(id) }],
        ...(options.siteUrl ? { siteUrl: options.siteUrl } : {}),
        ...(options.ttl ? { ttlMinutes: Number(options.ttl) } : {}),
      });
      ctx.out.result({ launchUrl: body.launchUrl, expiresAt: body.session?.expiresAt }, () =>
        body.launchUrl
          ? `${body.launchUrl}\n${color.dim(`  Expires ${body.session?.expiresAt ?? "in an hour"}.`)}`
          : color.yellow(
              "No page to open is known. Pass --site-url with the full URL of a page where it should show."
            )
      );
    });
}

export function registerWebhooks(program: Command) {
  const group = program
    .command("webhooks")
    .alias("webhook")
    .description("Endpoints Cueston calls when guidance changes (needs workspace.settings)");

  group
    .command("list")
    .alias("ls")
    .description("List endpoints and the event types you can subscribe to")
    .action(async (_options, command: Command) => {
      const ctx = contextOf(command);
      const body = await ctx.client.get("/api/webhooks");
      ctx.out.result(body, () => {
        const hooks: any[] = body.webhooks ?? [];
        const lines = [
          hooks.length === 0
            ? "No webhooks yet."
            : table(hooks, [
                { header: "id", value: (w) => w.id },
                { header: "url", value: (w) => w.url, max: 50 },
                { header: "events", value: (w) => w.events, max: 40 },
                { header: "active", value: (w) => (w.active ? "yes" : "no") },
                { header: "failures", value: (w) => w.consecutiveFailures ?? w.failureCount ?? 0 },
              ]),
        ];
        if (body.eventTypes?.length)
          lines.push(
            "",
            color.dim(`Event types: ${body.eventTypes.map((e: any) => e.key).join(", ")}`)
          );
        return lines.join("\n");
      });
    });

  group
    .command("create")
    .description("Add an endpoint; prints its signing secret once")
    .requiredOption("--url <url>", "https endpoint")
    .requiredOption("--events <types>", "comma-separated event types (see `webhooks list`)")
    .option("--description <text>", "what it's for")
    .action(async (options, command: Command) => {
      const ctx = contextOf(command);
      const body = await ctx.client.post("/api/webhooks", {
        url: options.url,
        events: String(options.events)
          .split(",")
          .map((event: string) => event.trim())
          .filter(Boolean),
        ...(options.description ? { description: options.description } : {}),
      });
      ctx.out.result(
        body,
        () =>
          `${color.green("✓")} Created webhook ${body.webhook.id}.\n  Signing secret (shown once): ${color.bold(body.secret)}`
      );
    });

  group
    .command("delete <id>")
    .alias("rm")
    .description("Delete an endpoint and its delivery log")
    .option("-y, --yes", "don't ask for confirmation")
    .action(async (id: string, options, command: Command) => {
      const ctx = contextOf(command);
      const hookId = parseId(id);
      if (!(await confirm(`Delete webhook ${hookId}?`, options.yes)))
        throw new CliError("Canceled.");
      await ctx.client.delete(`/api/webhooks/${hookId}`);
      ctx.out.result(
        { id: hookId, deleted: true },
        () => `${color.green("✓")} Deleted webhook ${hookId}.`
      );
    });

  group
    .command("test <id>")
    .description("Send a signed webhook.test event now and show the result")
    .action(async (id: string, _options, command: Command) => {
      const ctx = contextOf(command);
      const { delivery } = await ctx.client.post(`/api/webhooks/${parseId(id)}/test`, {});
      ctx.out.result(delivery, () =>
        delivery.status === "delivered"
          ? `${color.green("✓")} Delivered (HTTP ${delivery.responseStatus}, ${delivery.durationMs} ms).`
          : `${color.red("✗")} Failed: ${delivery.lastError ?? `HTTP ${delivery.responseStatus}`}`
      );
      if (delivery.status !== "delivered") process.exitCode = 1;
    });
}

export function registerDesignSystem(program: Command) {
  const group = program
    .command("design-system")
    .alias("theme")
    .description("The look of your guidance: style, colours, corners, shadow, buttons and sizes");

  group
    .command("get", { isDefault: true })
    .description("Show the design system")
    .action(async (_options, command: Command) => {
      const ctx = contextOf(command);
      const { brandTheme } = await ctx.client.get("/api/workspaces/current/brand-theme");
      ctx.out.result(brandTheme, () => yaml(brandTheme));
    });

  group
    .command("update")
    .description("Change the design system (only what you pass changes)")
    .option("-f, --file <path>", "JSON or YAML with the fields to change (- for stdin)")
    .option("-d, --data <json>", "the fields as JSON (or @file)")
    .addOption(new Option("--style <style>", "starting style (resets to its defaults)").choices(["clean", "soft"]))
    .addOption(new Option("--font <font>", "font").choices(["system", "humanist", "serif", "rounded"]))
    .addOption(new Option("--button-size <size>", "button size").choices(["medium", "large"]))
    .option("--accent <hex>", "light-mode accent colour, e.g. #4f46e5")
    .option("--dark-accent <hex>", "dark-mode accent colour")
    .option("--radius <px>", "card corners in px")
    .addHelpText(
      "after",
      `
Examples:
  cueston design-system update --style soft --accent #8e4f9c
  cueston design-system update -d '{"shadow":"custom","customShadow":{"y":12,"blur":32,"opacity":18}}'
  cueston design-system update -f theme.yaml`
    )
    .action(async (options, command: Command) => {
      const ctx = contextOf(command);
      const body = await bodyFrom(options, {
        style: options.style,
        font: options.font,
        buttonSize: options.buttonSize,
        radius: options.radius === undefined ? undefined : Number(options.radius),
        light: options.accent ? { accentColor: options.accent } : undefined,
        dark: options.darkAccent ? { accentColor: options.darkAccent } : undefined,
      });
      const { brandTheme } = await ctx.client.patch("/api/workspaces/current/brand-theme", body);
      ctx.out.result(brandTheme, () => `${color.green("✓")} Design system saved. Themed items on your site update within a minute.`);
    });
}
