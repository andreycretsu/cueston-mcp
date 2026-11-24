/**
 * Growth: the AI demo agent on your website — settings, leads, and its self-improving loop.
 *
 *   cueston growth settings                      show the demo agent's settings
 *   cueston growth set --enabled --booking-url https://cal.com/acme/intro
 *   cueston growth leads [--filter qualified]    demo conversations (leads)
 *   cueston growth lead <sessionId>              one conversation: transcript, review, next steps
 *   cueston growth gaps [--status open]          questions the agent couldn't answer + coaching
 *   cueston growth answer <id> "<answer>"        answer once; every later demo uses it
 *   cueston growth coach "<note>"                coach the agent (applies from its next step)
 */
import { Option, type Command } from "commander";
import { parseId } from "../content-types.js";
import { contextOf } from "../context.js";
import { UsageError } from "../errors.js";
import { bodyFrom } from "../input.js";
import { ago, color, table, yaml } from "../output.js";

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** --enabled / --no-enabled style switches: undefined when not given. */
const flag = (options: Record<string, unknown>, name: string) =>
  typeof options[name] === "boolean" ? (options[name] as boolean) : undefined;

/** "" or "none" clears a link. */
const link = (value: unknown) => (value === undefined ? undefined : value === "" || value === "none" ? null : String(value));

