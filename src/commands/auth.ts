import { spawn } from "node:child_process";
import { hostname } from "node:os";
import type { Command } from "commander";
import { Client } from "../client.js";
import { clearSignIn, configPath, DEFAULT_API_URL, maskKey, writeConfig } from "../config.js";
import { contextOf, type Ctx } from "../context.js";
import { ApiError, CliError } from "../errors.js";
import { readStdin } from "../input.js";
import { color, errColor } from "../output.js";

const PLATFORM: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** "ana-mbp (macOS)": shown on the approval page so people recognize their own terminal. */
export const deviceLabel = () =>
  `${hostname().replace(/\.local$/, "")} (${PLATFORM[process.platform] ?? process.platform})`;

export function openBrowser(url: string): boolean {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Issued {
  key: string;
  keyId: number;
  keyPrefix: string;
  workspace: { id: number; name: string };
  user: { email: string };
}

/** Device-style sign-in: show a code, the person approves it in the browser, collect the key. */
export async function browserLogin(ctx: Ctx, browser: boolean): Promise<Issued> {
  const anonymous = new Client(ctx.auth.apiUrl, null, (message) => ctx.out.info(message));
  const started = await anonymous.request<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    interval: number;
    expiresIn: number;
  }>("POST", "/api/cli/login", { anonymous: true, body: { clientName: deviceLabel() } });

  // The code is for the person even in --json mode, so it always goes to stderr.
  const write = (line = "") => process.stderr.write(`${line}\n`);
  write();
  write(`  Your code: ${errColor.bold(started.userCode)}`);
  write();
  write(`  Approve this sign-in at ${errColor.cyan(started.verificationUriComplete)}`);
  write(
    `  and check the code matches. It expires in ${Math.round(started.expiresIn / 60)} minutes.`
  );
  write();
  const interactive = Boolean(process.stderr.isTTY) && !process.env.CI;
  if (browser && interactive && openBrowser(started.verificationUriComplete))
    write("  Opened your browser.");
  write(errColor.dim("  Waiting for approval… (Ctrl+C to cancel)"));

  let interval = Math.max(1, started.interval) * 1000;
  const deadline = Date.now() + started.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    try {
      return await anonymous.request<Issued>("POST", "/api/cli/login/token", {
        anonymous: true,
        body: { deviceCode: started.deviceCode },
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === "authorization_pending") continue;
      if (error.code === "slow_down") {
        interval += 5000;
        continue;
      }
      if (error.code === "access_denied")
        throw new CliError("The sign-in was denied in the browser.");
      if (error.code === "expired_token")
        throw new CliError("The code expired.", "Run `cueston login` again.");
      throw error;
    }
  }
  throw new CliError("The code expired before it was approved.", "Run `cueston login` again.");
}

/** A key given directly: check it and find its id (for `logout --revoke`). */
async function keyLogin(ctx: Ctx, key: string): Promise<Issued> {
  if (!key.startsWith("sk_"))
    throw new CliError(
      "That isn't a secret key.",
      key.startsWith("pk_")
        ? "pk_ keys are publishable. Create a secret key (sk_) in Settings → API keys."
        : "Secret keys start with sk_."
    );
  const client = new Client(ctx.auth.apiUrl, key, (message) => ctx.out.info(message));
  const me = await client.get("/api/auth/me");
  let keyId = 0;
  try {
    const { keys } = await client.get<{ keys: Array<{ id: number; keyPrefix: string }> }>(
      "/api/keys",
      { mine: true }
    );
    keyId = keys.find((candidate) => candidate.keyPrefix === key.slice(0, 12))?.id ?? 0;
  } catch {
    // Not fatal: logout --revoke looks it up again.
  }
  return {
    key,
    keyId,
    keyPrefix: key.slice(0, 12),
    workspace: { id: me.workspace.id, name: me.workspace.name },
    user: { email: me.user.email },
  };
}

/** Save a sign-in to the config file (what `cueston login` and `cueston init` both do). */
export function saveSignIn(ctx: Ctx, issued: Issued): string {
  return writeConfig({
    ...(ctx.auth.apiUrl !== DEFAULT_API_URL ? { apiUrl: ctx.auth.apiUrl } : {}),
    key: issued.key,
    ...(issued.keyId ? { keyId: issued.keyId } : {}),
    keyPrefix: issued.keyPrefix,
    workspace: issued.workspace,
    user: issued.user,
  });
}

