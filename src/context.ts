import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { Client } from "./client.js";
import { readConfig, resolveAuth, type ResolvedAuth, type StoredConfig } from "./config.js";
import { UsageError } from "./errors.js";
import { printer, type Printer } from "./output.js";

export interface GlobalOptions {
  json?: boolean;
  key?: string;
  apiUrl?: string;
}

export interface Ctx {
  options: GlobalOptions & Record<string, any>;
  auth: ResolvedAuth;
  config: StoredConfig;
  out: Printer;
  client: Client;
}

/** Resolve the key, API URL and output mode for a command. */
export function contextOf(command: Command): Ctx {
  const options = command.optsWithGlobals() as GlobalOptions & Record<string, any>;
  const config = readConfig();
  const auth = resolveAuth({ key: options.key, apiUrl: options.apiUrl }, process.env, config);
  const out = printer(Boolean(options.json));
  const client = new Client(auth.apiUrl, auth.key, (message) => out.info(message));
  return { options, auth, config, out, client };
}

/** Ask y/N on a terminal; without one, require --yes. */
export async function confirm(question: string, yes: boolean | undefined): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new UsageError(
      "This needs confirmation.",
      "Pass --yes to confirm when not running in a terminal."
    );
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export const plural = (count: number, word: string, many = `${word}s`) =>
  `${count} ${count === 1 ? word : many}`;
