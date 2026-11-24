import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, toApiError } from "../src/client";
import { findType, parseId, statusOf } from "../src/content-types";
import { ApiError, CliError, UsageError } from "../src/errors";
import { asObject, parseArgPairs, parseDocument } from "../src/input";
import { ago } from "../src/output";
import { buildProgram, reportError } from "../src/program";
import { statusLabel } from "../src/commands/content";

/** Parse argv with the real command tree, without running actions. Returns the exit code reportError gives. */
async function parseOnly(args: string[]): Promise<number> {
  const program = buildProgram();
  const strip = (command: typeof program) => {
    command.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    if (command.commands.length === 0) command.action(() => {});
    command.commands.forEach((sub) => strip(sub as typeof program));
  };
  strip(program);
  try {
    await program.parseAsync(["node", "cueston", ...args]);
    return 0;
  } catch (error) {
    return reportError(error, false);
  }
}

describe("argument parsing", () => {
  it("accepts every command family", async () => {
    for (const args of [
      ["login", "--no-browser"],
      ["whoami", "--json"],
      ["tours", "list", "--status", "live"],
      ["tour", "publish", "12", "--env", "staging", "--note", "x"],
      ["banners", "rollback", "3", "9"],
      ["surveys", "results", "4", "--days", "90"],
      ["segments", "estimate", "--file", "rules.yaml"],
      ["reviews", "list", "--status", "all"],
      ["analytics", "item", "tour", "1"],
      ["translations", "export", "--format", "xliff"],
      ["preview", "tour", "1", "--site-url", "https://app.acme.com"],
      ["webhooks", "create", "--url", "https://x.dev", "--events", "content.published"],
      ["pull", "content", "--type", "tours,banners"],
      ["push", "--dry-run", "--publish", "--env", "staging"],
      ["tools", "call", "validate_content", "--arg", "type=tour", "--arg", "id=1"],
      ["mcp"],
      ["api", "GET", "/api/tours", "-q", "a=1"],
      ["growth", "settings"],
      ["growth", "set", "--enabled", "--booking-url", "https://cal.com/acme/intro", "--block", "rival.io", "x.com"],
      ["growth", "leads", "--filter", "qualified", "-q", "pricing"],
      ["growth", "lead", "s_abc12345"],
      ["growth", "gaps", "--status", "all"],
      ["growth", "answer", "3", "Yes,", "on", "Orbit."],
      ["growth", "dismiss", "3"],
      ["growth", "coach", "Lead", "with", "the", "AI", "builder", "--session", "s_abc12345"],
      ["growth", "uncoach", "4"],
    ])
      expect(await parseOnly(args), args.join(" ")).toBe(0);
  });

  it("usage errors exit 2", async () => {
    expect(await parseOnly(["frobnicate"])).toBe(2);
    expect(await parseOnly(["tours", "get"])).toBe(2);
    expect(await parseOnly(["tours", "publish", "1", "--env", "prod"])).toBe(2);
    expect(await parseOnly(["reviews", "reject", "1"])).toBe(2);
    expect(await parseOnly(["tours", "list", "--bogus"])).toBe(2);
    expect(await parseOnly(["growth", "leads", "--filter", "hot"])).toBe(2);
    expect(await parseOnly(["growth", "answer", "3"])).toBe(2);
  });

  it("--help and --version exit 0", async () => {
    expect(await parseOnly(["--version"])).toBe(0);
    expect(await parseOnly(["tours", "--help"])).toBe(0);
  });
});

describe("errors", () => {
  it("CliError exits 1, UsageError 2", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(reportError(new CliError("x"), false)).toBe(1);
    expect(reportError(new UsageError("x"), false)).toBe(2);
    write.mockRestore();
  });

  it("--json errors are one JSON document on stdout", () => {
    let printed = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      printed += String(chunk);
      return true;
    });
    reportError(
      toApiError(409, JSON.stringify({ error: "Needs review", code: "approval_required" })),
      true
    );
    write.mockRestore();
    expect(JSON.parse(printed)).toMatchObject({
      error: {
        code: "approval_required",
        status: 409,
        message: "Needs review",
        hint: expect.stringContaining("request-review"),
      },
    });
  });

  it("API errors keep code, details and a hint", () => {
    const error = toApiError(
      400,
      JSON.stringify({
        error: "Validation failed",
        code: "bad_request",
        details: ["selector: required"],
      })
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.details).toEqual(["selector: required"]);
    const forbidden = toApiError(
      403,
      JSON.stringify({ error: "No", code: "forbidden", missingPermissions: ["content.publish"] })
    );
    expect(forbidden.message).toContain("content.publish");
    expect(toApiError(404, "").hint).toMatch(/id/);
    expect(toApiError(502, "<html>").code).toBe("http_502");
  });
});

