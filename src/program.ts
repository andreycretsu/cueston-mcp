/**
 * The `cueston` command tree. Every command calls the same API as the dashboard with a secret
 * key, so permissions, plan limits, approvals and the audit log apply exactly as there.
 */
import { Command, CommanderError } from "commander";
import { registerAuth } from "./commands/auth.js";
import { registerInit } from "./commands/init.js";
import { registerContent } from "./commands/content.js";
import { registerApi, registerMcpBridge, registerTools } from "./commands/agents.js";
import { registerSync } from "./commands/sync.js";
import { registerGrowth } from "./commands/growth.js";
import {
  registerAnalytics,
  registerDesignSystem,
  registerPreview,
  registerReviews,
  registerSegments,
  registerTranslations,
  registerWebhooks,
} from "./commands/workspace.js";
import { ApiError, CliError } from "./errors.js";
import { errColor, json } from "./output.js";
import { VERSION } from "./version.js";

export function buildProgram(): Command {
  const program = new Command("cueston")
    .description(
      "Build, check, preview and publish Cueston in-app guidance from your terminal or CI."
    )
    .version(VERSION, "-V, --version", "print the version")
    .option("--json", "print machine-readable JSON")
    .option("--key <key>", "secret API key to use (default: CUESTON_API_KEY, then `cueston login`)")
    .option(
      "--api-url <url>",
      "Cueston URL (default: CUESTON_API_URL, then https://app.cueston.com)"
    )
    .showHelpAfterError("(add --help for usage)")
    .configureHelp({ sortSubcommands: false, showGlobalOptions: true })
    .addHelpText(
      "after",
      `
Get started:
  cueston init                       set Cueston up in this project (signs you in first)
  cueston login                      sign in through your browser
  cueston tours list                 see your tours and their status
  cueston pull && cueston push       keep guidance in git (content as code)

Docs: https://cueston.com/docs/cli`
    );

  registerInit(program);
  registerAuth(program);
  registerContent(program);
  registerSegments(program);
  registerReviews(program);
  registerAnalytics(program);
  registerTranslations(program);
  registerPreview(program);
  registerWebhooks(program);
  registerDesignSystem(program);
  registerGrowth(program);
  registerSync(program);
  registerTools(program);
  registerMcpBridge(program);
  registerApi(program);

  // Commander's own errors (unknown command, missing argument) become usage errors: exit 2.
  const exitOverride = (command: Command) => {
    command.exitOverride();
    for (const sub of command.commands) exitOverride(sub);
  };
  exitOverride(program);
  return program;
}

export function reportError(error: unknown, jsonMode: boolean): number {
  if (error instanceof CommanderError) {
    // Help and --version exit 0; everything else commander reports is a usage error.
    return error.exitCode === 0 ||
      error.code === "commander.helpDisplayed" ||
      error.code === "commander.version"
      ? 0
      : 2;
  }
  if (error instanceof CliError) {
    if (jsonMode) {
      process.stdout.write(
        `${json({
          error: {
            message: error.message,
            code: error instanceof ApiError ? error.code : error.exitCode === 2 ? "usage" : "error",
            ...(error instanceof ApiError ? { status: error.status, details: error.details } : {}),
            ...(error.hint ? { hint: error.hint } : {}),
          },
        })}\n`
      );
    } else {
      process.stderr.write(`${errColor.red("Error:")} ${error.message}\n`);
      if (error instanceof ApiError)
        for (const detail of error.details.slice(0, 20)) process.stderr.write(`  - ${detail}\n`);
      if (error.hint) process.stderr.write(`${errColor.dim(error.hint)}\n`);
    }
    return error.exitCode;
  }
  process.stderr.write(
    `${errColor.red("Unexpected error:")} ${(error as Error)?.stack ?? String(error)}\n`
  );
  return 1;
}
