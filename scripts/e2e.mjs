#!/usr/bin/env node
/**
 * End-to-end check of the built CLI (dist/cli.js) against a running Cueston app.
 *
 *   npm run build
 *   CUESTON_API_URL=http://localhost:3000 CUESTON_API_KEY=sk_… npm run e2e
 *   (or CUESTON_E2E_KEY_FILE=/path/to/key instead of CUESTON_API_KEY)
 *
 * Use a key for a scratch workspace (owner, Pro plan): the run creates, publishes to staging and
 * deletes guidance, segments and a webhook there. It never touches production environments.
 * Every command family is exercised; the run prints PASS/FAIL per check and exits 1 on any failure.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const apiUrl = process.env.CUESTON_API_URL;
const key =
  process.env.CUESTON_API_KEY ||
  (process.env.CUESTON_E2E_KEY_FILE
    ? readFileSync(process.env.CUESTON_E2E_KEY_FILE, "utf8").trim()
    : "");
if (!apiUrl || !key) {
  console.error("Set CUESTON_API_URL and CUESTON_API_KEY (or CUESTON_E2E_KEY_FILE).");
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "cueston-e2e-"));
const work = mkdtempSync(join(tmpdir(), "cueston-e2e-content-"));
const baseEnv = {
  ...process.env,
  CUESTON_CONFIG_DIR: home,
  CUESTON_API_URL: apiUrl,
  NO_COLOR: "1",
};
delete baseEnv.CUESTON_API_KEY;
const env = { ...baseEnv, CUESTON_API_KEY: key };

let failures = 0;
const results = [];

function cli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: options.env ?? env,
    input: options.input,
    cwd: options.cwd ?? work,
    encoding: "utf8",
    timeout: 120_000,
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // human output
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition) });
  if (condition) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name}${detail ? `\n      ${String(detail).slice(0, 800).replace(/\n/g, "\n      ")}` : ""}`
    );
  }
}

const show = (r) => `exit ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;

// --- basics ---------------------------------------------------------------------------------
{
  const r = cli(["--version"]);
  check("--version", r.code === 0 && /^\d+\.\d+\.\d+/.test(r.stdout.trim()), show(r));
  const help = cli(["tours", "publish", "--help"]);
  check("help for a subcommand", help.code === 0 && help.stdout.includes("--env"), show(help));
  const unknown = cli(["frobnicate"]);
  check("unknown command → exit 2", unknown.code === 2, show(unknown));
  const missingArg = cli(["tours", "get"]);
  check("missing argument → exit 2", missingArg.code === 2, show(missingArg));
  const badId = cli(["tours", "get", "abc"]);
  check(
    "invalid id → exit 2",
    badId.code === 2 && badId.stderr.includes("Invalid id"),
    show(badId)
  );
  const signedOut = cli(["tours", "list"], { env: baseEnv });
  check(
    "no key → exit 1 with a hint",
    signedOut.code === 1 && signedOut.stderr.includes("cueston login"),
    show(signedOut)
  );
  const badKey = cli(["whoami", "--json"], {
    env: { ...baseEnv, CUESTON_API_KEY: ["sk", "invalid"].join("_") },
  });
  check(
    "wrong key → exit 1, JSON error shape",
    badKey.code === 1 &&
      badKey.json?.error?.status === 401 &&
      typeof badKey.json.error.message === "string",
    show(badKey)
  );
}

// --- login --key, whoami, logout ------------------------------------------------------------
{
  const login = cli(["login", "--with-key", "--json"], { env: baseEnv, input: key });
  check(
    "login --with-key saves the key",
    login.code === 0 && login.json?.user?.email && login.json?.key?.endsWith(key.slice(-4)),
    show(login)
  );
  check(
    "login output never prints the full key",
    !login.stdout.includes(key) && !login.stderr.includes(key)
  );
  const config = readFileSync(join(home, "config.json"), "utf8");
  check("config file holds the key", config.includes(key));
  if (process.platform !== "win32") {
    const mode = (
      spawnSync(
        "stat",
        process.platform === "darwin"
          ? ["-f", "%Lp", join(home, "config.json")]
          : ["-c", "%a", join(home, "config.json")],
        { encoding: "utf8" }
      ).stdout || ""
    ).trim();
    check("config file is 0600", mode === "600", mode);
  }
  const whoami = cli(["whoami", "--json"], { env: baseEnv });
  check(
    "whoami from the saved key",
    whoami.code === 0 &&
      whoami.json?.keySource === "config" &&
      Array.isArray(whoami.json?.workspace?.permissions),
    show(whoami)
  );
  const human = cli(["whoami"], { env: baseEnv });
  check(
    "whoami human output masks the key",
    human.code === 0 && human.stdout.includes("sk_…") && !human.stdout.includes(key),
    show(human)
  );
  const logout = cli(["logout", "--json"], { env: baseEnv });
  check(
    "logout forgets the key (no revoke)",
    logout.code === 0 && logout.json?.signedOut === true && logout.json?.revoked === false,
    show(logout)
  );
  const after = cli(["whoami"], { env: baseEnv });
  check("signed out afterwards", after.code === 1, show(after));
}

// --- content: every type --------------------------------------------------------------------
const BODIES = {
  tours: {
    name: "E2E tour",
    urlPattern: "https://app.example.com/*",
    steps: [{ selector: "#start", title: "Start here", content: "Click to begin." }],
  },
  tooltips: {
    name: "E2E tooltip",
    urlPattern: "https://app.example.com/*",
    selector: "#help",
    title: "Help",
    content: "Hi",
  },
  banners: {
    name: "E2E banner",
    urlPattern: "https://app.example.com/*",
    title: "Heads up",
    content: "Maintenance tonight.",
  },
  checklists: { name: "E2E checklist", urlPattern: "https://app.example.com/*" },
  surveys: { name: "E2E survey", urlPattern: "https://app.example.com/*" },
  announcements: { name: "E2E announcement", urlPattern: "*" },
};
const created = {};
for (const [type, body] of Object.entries(BODIES)) {
  const file = join(work, `${type}.json`);
  writeFileSync(file, JSON.stringify({ ...body, isActive: true }));
  const create = cli([type, "create", "--file", file, "--json"]);
  const item = create.json;
  check(
    `${type}: create from --file (draft, isActive ignored)`,
    create.code === 0 && item?.id && !item?.publication?.production,
    show(create)
  );
  if (!item?.id) continue;
  created[type] = item.id;
  const get = cli([type, "get", String(item.id)]);
  check(
    `${type}: get (human YAML)`,
    get.code === 0 && get.stdout.includes(`name: ${body.name}`),
    show(get)
  );
  const update = cli([type, "update", String(item.id), "--name", `${body.name} v2`, "--json"]);
  check(
    `${type}: update --name`,
    update.code === 0 && update.json?.name === `${body.name} v2`,
    show(update)
  );
  const list = cli([type, "list", "--json"]);
  check(
    `${type}: list includes it`,
    list.code === 0 && list.json?.some((row) => row.id === item.id),
    show(list)
  );
  const publish = cli([
    type,
    "publish",
    String(item.id),
    "--env",
    "staging",
    "--note",
    "e2e",
    "--json",
  ]);
  check(
    `${type}: publish --env staging`,
    publish.code === 0 && publish.json?.publication?.staging,
    show(publish)
  );
  const versions = cli([type, "versions", String(item.id), "--json"]);
  const versionId = versions.json?.versions?.[0]?.id;
  check(`${type}: versions`, versions.code === 0 && versionId, show(versions));
  const status = cli([type, "list", "--status", "staging", "--json"]);
  check(
    `${type}: list --status staging`,
    status.code === 0 && status.json?.some((row) => row.id === item.id),
    show(status)
  );
  if (versionId) {
    const rollback = cli([
      type,
      "rollback",
      String(item.id),
      String(versionId),
      "--env",
      "staging",
      "--json",
    ]);
    check(`${type}: rollback to a version`, rollback.code === 0, show(rollback));
    const restore = cli([type, "restore", String(item.id), String(versionId), "--json"]);
    check(
      `${type}: restore a version into the draft`,
      restore.code === 0 && restore.json?.restoredFrom?.id === versionId,
      show(restore)
    );
  }
  const unpublish = cli([type, "unpublish", String(item.id), "--env", "staging", "--json"]);
  check(
    `${type}: unpublish`,
    unpublish.code === 0 && !unpublish.json?.publication?.staging,
    show(unpublish)
  );
  const copy = cli([type, "duplicate", String(item.id), "--json"]);
  check(
    `${type}: duplicate`,
    copy.code === 0 && copy.json?.id && copy.json.id !== item.id,
    show(copy)
  );
  if (copy.json?.id) {
    const noYes = cli([type, "delete", String(copy.json.id)]);
    check(
      `${type}: delete without --yes outside a terminal → exit 2`,
      noYes.code === 2,
      show(noYes)
    );
    const del = cli([type, "delete", String(copy.json.id), "--yes", "--json"]);
    check(`${type}: delete --yes`, del.code === 0 && del.json?.deleted === true, show(del));
  }
}

{
  const review = cli([
    "tours",
    "request-review",
    String(created.tours),
    "--note",
    "e2e review",
    "--json",
  ]);
  check("request-review", review.code === 0 && review.json?.request?.id, show(review));
  const requests = cli(["reviews", "list", "--json"]);
  check(
    "reviews list",
    requests.code === 0 && requests.json?.some((r) => r.id === review.json?.request?.id),
    show(requests)
  );
  if (review.json?.request?.id) {
    const cancel = cli(["reviews", "cancel", String(review.json.request.id), "--json"]);
    check(
      "reviews cancel",
      cancel.code === 0 && cancel.json?.request?.status === "canceled",
      show(cancel)
    );
  }
  const viaStdin = cli(["banners", "update", String(created.banners), "--file", "-", "--json"], {
    input: "title: From stdin\n",
  });
  check(
    "update --file - (YAML on stdin)",
    viaStdin.code === 0 && viaStdin.json?.title === "From stdin",
    show(viaStdin)
  );
  const invalid = cli(["tooltips", "create", "--name", "No selector", "--url-pattern", "*"]);
  check(
    "validation errors list the fields",
    invalid.code === 1 && invalid.stderr.includes("selector"),
    show(invalid)
  );
}

// --- segments ------------------------------------------------------------------------------
{
  const rules = { matchType: "all", rules: [{ type: "role", operator: "equals", value: "admin" }] };
  writeFileSync(
    join(work, "segment.json"),
    JSON.stringify({ name: `E2E admins ${Date.now()}`, rules })
  );
  const create = cli(["segments", "create", "--file", "segment.json", "--json"]);
  check("segments create", create.code === 0 && create.json?.id, show(create));
  const id = create.json?.id;
  if (id) {
    check(
      "segments list",
      cli(["segments", "list", "--json"]).json?.some((s) => s.id === id)
    );
    check("segments get", cli(["segments", "get", String(id), "--json"]).json?.id === id);
    const update = cli([
      "segments",
      "update",
      String(id),
      "--description",
      "Admins only",
      "--json",
    ]);
    check(
      "segments update",
      update.code === 0 && update.json?.description === "Admins only",
      show(update)
    );
    const estimate = cli(["segments", "estimate", String(id), "--json"]);
    check(
      "segments estimate",
      estimate.code === 0 && typeof estimate.json?.count === "number",
      show(estimate)
    );
    writeFileSync(
      join(work, "rules.yaml"),
      "matchType: all\nrules:\n  - { type: role, operator: equals, value: admin }\n"
    );
    const adhoc = cli(["segments", "estimate", "--file", "rules.yaml", "--json"]);
    check(
      "segments estimate --file (unsaved rules)",
      adhoc.code === 0 && typeof adhoc.json?.count === "number",
      show(adhoc)
    );
    const del = cli(["segments", "delete", String(id), "--yes", "--json"]);
    check("segments delete", del.code === 0, show(del));
  }
}

// --- analytics, surveys, translations, preview ------------------------------------------------
{
  const overview = cli(["analytics", "--days", "7", "--json"]);
  check(
    "analytics (overview is the default)",
    overview.code === 0 && overview.json?.totals,
    show(overview)
  );
  const human = cli(["analytics", "overview"]);
  check(
    "analytics overview (human)",
    human.code === 0 && human.stdout.includes("Last 30 days"),
    show(human)
  );
  const item = cli(["analytics", "item", "tour", String(created.tours), "--json"]);
  check("analytics item", item.code === 0 && item.json?.content?.id === created.tours, show(item));
  const issues = cli(["analytics", "issues", "--json"]);
  check("analytics issues", issues.code === 0 && Array.isArray(issues.json?.items), show(issues));
  const csv = cli(["analytics", "export", "content", "--days", "7"]);
  check(
    "analytics export (CSV to stdout)",
    csv.code === 0 && csv.stdout.split("\n")[0].includes(","),
    show(csv)
  );
  const results = cli(["surveys", "results", String(created.surveys), "--json"]);
  check(
    "surveys results",
    results.code === 0 && results.json?.survey?.id === created.surveys,
    show(results)
  );
  const exportFile = join(work, "translations.csv");
  const exported = cli(["translations", "export", "--languages", "de", "-o", exportFile]);
  check(
    "translations export -o file",
    exported.code === 0 && readFileSync(exportFile, "utf8").length > 0,
    show(exported)
  );
  const dry = cli(["translations", "import", exportFile, "--json"]);
  check(
    "translations import (dry run by default)",
    dry.code === 0 && dry.json?.dryRun === true,
    show(dry)
  );
  const preview = cli([
    "preview",
    "tour",
    String(created.tours),
    "--site-url",
    "https://app.example.com/start",
    "--json",
  ]);
  check(
    "preview link",
    preview.code === 0 && preview.json?.launchUrl?.includes("cueston_preview="),
    show(preview)
  );
}

// --- webhooks ------------------------------------------------------------------------------
{
  const list = cli(["webhooks", "list", "--json"]);
  const event = list.json?.eventTypes?.[0]?.key;
  check("webhooks list (with event types)", list.code === 0 && event, show(list));
  if (event) {
    const create = cli([
      "webhooks",
      "create",
      "--url",
      "https://example.com/cueston-e2e",
      "--events",
      event,
      "--json",
    ]);
    check(
      "webhooks create (secret shown once)",
      create.code === 0 && create.json?.secret && create.json?.webhook?.id,
      show(create)
    );
    const id = create.json?.webhook?.id;
    if (id) {
      const test = cli(["webhooks", "test", String(id), "--json"]);
      check(
        "webhooks test reports the delivery",
        [0, 1].includes(test.code) && test.json?.status,
        show(test)
      );
      const del = cli(["webhooks", "delete", String(id), "--yes", "--json"]);
      check("webhooks delete", del.code === 0, show(del));
    }
  }
}

// --- content as code ------------------------------------------------------------------------
{
  const dir = join(work, "content");
  const pulled = cli(["pull", dir, "--type", "tours,banners", "--json"]);
  check("pull", pulled.code === 0 && pulled.json?.written?.length >= 2, show(pulled));
  const tourFiles = readdirSync(join(dir, "tours"));
  const tourFile = tourFiles.find((name) => name.startsWith(`${created.tours}-`));
  check("pull writes <id>-<slug>.json", Boolean(tourFile), tourFiles.join(", "));
  const tourPath = join(dir, "tours", tourFile);
  const tour = JSON.parse(readFileSync(tourPath, "utf8"));
  check(
    "pulled files hold editable fields only",
    tour.id === created.tours &&
      !("publication" in tour) &&
      !("createdAt" in tour) &&
      Array.isArray(tour.steps),
    JSON.stringify(tour).slice(0, 400)
  );
  check("step ids are kept", tour.steps?.[0]?.id > 0, JSON.stringify(tour.steps));

  const clean = cli(["push", dir, "--type", "tours,banners", "--dry-run", "--json"]);
  check(
    "push right after pull: nothing to change",
    clean.code === 0 && clean.json?.plan?.every((entry) => entry.action === "unchanged"),
    show(clean)
  );

  tour.name = "Renamed in git";
  tour.steps[0].title = "Edited step";
  writeFileSync(tourPath, JSON.stringify(tour, null, 2));
  writeFileSync(
    join(dir, "banners", "new-banner.json"),
    JSON.stringify({
      name: "Banner from git",
      urlPattern: "*",
      title: "New",
      content: "Created by push",
    })
  );

  const dry = cli(["push", dir, "--type", "tours,banners", "--dry-run", "--json"]);
  const update = dry.json?.plan?.find((entry) => entry.id === created.tours);
  const createEntry = dry.json?.plan?.find((entry) => entry.action === "create");
  check(
    "push --dry-run: plans the update with changed fields",
    update?.action === "update" && update.fields.join(",") === "name,steps",
    show(dry)
  );
  check(
    "push --dry-run: plans the create",
    createEntry?.file?.endsWith("new-banner.json"),
    show(dry)
  );
  check(
    "push --dry-run changes nothing",
    cli(["tours", "get", String(created.tours), "--json"]).json?.name !== "Renamed in git"
  );
  const humanPlan = cli(["push", dir, "--type", "tours,banners", "--dry-run"]);
  check(
    "push --dry-run prints a readable plan",
    humanPlan.code === 0 &&
      humanPlan.stderr.includes("~ update") &&
      humanPlan.stderr.includes("+ create"),
    show(humanPlan)
  );

  const pushed = cli([
    "push",
    dir,
    "--type",
    "tours,banners",
    "--publish",
    "--env",
    "staging",
    "--json",
  ]);
  check(
    "push applies and publishes to staging",
    pushed.code === 0 && pushed.json?.applied?.length === 2 && pushed.json?.published?.length === 2,
    show(pushed)
  );
  const server = cli(["tours", "get", String(created.tours), "--json"]).json;
  check(
    "the server has the edits",
    server?.name === "Renamed in git" &&
      server?.steps?.[0]?.title === "Edited step" &&
      server?.steps?.[0]?.id === tour.steps[0].id,
    JSON.stringify(server).slice(0, 400)
  );
  const banners = readdirSync(join(dir, "banners"));
  const newBanner = banners.find((name) => name.endsWith("-banner-from-git.json"));
  check(
    "created file renamed to <id>-<slug>.json with its id",
    Boolean(newBanner) && !banners.includes("new-banner.json"),
    banners.join(", ")
  );
  if (newBanner) {
    const bannerId = JSON.parse(readFileSync(join(dir, "banners", newBanner), "utf8")).id;
    created.pushedBanner = bannerId;
  }
  const again = cli(["push", dir, "--type", "tours,banners", "--json"]);
  check(
    "second push is a no-op (idempotent)",
    again.code === 0 &&
      again.json?.applied?.length === 0 &&
      again.json?.plan?.every((entry) => entry.action === "unchanged"),
    show(again)
  );

  writeFileSync(
    join(dir, "tours", "999999-ghost.json"),
    JSON.stringify({ id: 999999, name: "Ghost" })
  );
  const missing = cli(["push", dir, "--type", "tours", "--json"]);
  check(
    "push reports items missing on the server (exit 1)",
    missing.code === 1 && missing.json?.errors?.some((e) => e.code === "not_found"),
    show(missing)
  );
  rmSync(join(dir, "tours", "999999-ghost.json"));
  const pruneDir = join(work, "prune");
  cli(["pull", pruneDir, "--type", "tours"]);
  writeFileSync(
    join(pruneDir, "tours", "999998-gone.json"),
    JSON.stringify({ id: 999998, name: "Gone" })
  );
  const pruned = cli(["pull", pruneDir, "--type", "tours", "--prune", "--json"]);
  check(
    "pull --prune removes files of deleted items",
    pruned.code === 0 && pruned.json?.pruned?.length === 1,
    show(pruned)
  );
}

// --- MCP parity, bridge, raw API --------------------------------------------------------------
{
  const tools = cli(["tools", "list", "--json"]);
  check(
    "tools list",
    tools.code === 0 && tools.json?.some((tool) => tool.name === "validate_content"),
    show(tools)
  );
  const schema = cli(["tools", "list", "--schema", "create_tour", "--json"]);
  check(
    "tools list --schema",
    schema.code === 0 && schema.json?.inputSchema?.properties?.name,
    show(schema)
  );
  const call = cli([
    "tools",
    "call",
    "validate_content",
    "--arg",
    "type=tour",
    "--arg",
    `id=${created.tours}`,
    "--json",
  ]);
  check(
    "tools call validate_content",
    call.code === 0 && call.json && typeof call.json === "object",
    show(call)
  );
  const bad = cli(["tools", "call", "get_content", "--arg", "type=tour", "--arg", "id=999999999"]);
  check("tools call: a tool error exits 1", bad.code === 1, show(bad));

  const bridge = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    child.stdin.write("not json\n");
    child.stdin.end();
  });
  const lines = bridge.out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  check(
    "mcp bridge: initialize",
    lines.find((m) => m.id === 1)?.result?.serverInfo?.name,
    bridge.out + bridge.err
  );
  check(
    "mcp bridge: tools/list",
    lines.find((m) => m.id === 2)?.result?.tools?.length > 10,
    bridge.out.slice(0, 300)
  );
  check(
    "mcp bridge: notifications get no reply, bad JSON gets a parse error",
    lines.length === 3 && lines[2].error?.code === -32700,
    bridge.out
  );
  check(
    "mcp bridge: logs only on stderr",
    bridge.err.includes("[cueston mcp]") && bridge.code === 0,
    bridge.err
  );

  const raw = cli(["api", "GET", "/api/tours"]);
  check("api GET /api/tours", raw.code === 0 && Array.isArray(raw.json?.tours), show(raw));
  const short = cli(["api", "get", "workspaces/current"]);
  check(
    "api adds /api and accepts lowercase methods",
    short.code === 0 && short.json?.workspace?.id,
    show(short)
  );
  const query = cli(["api", "GET", "/api/analytics/overview", "-q", "days=7"]);
  check("api -q query params", query.code === 0 && query.json?.totals, show(query));
  const notFound = cli(["api", "GET", "/api/tours/999999999"]);
  check(
    "api prints error bodies and exits 1",
    notFound.code === 1 && notFound.json?.code === "not_found",
    show(notFound)
  );
}

// --- clean up ------------------------------------------------------------------------------
for (const [type, id] of Object.entries(created)) {
  const plural = type === "pushedBanner" ? "banners" : type;
  cli([plural, "delete", String(id), "--yes"]);
}
rmSync(home, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