export function registerAuth(program: Command) {
  program
    .command("login")
    .description("Sign in: approve this terminal in your browser, or save a secret key")
    .option("--no-browser", "print the link instead of opening the browser")
    .option("--with-key", "read a secret key from stdin instead of signing in through the browser")
    .addHelpText(
      "after",
      `
Examples:
  cueston login                         # opens the browser; approve the code shown
  cueston login --no-browser            # on a remote machine: open the link yourself
  cueston login --key sk_…              # save a key from Settings → API keys
  echo "$KEY" | cueston login --with-key

In CI, skip login and set CUESTON_API_KEY instead.`
    )
    .action(async (_options, command: Command) => {
      const ctx = contextOf(command);
      const { browser, withKey } = command.opts();
      let issued: Issued;
      if (withKey) issued = await keyLogin(ctx, (await readStdin()).trim());
      else if (ctx.auth.keySource === "flag") issued = await keyLogin(ctx, ctx.auth.key!);
      else issued = await browserLogin(ctx, browser !== false);

      const path = saveSignIn(ctx, issued);
      if (process.env.CUESTON_API_KEY)
        ctx.out.warn(
          "CUESTON_API_KEY is set in your environment; it takes precedence over the saved key."
        );
      ctx.out.result(
        {
          user: issued.user,
          workspace: issued.workspace,
          apiUrl: ctx.auth.apiUrl,
          key: maskKey(issued.key),
          config: path,
        },
        () =>
          `${color.green("✓")} Signed in as ${color.bold(issued.user.email)} to ${color.bold(issued.workspace.name)}.\n` +
          color.dim(
            `  Key ${maskKey(issued.key)} saved to ${path}. Revoke it any time in Settings → API keys.`
          )
      );
    });

  program
    .command("logout")
    .description("Forget the saved key on this computer (--revoke also revokes it)")
    .option("--revoke", "revoke the key in Cueston too")
    .action(async (_options, command: Command) => {
      const ctx = contextOf(command);
      const { revoke } = command.opts();
      const stored = ctx.config.key;
      if (!stored) {
        if (ctx.auth.keySource === "env")
          ctx.out.info("CUESTON_API_KEY is set in your environment; unset it to sign out.");
        ctx.out.result(
          { signedOut: false, revoked: false },
          () => "You're not signed in on this computer."
        );
        return;
      }
      let revoked = false;
      if (revoke) {
        const client = new Client(ctx.auth.apiUrl, stored);
        let keyId = ctx.config.keyId;
        if (!keyId) {
          const { keys } = await client.get<{ keys: Array<{ id: number; keyPrefix: string }> }>(
            "/api/keys",
            { mine: true }
          );
          keyId = keys.find((candidate) => candidate.keyPrefix === stored.slice(0, 12))?.id;
        }
        if (!keyId)
          throw new CliError(
            "Couldn't find this key to revoke it.",
            "Revoke it in Settings → API keys."
          );
        try {
          await client.delete(`/api/keys/${keyId}`);
          revoked = true;
        } catch (error) {
          // Already revoked (401/404): signing out locally is all that's left.
          if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 404))
            throw error;
        }
      }
      clearSignIn();
      ctx.out.result({ signedOut: true, revoked }, () =>
        revoked
          ? `${color.green("✓")} Signed out and revoked the key.`
          : `${color.green("✓")} Signed out on this computer.\n` +
            color.dim(
              "  The key still works until it's revoked: `cueston logout --revoke` next time, or Settings → API keys."
            )
      );
    });

  program
    .command("whoami")
    .description("Show who you're signed in as, the workspace, your role and the API URL")
    .action(async (_options, command: Command) => {
      const ctx = contextOf(command);
      const me = await ctx.client.get("/api/auth/me");
      const source =
        ctx.auth.keySource === "env"
          ? "CUESTON_API_KEY"
          : ctx.auth.keySource === "flag"
            ? "--key"
            : configPath();
      const data = {
        user: { email: me.user.email, name: me.user.name ?? null },
        workspace: {
          id: me.workspace.id,
          name: me.workspace.name,
          role: me.workspace.customRole?.name ?? me.workspace.role,
          plan: me.workspace.plan ?? null,
          permissions: me.workspace.permissions ?? [],
        },
        apiUrl: ctx.auth.apiUrl,
        key: maskKey(ctx.auth.key),
        keySource: ctx.auth.keySource,
      };
      ctx.out.result(data, () =>
        [
          `Signed in as ${color.bold(data.user.email)}`,
          `${color.dim("Workspace  ")} ${data.workspace.name} (${data.workspace.id}) · ${data.workspace.role}${data.workspace.plan ? ` · ${data.workspace.plan} plan` : ""}`,
          `${color.dim("Can        ")} ${data.workspace.permissions.join(", ") || "—"}`,
          `${color.dim("API        ")} ${data.apiUrl}`,
          `${color.dim("Key        ")} ${data.key} (from ${source})`,
        ].join("\n")
      );
    });
}