export function registerGrowth(program: Command) {
  const group = program
    .command("growth")
    .description("The AI demo agent on your website: settings, leads, and what it should learn");

  group.command("settings").description("Show the demo agent's settings").action(async (_o, command: Command) => {
    const ctx = contextOf(command);
    const body = await ctx.client.get("/api/workspaces/current/agent-settings");
    const s = body.agentSettings;
    ctx.out.result(body, () =>
      [
        `${color.bold("Demo agent")}  ${s.enabled ? color.green("on") : color.dim("off")}`,
        `mode:          ${s.playbook?.mode ?? "support"}`,
        `clicks for visitors: ${s.drives ? "yes" : "no"}   asks for email: ${s.leadCapture ? "yes" : "no"}`,
        `booking link:  ${s.bookingUrl ?? color.dim("none")}`,
        `demo app:      ${s.demoUrl ?? color.dim("none")}`,
        `slack alerts:  ${s.slackConnected ? "on" : color.dim("off")}`,
        `blocked:       ${s.blockedDomains?.length ? s.blockedDomains.join(", ") : color.dim("none")}`,
        "",
        yaml({ playbook: s.playbook, suggestions: s.suggestions }),
      ].join("\n")
    );
  });

  group
    .command("set")
    .description("Change the demo agent (only what you pass changes)")
    .option("--enabled", "turn it on")
    .option("--no-enabled", "turn it off")
    .option("--drives", "let it click for visitors (paid plans)")
    .option("--no-drives", "only point, never click")
    .option("--lead-capture", "ask for a work email first (paid plans)")
    .option("--no-lead-capture", "don't ask for an email")
    .option("--label <text>", "launcher text")
    .option("--booking-url <url>", "booking link (https), opened inside the demo; \"none\" removes it")
    .option("--demo-url <url>", "live demo environment (https); \"none\" removes it")
    .option("--slack-webhook <url>", "Slack incoming webhook for new-lead alerts; \"none\" removes it")
    .option("--block <domains...>", "company domains or emails to keep out (replaces the list)")
    .option("-f, --file <path>", "JSON or YAML with any settings, e.g. a full playbook (- for stdin)")
    .option("-d, --data <json>", "the settings as JSON (or @file)")
    .addHelpText(
      "after",
      `
Examples:
  cueston growth set --enabled --booking-url https://cal.com/acme/intro
  cueston growth set --block rival.io competitor.com
  cueston growth set -f playbook.yaml      # { playbook: { mode: sales, pitch: ..., ... } }`
    )
    .action(async (options, command: Command) => {
      const ctx = contextOf(command);
      const body = await bodyFrom(options, {
        enabled: flag(options, "enabled"),
        drives: flag(options, "drives"),
        leadCapture: flag(options, "leadCapture"),
        label: options.label,
        bookingUrl: link(options.bookingUrl),
        demoUrl: link(options.demoUrl),
        slackWebhookUrl: link(options.slackWebhook),
        blockedDomains: options.block,
      });
      if (Object.keys(body).length === 0) throw new UsageError("Nothing to change.", "Pass at least one option, e.g. --enabled.");
      const res = await ctx.client.patch("/api/workspaces/current/agent-settings", body);
      ctx.out.result(res, () => `${color.green("✓")} Demo agent updated (applies to the next visitor).`);
    });

  group
    .command("leads")
    .description("Demo conversations: who asked what, email, qualified, booked")
    .addOption(new Option("--filter <bucket>", "which leads").choices(["all", "qualified", "unqualified", "unreviewed"]).default("all"))
    .option("-q, --search <text>", "search goal, summary, email")
    .option("--limit <n>", "how many (1–200)", "50")
    .action(async (options, command: Command) => {
      const ctx = contextOf(command);
      const body = await ctx.client.get("/api/ai/conversations", {
        filter: options.filter,
        limit: options.limit,
        ...(options.search ? { q: options.search } : {}),
      });
      ctx.out.result(body, () =>
        body.conversations.length === 0
          ? "No demo conversations yet."
          : table(body.conversations as any[], [
              { header: "id", value: (c) => c.sessionId },
              { header: "who", value: (c) => c.email ?? c.name ?? c.visitorId ?? "anonymous", max: 32 },
              { header: "asked", value: (c) => c.goal, max: 40 },
              { header: "qualified", value: (c) => (c.qualified === "true" ? color.green("yes") : c.qualified === "false" ? "no" : "—") },
              { header: "booked", value: (c) => (c.bookedAt ? color.green("yes") : c.bookingOpenedAt ? "opened" : "—") },
              { header: "when", value: (c) => ago(c.updatedAt) },
            ]) + `\n${body.total} total · ${body.counts.qualified} qualified`
      );
    });

  group
    .command("lead <sessionId>")
    .description("One demo conversation: transcript, AI review and next steps")
    .action(async (sessionId: string, _o, command: Command) => {
      if (!SESSION_ID.test(sessionId)) throw new UsageError(`"${sessionId}" isn't a conversation id.`, "Copy one from `cueston growth leads`.");
      const ctx = contextOf(command);
      const { conversation } = await ctx.client.get(`/api/ai/conversations/${encodeURIComponent(sessionId)}`);
      ctx.out.result(conversation, () => yaml(conversation));
    });

  group
    .command("gaps")
    .description("Questions the agent couldn't answer, and active coaching notes")
    .addOption(new Option("--status <status>", "which questions").choices(["open", "answered", "dismissed", "all"]).default("open"))
    .action(async (options, command: Command) => {
      const ctx = contextOf(command);
      const body = await ctx.client.get("/api/growth/improve", { status: options.status });
      ctx.out.result(body, () =>
        [
          body.gaps.length === 0
            ? "No questions to answer."
            : table(body.gaps as any[], [
                { header: "id", value: (g) => g.id },
                { header: "question", value: (g) => g.question, max: 60 },
                { header: "asked", value: (g) => g.askedCount },
                { header: "status", value: (g) => g.status },
                { header: "last", value: (g) => ago(g.lastAskedAt) },
              ]),
          "",
          color.bold("Coaching"),
          body.coaching.length === 0
            ? color.dim("  none")
            : table(body.coaching as any[], [
                { header: "id", value: (n) => n.id },
                { header: "note", value: (n) => n.note, max: 70 },
              ]),
        ].join("\n")
      );
    });

  group
    .command("answer <id> <answer...>")
    .description("Answer a question once; every later demo uses it")
    .action(async (id: string, words: string[], _o, command: Command) => {
      const ctx = contextOf(command);
      const res = await ctx.client.post(`/api/growth/gaps/${parseId(id)}`, { action: "answer", answer: words.join(" ") });
      ctx.out.result(res, () => `${color.green("✓")} Saved. The agent uses this answer from now on.`);
    });

  group
    .command("dismiss <id>")
    .description("Dismiss a question the agent couldn't answer")
    .action(async (id: string, _o, command: Command) => {
      const ctx = contextOf(command);
      const res = await ctx.client.post(`/api/growth/gaps/${parseId(id)}`, { action: "dismiss" });
      ctx.out.result(res, () => `${color.green("✓")} Dismissed.`);
    });

  group
    .command("coach <note...>")
    .description("Coach the agent in plain words (applies from its next step)")
    .option("--session <id>", "the conversation it came from")
    .action(async (words: string[], options, command: Command) => {
      const ctx = contextOf(command);
      const res = await ctx.client.post("/api/growth/coaching", { note: words.join(" "), ...(options.session ? { sessionId: options.session } : {}) });
      ctx.out.result(res, () => `${color.green("✓")} Coaching note #${res.note.id} added.`);
    });

  group
    .command("uncoach <id>")
    .description("Remove a coaching note")
    .action(async (id: string, _o, command: Command) => {
      const ctx = contextOf(command);
      const res = await ctx.client.delete(`/api/growth/coaching/${parseId(id)}`);
      ctx.out.result(res, () => `${color.green("✓")} Removed.`);
    });
}
