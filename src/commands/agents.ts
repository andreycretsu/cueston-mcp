/** MCP parity (`tools list|call`), the stdio bridge (`mcp`) and raw API requests (`api`). */
import { createInterface } from "node:readline";
import type { Command } from "commander";
import { userAgent } from "../client.js";
import { contextOf } from "../context.js";
import { ApiError, CliError, UsageError } from "../errors.js";
import { asObject, parseArgPairs, readData } from "../input.js";
import { color, json, table, yaml } from "../output.js";

export function registerTools(program: Command) {
  const group = program
    .command("tools")
    .description("Call any MCP tool directly (validate_content, find_elements, list_pages…)");

  group
    .command("list")
    .alias("ls")
    .description("List the tools your key may use")
    .option("--schema <name>", "print one tool's input schema")
    .action(async (options, command: Command) => {
      const ctx = contextOf(command);
      const { tools } = await ctx.client.mcp<{ tools: any[] }>("tools/list");
      if (options.schema) {
        const tool = tools.find((candidate) => candidate.name === options.schema);
        if (!tool)
          throw new UsageError(
            `No tool named ${options.schema}.`,
            "Run `cueston tools list` to see them."
          );
        ctx.out.result(
          tool,
          () => `${color.bold(tool.name)}: ${tool.description}\n\n${yaml(tool.inputSchema)}`
        );
        return;
      }
      ctx.out.result(tools, () =>
        table(tools, [
          { header: "name", value: (t) => t.name },
          { header: "title", value: (t) => t.title, max: 50 },
          {
            header: "kind",
            value: (t) =>
              t.annotations?.readOnlyHint
                ? "read"
                : t.annotations?.destructiveHint
                  ? "destructive"
                  : "write",
          },
        ])
      );
    });

  group
    .command("call <name>")
    .description("Call a tool with arguments")
    .option(
      "-a, --arg <key=value>",
      "an argument (repeatable; values like 12, true or [..] are parsed as JSON)",
      collect,
      []
    )
    .option("-d, --data <json>", "all arguments as JSON (or @file)")
    .addHelpText(
      "after",
      `
Examples:
  cueston tools call validate_content --arg type=tour --arg id=12
  cueston tools call find_elements --arg query="export button"
  cueston tools call debug_audience --data '{"url":"https://app.acme.com/billing","userId":"u_42"}'`
    )
    .action(async (name: string, options, command: Command) => {
      const ctx = contextOf(command);
      const args = {
        ...(options.data ? asObject(await readData(options.data), "--data") : {}),
        ...parseArgPairs(options.arg),
      };
      const result = await ctx.client.mcp<any>("tools/call", { name, arguments: args });
      const data = result?.structuredContent ?? textOf(result);
      if (result?.isError) {
        if (ctx.out.jsonMode) ctx.out.result({ isError: true, result: data });
        throw new CliError(`${name} failed: ${typeof data === "string" ? data : json(data)}`);
      }
      ctx.out.result(data, () => (typeof data === "string" ? data : yaml(data)));
    });
}

const collect = (value: string, previous: string[]) => [...previous, value];

function textOf(result: any): unknown {
  const text = (result?.content ?? [])
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function registerMcpBridge(program: Command) {
  program
    .command("mcp")
    .description(
      "Run Cueston's MCP server over stdio (for MCP clients that can't connect over HTTP)"
    )
    .addHelpText(
      "after",
      `
Reads JSON-RPC messages (one per line) on stdin, sends them to ${"<api-url>"}/api/mcp with your
key, and writes the responses to stdout. Logs go to stderr. Client config:

  { "mcpServers": { "cueston": { "command": "npx", "args": ["-y", "cueston", "mcp"],
      "env": { "CUESTON_API_KEY": "sk_…" } } } }`
    )
    .action(async (_options, command: Command) => {
      const ctx = contextOf(command);
      const key = ctx.client.requireKey();
      const endpoint = `${ctx.auth.apiUrl}/api/mcp`;
      const log = (message: string) => process.stderr.write(`[cueston mcp] ${message}\n`);
      log(`bridging stdio to ${endpoint}`);

      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
      // Answer in order, one request at a time (MCP clients match responses by id anyway).
      let queue = Promise.resolve();
      lines.on("line", (line) => {
        queue = queue.then(() => forward(line));
      });
      await new Promise<void>((resolve) => lines.on("close", () => queue.then(() => resolve())));

      async function forward(line: string) {
        const text = line.trim();
        if (!text) return;
        let message: any;
        try {
          message = JSON.parse(text);
        } catch {
          write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          return;
        }
        const ids = (Array.isArray(message) ? message : [message])
          .filter((m) => m && typeof m === "object" && "id" in m && m.id !== null)
          .map((m) => m.id);
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "user-agent": userAgent(),
            },
            body: text,
            signal: AbortSignal.timeout(120_000),
          });
          const body = await response.text();
          if (response.status === 202 || !body) return; // notifications: no reply
          if (!response.ok) {
            let reason = `HTTP ${response.status}`;
            try {
              reason = JSON.parse(body).error ?? reason;
            } catch {
              // keep the status
            }
            log(`request failed: ${reason}`);
            for (const id of ids)
              write({ jsonrpc: "2.0", id, error: { code: -32603, message: reason } });
            return;
          }
          process.stdout.write(`${body.replace(/\n/g, "")}\n`);
        } catch (error) {
          const reason = (error as Error)?.message ?? String(error);
          log(`can't reach ${endpoint}: ${reason}`);
          for (const id of ids)
            write({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: `Can't reach Cueston: ${reason}` },
            });
        }
      }

      function write(value: unknown) {
        process.stdout.write(`${JSON.stringify(value)}\n`);
      }
    });
}

export function registerApi(program: Command) {
  program
    .command("api <method> <path>")
    .description("Send an authenticated request to any Cueston API endpoint and print the response")
    .option("-d, --data <json>", "request body as JSON (or @file, or - for stdin)")
    .option("-q, --query <key=value>", "query parameter (repeatable)", collect, [])
    .addHelpText(
      "after",
      `
Examples:
  cueston api GET /api/tours
  cueston api PATCH /api/tours/12 --data '{"name":"Welcome"}'
  cueston api GET /api/analytics/overview -q days=7`
    )
    .action(async (method: string, path: string, options, command: Command) => {
      const ctx = contextOf(command);
      const upper = method.toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(upper))
        throw new UsageError(
          `Unsupported method ${method}.`,
          "Use GET, POST, PUT, PATCH or DELETE."
        );
      if (!path.startsWith("/")) path = `/${path}`;
      if (!path.startsWith("/api/")) path = `/api${path}`;
      const query = Object.fromEntries(
        (options.query as string[]).map((pair) => {
          const index = pair.indexOf("=");
          if (index <= 0) throw new UsageError(`Invalid --query "${pair}".`, "Use key=value.");
          return [pair.slice(0, index), pair.slice(index + 1)];
        })
      );
      const body = options.data
        ? await readData(options.data)
        : upper === "GET" || upper === "DELETE"
          ? undefined
          : {};
      try {
        const result = await ctx.client.request(upper, path, { body, query });
        if (typeof result === "string")
          process.stdout.write(result.endsWith("\n") ? result : `${result}\n`);
        else process.stdout.write(`${json(result)}\n`);
      } catch (error) {
        // Print the error body as is, like any other response, and fail.
        if (error instanceof ApiError && error.body && typeof error.body === "object") {
          process.stdout.write(`${json(error.body)}\n`);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    });
}