describe("client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the key as a bearer token and builds URLs", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = new Client("http://localhost:3000", "sk_test");
    await client.get("/api/tours", { days: 7, empty: undefined });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/tours?days=7");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk_test");
    expect((init.headers as Record<string, string>)["user-agent"]).toMatch(/^cueston-cli\//);
  });

  it("retries a rate-limited request after Retry-After", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "rate_limited" }), {
          status: 429,
          headers: { "retry-after": "0.01" },
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ tours: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const retries: string[] = [];
    const client = new Client("http://x", "sk_test", (message) => retries.push(message));
    expect(await client.get("/api/tours")).toEqual({ tours: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(retries[0]).toMatch(/Rate limited/);
  });

  it("doesn't retry a failed POST on a 503 (it may have been applied)", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "down" }), { status: 503 })
    );
    vi.stubGlobal("fetch", fetch);
    await expect(new Client("http://x", "sk_test").post("/api/tours", {})).rejects.toBeInstanceOf(
      ApiError
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses to call the API without a key", async () => {
    await expect(new Client("http://x", null).get("/api/tours")).rejects.toThrow(/not signed in/);
  });

  it("turns JSON-RPC errors from /api/mcp into ApiError with details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: {
                code: -32602,
                message: "Invalid arguments",
                data: { details: ["id: required"] },
              },
            }),
            {
              status: 200,
            }
          )
      )
    );
    await expect(
      new Client("http://x", "sk_test").mcp("tools/call", { name: "get_content" })
    ).rejects.toMatchObject({
      code: "rpc_-32602",
      details: ["id: required"],
    });
  });
});

describe("input", () => {
  it("--arg pairs parse JSON-looking values", () => {
    expect(
      parseArgPairs(["id=12", "type=tour", "live=true", "tags=[1,2]", "q=a=b", "n=null"])
    ).toEqual({
      id: 12,
      type: "tour",
      live: true,
      tags: [1, 2],
      q: "a=b",
      n: null,
    });
    expect(() => parseArgPairs(["novalue"])).toThrow(UsageError);
  });

  it("reads JSON and YAML", () => {
    expect(parseDocument('{"a":1}', "x")).toEqual({ a: 1 });
    expect(parseDocument("a: 1\nb: [x]\n", "x")).toEqual({ a: 1, b: ["x"] });
    expect(() => parseDocument("{oops", "x")).toThrow(UsageError);
    expect(() => parseDocument("  ", "x")).toThrow(/empty/);
    expect(() => asObject([1], "x")).toThrow(UsageError);
  });
});

describe("content types and output", () => {
  it("accept singular and plural names", () => {
    expect(findType("Tour")?.plural).toBe("tours");
    expect(findType("announcements")?.type).toBe("announcement");
    expect(findType("tours ")?.type).toBe("tour");
    expect(findType("widgets")).toBeUndefined();
  });

  it("ids must be positive integers", () => {
    expect(parseId("12")).toBe(12);
    for (const bad of ["0", "-1", "1.5", "abc", "12abc"])
      expect(() => parseId(bad)).toThrow(UsageError);
  });

  it("status labels", () => {
    expect(statusOf(null)).toBe("draft");
    expect(statusLabel({ publication: { production: {} }, hasUnpublishedChanges: true })).toBe(
      "live · edited"
    );
    expect(
      statusLabel({
        publication: { staging: {} },
        hasUnpublishedChanges: { production: false, staging: true },
      })
    ).toBe("staging · edited");
    expect(statusLabel({ publication: {}, hasUnpublishedChanges: true })).toBe("draft");
  });

  it("relative times", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    expect(ago("2026-10-26T11:59:50Z", now)).toBe("just now");
    expect(ago("2026-10-26T11:57:00Z", now)).toBe("3 minutes ago");
    expect(ago("2026-10-26T10:00:00Z", now)).toBe("2 hours ago");
    expect(ago("2026-10-25T12:00:00Z", now)).toBe("1 day ago");
    expect(ago("2026-08-01T00:00:00Z", now)).toBe("2026-08-01");
    expect(ago(null, now)).toBe("—");
  });
});

describe("growth commands", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function run(args: string[]) {
    const program = buildProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const log = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await program.parseAsync(["node", "cueston", "--key", "sk_test_cli", "--api-url", "https://app.example.com", "--json", ...args]);
    } finally {
      log.mockRestore();
    }
  }

  it("set sends only what was passed; \"none\" clears a link", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ agentSettings: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await run(["growth", "set", "--enabled", "--booking-url", "https://cal.com/acme/intro", "--demo-url", "none", "--block", "rival.io"]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.example.com/api/workspaces/current/agent-settings");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      enabled: true,
      bookingUrl: "https://cal.com/acme/intro",
      demoUrl: null,
      blockedDomains: ["rival.io"],
    });
  });

  it("answer and coach post the right bodies", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, note: { id: 9 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await run(["growth", "answer", "3", "Yes,", "on", "Orbit."]);
    await run(["growth", "coach", "Lead", "with", "tours", "--session", "s_abc12345"]);
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe("https://app.example.com/api/growth/gaps/3");
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ action: "answer", answer: "Yes, on Orbit." });
    expect(calls[1][0]).toBe("https://app.example.com/api/growth/coaching");
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ note: "Lead with tours", sessionId: "s_abc12345" });
  });
});
